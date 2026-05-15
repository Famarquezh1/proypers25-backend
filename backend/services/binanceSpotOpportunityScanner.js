const {
    seedSpotOpportunityValidations,
    processSpotOpportunityValidations
} = require('./binanceSpotOpportunityValidation');

const SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const SPOT_TICKER_24H_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const SPOT_KLINES_URL = 'https://api.binance.com/api/v3/klines';

const SCANNER_VERSION = 'binance_spot_opportunity_scanner_v1';
const SCAN_COLLECTION = 'spot_opportunity_scans';
const CANDIDATE_COLLECTION = 'spot_opportunity_candidates';
const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.BINANCE_SPOT_SCANNER_TIMEOUT_MS || 12000));
const KLINE_LIMIT = Math.max(30, Number(process.env.BINANCE_SPOT_SCANNER_KLINE_LIMIT || 35));
const MAX_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.BINANCE_SPOT_SCANNER_CONCURRENCY || 6)));
const MIN_QUOTE_VOLUME_USDT = Math.max(25000, Number(process.env.BINANCE_SPOT_SCANNER_MIN_QUOTE_VOLUME || 100000));
const MAX_BATCH_WRITES = 400;

const STABLE_BASE_ASSETS = new Set([
    'USDT',
    'USDC',
    'FDUSD',
    'BUSD',
    'TUSD',
    'USDP',
    'DAI',
    'PAX',
    'EUR',
    'TRY',
    'BRL',
    'UAH',
    'RUB',
    'GBP',
    'AUD'
]);
const LEVERAGED_SUFFIXES = ['UP', 'DOWN', 'BULL', 'BEAR'];

function round(value, decimals = 4) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Number(numeric.toFixed(decimals));
}

function clamp(value, min = 0, max = 100) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.min(max, Math.max(min, numeric));
}

function average(values = []) {
    const finite = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!finite.length) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function standardDeviation(values = []) {
    const mean = average(values);
    if (!Number.isFinite(mean)) return null;
    const finite = values.map((value) => Number(value)).filter(Number.isFinite);
    if (finite.length < 2) return 0;
    const variance = finite.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / finite.length;
    return Math.sqrt(variance);
}

function sortByScore(items = [], scoreKey) {
    return [...items].sort((left, right) => {
        const scoreDiff = Number(right?.[scoreKey] || 0) - Number(left?.[scoreKey] || 0);
        if (Math.abs(scoreDiff) > 0.000001) return scoreDiff;
        return Number(right?.quoteVolume24h || 0) - Number(left?.quoteVolume24h || 0);
    });
}

function chunk(items = [], size = MAX_BATCH_WRITES) {
    const output = [];
    for (let index = 0; index < items.length; index += size) {
        output.push(items.slice(index, index + size));
    }
    return output;
}

function isExcludedBaseAsset(baseAsset) {
    const normalized = String(baseAsset || '').toUpperCase();
    if (!normalized) return true;
    if (STABLE_BASE_ASSETS.has(normalized)) return true;
    return LEVERAGED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function hasSpotPermission(symbolInfo = {}) {
    if (symbolInfo?.isSpotTradingAllowed === false) {
        return false;
    }

    const permissions = Array.isArray(symbolInfo?.permissions) ? symbolInfo.permissions : null;
    if (permissions?.includes('SPOT')) {
        return true;
    }
    if (permissions && permissions.length > 0) {
        return false;
    }

    const permissionSets = Array.isArray(symbolInfo?.permissionSets) ? symbolInfo.permissionSets : [];
    if (permissionSets.length === 0) {
        return symbolInfo?.isSpotTradingAllowed !== false;
    }

    return permissionSets.some((permissionSet) => Array.isArray(permissionSet) && permissionSet.includes('SPOT'));
}

function summarizeCandidate(candidate = {}) {
    return {
        symbol: candidate.symbol,
        price: candidate.price,
        quoteVolume24h: candidate.quoteVolume24h,
        opportunityScore: candidate.opportunityScore,
        category: candidate.category,
        recommendation: candidate.recommendation,
        reasons: candidate.reasons || []
    };
}

async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`spot_scanner_status_${response.status}`);
    }
    return response.json();
}

async function fetchSpotExchangeInfo() {
    return fetchJson(SPOT_EXCHANGE_INFO_URL);
}

async function fetchSpotTicker24hr() {
    return fetchJson(SPOT_TICKER_24H_URL);
}

async function fetchSpotDailyKlines(symbol) {
    const url = `${SPOT_KLINES_URL}?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${KLINE_LIMIT}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closeTime: Number(row[6]),
        quoteVolume: Number(row[7])
    })).filter((row) => Number.isFinite(row.close) && Number.isFinite(row.high) && Number.isFinite(row.low));
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const current = cursor;
            cursor += 1;
            try {
                results[current] = await mapper(items[current], current);
            } catch (error) {
                results[current] = {
                    item: items[current],
                    error
                };
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length || 1) }, () => worker());
    await Promise.all(workers);
    return results;
}

function resolvePriceChangeFromHistory(klines = [], currentPrice, days) {
    if (!Array.isArray(klines) || klines.length <= days) return null;
    const reference = klines[klines.length - 1 - days];
    const basePrice = Number(reference?.close);
    if (!Number.isFinite(basePrice) || basePrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
    return ((currentPrice - basePrice) / basePrice) * 100;
}

function resolveVolumeChangeScore(quoteVolume24h, klines = []) {
    const historical = klines.slice(-8, -1).map((row) => Number(row.quoteVolume)).filter(Number.isFinite);
    const averageHistoricalVolume = average(historical);
    const ratio = averageHistoricalVolume > 0 ? quoteVolume24h / averageHistoricalVolume : 1;
    return {
        recentAverageQuoteVolume: averageHistoricalVolume,
        volumeRatio: ratio,
        score: clamp((ratio - 1) * 22, 0, 100)
    };
}

function resolveVolatilityMetrics(klines = []) {
    const recent = klines.slice(-15);
    const returns = [];
    const intradayRanges = [];

    for (let index = 1; index < recent.length; index += 1) {
        const previousClose = Number(recent[index - 1]?.close);
        const currentClose = Number(recent[index]?.close);
        const high = Number(recent[index]?.high);
        const low = Number(recent[index]?.low);
        if (Number.isFinite(previousClose) && previousClose > 0 && Number.isFinite(currentClose)) {
            returns.push(((currentClose - previousClose) / previousClose) * 100);
        }
        if (Number.isFinite(low) && low > 0 && Number.isFinite(high)) {
            intradayRanges.push(((high - low) / low) * 100);
        }
    }

    const dailyVolatilityPct = standardDeviation(returns) || 0;
    const meanRangePct = average(intradayRanges) || 0;
    const sweetSpotDistance = Math.abs(dailyVolatilityPct - 7);
    const volatilityScore = clamp(100 - (sweetSpotDistance * 8) - Math.max(0, meanRangePct - 18) * 2, 0, 100);

    return {
        dailyVolatilityPct,
        meanRangePct,
        score: volatilityScore
    };
}

function resolveBreakoutScore(currentPrice, klines = [], volumeRatio = 1) {
    const lookback = klines.slice(-21, -1);
    const highs = lookback.map((row) => Number(row.high)).filter(Number.isFinite);
    const priorHigh = highs.length ? Math.max(...highs) : null;
    if (!Number.isFinite(priorHigh) || priorHigh <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
        return {
            priorHigh: null,
            breakoutPct: null,
            score: 0
        };
    }
    const breakoutPct = ((currentPrice - priorHigh) / priorHigh) * 100;
    const score = breakoutPct >= 0 ?
        clamp(60 + (breakoutPct * 15) + Math.max(0, volumeRatio - 1) * 10, 0, 100) :
        clamp(35 + (breakoutPct * 8) + Math.max(0, volumeRatio - 1) * 5, 0, 55);

    return {
        priorHigh,
        breakoutPct,
        score
    };
}

function resolveAccumulationScore(klines = [], priceChange7d, volumeRatio) {
    const lookback = klines.slice(-15, -1);
    const highs = lookback.map((row) => Number(row.high)).filter(Number.isFinite);
    const lows = lookback.map((row) => Number(row.low)).filter(Number.isFinite);
    if (!highs.length || !lows.length) return { rangePct: null, score: 0 };

    const periodHigh = Math.max(...highs);
    const periodLow = Math.min(...lows);
    const rangePct = periodLow > 0 ? ((periodHigh - periodLow) / periodLow) * 100 : null;
    const compressionScore = Number.isFinite(rangePct) ? clamp(100 - (rangePct * 3), 0, 100) : 0;
    const momentumAssist = clamp((Number(priceChange7d || 0) + 5) * 4, 0, 100);
    const volumeAssist = clamp((Number(volumeRatio || 1) - 0.8) * 35, 0, 100);

    return {
        rangePct,
        score: clamp((compressionScore * 0.45) + (momentumAssist * 0.3) + (volumeAssist * 0.25), 0, 100)
    };
}

function resolveImpulseScore(priceChange24h, priceChange7d, volumeRatio) {
    const intradayMomentum = clamp(Number(priceChange24h || 0) * 5, 0, 100);
    const weeklyMomentum = clamp(Number(priceChange7d || 0) * 2.8, 0, 100);
    const volumeAssist = clamp((Number(volumeRatio || 1) - 1) * 25, 0, 100);
    return clamp((intradayMomentum * 0.45) + (weeklyMomentum * 0.35) + (volumeAssist * 0.2), 0, 100);
}

function resolveLiquidityScore(quoteVolume24h) {
    const logVolume = Math.log10(Math.max(1, Number(quoteVolume24h || 0)));
    return clamp((logVolume - 4.8) * 30, 0, 100);
}

function resolveRiskScore({ price, quoteVolume24h, priceChange24h, listingAgeDays, dailyVolatilityPct, meanRangePct }) {
    let risk = 0;
    if (quoteVolume24h < MIN_QUOTE_VOLUME_USDT * 2) risk += 18;
    if (listingAgeDays < 10) risk += 28;
    else if (listingAgeDays < 20) risk += 15;
    if (price < 0.01) risk += 14;
    else if (price < 0.05) risk += 8;
    if (dailyVolatilityPct > 18) risk += 24;
    else if (dailyVolatilityPct > 12) risk += 14;
    if (meanRangePct > 25) risk += 16;
    if (Math.abs(priceChange24h) > 35) risk += 18;
    else if (Math.abs(priceChange24h) > 20) risk += 10;
    return clamp(risk, 0, 100);
}

function resolveCheapAssetScore(price, liquidityScore) {
    let cheapness = 15;
    if (price <= 0.01) cheapness = 100;
    else if (price <= 0.1) cheapness = 88;
    else if (price <= 0.5) cheapness = 74;
    else if (price <= 1) cheapness = 60;
    else if (price <= 5) cheapness = 38;
    return clamp((cheapness * 0.6) + (Number(liquidityScore || 0) * 0.4), 0, 100);
}

function buildReasons({ price, quoteVolume24h, volumeRatio, breakoutPct, priceChange24h, priceChange7d, volatilityScore, accumulationScore, impulseScore, liquidityScore }) {
    const reasons = [];
    if (volumeRatio >= 2.5 && quoteVolume24h >= MIN_QUOTE_VOLUME_USDT * 2) {
        reasons.push('volume_24h_above_recent_average');
    }
    if (Number.isFinite(breakoutPct) && breakoutPct >= 0.5) {
        reasons.push('recent_high_breakout');
    }
    if (priceChange24h >= 6 && volumeRatio >= 1.8) {
        reasons.push('strong_price_move_with_growing_volume');
    }
    if (price <= 1 && liquidityScore >= 45 && volumeRatio >= 1.4) {
        reasons.push('low_price_with_real_liquidity');
    }
    if (accumulationScore >= 65 && impulseScore >= 60) {
        reasons.push('accumulation_then_impulse');
    }
    if (Number(priceChange7d || 0) >= 10 && volumeRatio >= 1.3) {
        reasons.push('positive_7d_momentum_with_volume_growth');
    }
    if (priceChange24h >= 4 && volatilityScore >= 45) {
        reasons.push('strong_24h_move_without_destructive_volatility');
    }
    return reasons;
}

function buildWarnings({ price, quoteVolume24h, listingAgeDays, priceChange24h, riskScore, dailyVolatilityPct }) {
    const warnings = [];
    if (listingAgeDays < 15) warnings.push('new_listing_limited_history');
    if (quoteVolume24h < MIN_QUOTE_VOLUME_USDT * 2) warnings.push('liquidity_near_minimum_threshold');
    if (dailyVolatilityPct > 18) warnings.push('extreme_volatility');
    if (Math.abs(priceChange24h) > 30) warnings.push('parabolic_24h_move');
    if (price < 0.01) warnings.push('ultra_low_price_asset');
    if (riskScore >= 75) warnings.push('high_risk_profile');
    return warnings;
}

function resolveCategory({ riskScore, breakoutScore, accumulationScore, volumeChangeScore, impulseScore, price, reasons }) {
    if (riskScore >= 75) return 'HIGH_RISK';
    if (breakoutScore >= 72 && reasons.includes('recent_high_breakout')) return 'BREAKOUT';
    if (accumulationScore >= 70 && reasons.includes('accumulation_then_impulse')) return 'ACCUMULATION';
    if (volumeChangeScore >= 75 && reasons.includes('volume_24h_above_recent_average')) return 'VOLUME_SPIKE';
    if (price <= 1 && reasons.includes('low_price_with_real_liquidity')) return 'NEW_OR_LOW_PRICE';
    if (impulseScore >= 68 || reasons.includes('positive_7d_momentum_with_volume_growth')) return 'MOMENTUM';
    return 'WATCHLIST';
}

function resolveRecommendation(opportunityScore, riskScore, reasons) {
    if (riskScore >= 75) return 'TOO_RISKY';
    if (opportunityScore >= 78 && reasons.length >= 2) return 'STRONG_WATCH';
    if (opportunityScore >= 55 && reasons.length >= 1) return 'WATCH';
    return 'IGNORE';
}

function analyzeSymbol(entry, klines = []) {
    const ticker = entry?.ticker || {};
    const price = Number(ticker.lastPrice);
    const quoteVolume24h = Number(ticker.quoteVolume);
    const priceChange24h = Number(ticker.priceChangePercent);
    const listingAgeDays = Array.isArray(klines) ? klines.length : 0;
    const priceChange7d = resolvePriceChangeFromHistory(klines, price, 7);
    const priceChange30d = resolvePriceChangeFromHistory(klines, price, 30);
    const volumeMetrics = resolveVolumeChangeScore(quoteVolume24h, klines);
    const volatilityMetrics = resolveVolatilityMetrics(klines);
    const breakoutMetrics = resolveBreakoutScore(price, klines, volumeMetrics.volumeRatio);
    const accumulationMetrics = resolveAccumulationScore(klines, priceChange7d, volumeMetrics.volumeRatio);
    const liquidityScore = resolveLiquidityScore(quoteVolume24h);
    const impulseScore = resolveImpulseScore(priceChange24h, priceChange7d, volumeMetrics.volumeRatio);
    const riskScore = resolveRiskScore({
        price,
        quoteVolume24h,
        priceChange24h,
        listingAgeDays,
        dailyVolatilityPct: volatilityMetrics.dailyVolatilityPct,
        meanRangePct: volatilityMetrics.meanRangePct
    });
    const cheapAssetScore = resolveCheapAssetScore(price, liquidityScore);
    const weeklyMomentumScore = clamp(Number(priceChange7d || 0) * 3.2, 0, 100);
    const reasons = buildReasons({
        price,
        quoteVolume24h,
        volumeRatio: volumeMetrics.volumeRatio,
        breakoutPct: breakoutMetrics.breakoutPct,
        priceChange24h,
        priceChange7d,
        volatilityScore: volatilityMetrics.score,
        accumulationScore: accumulationMetrics.score,
        impulseScore,
        liquidityScore
    });
    const warnings = buildWarnings({
        price,
        quoteVolume24h,
        listingAgeDays,
        priceChange24h,
        riskScore,
        dailyVolatilityPct: volatilityMetrics.dailyVolatilityPct
    });

    let opportunityScore = (
        (volumeMetrics.score * 0.18) +
        (breakoutMetrics.score * 0.18) +
        (accumulationMetrics.score * 0.16) +
        (impulseScore * 0.18) +
        (liquidityScore * 0.14) +
        (volatilityMetrics.score * 0.06) +
        (weeklyMomentumScore * 0.1) +
        (cheapAssetScore * 0.1)
    ) - (riskScore * 0.22) + (reasons.length * 4);

    if (!reasons.length) {
        opportunityScore = Math.min(opportunityScore, 44);
    }
    if (riskScore >= 75) {
        opportunityScore -= 12;
    }

    opportunityScore = clamp(opportunityScore, 0, 100);

    const category = resolveCategory({
        riskScore,
        breakoutScore: breakoutMetrics.score,
        accumulationScore: accumulationMetrics.score,
        volumeChangeScore: volumeMetrics.score,
        impulseScore,
        price,
        reasons
    });
    const recommendation = resolveRecommendation(opportunityScore, riskScore, reasons);

    return {
        symbol: entry.symbol,
        price: round(price, 8),
        quoteVolume24h: round(quoteVolume24h, 2),
        volumeChangeScore: round(volumeMetrics.score, 2),
        priceChange24h: round(priceChange24h, 2),
        priceChange7d: round(priceChange7d, 2),
        priceChange30d: round(priceChange30d, 2),
        volatilityScore: round(volatilityMetrics.score, 2),
        breakoutScore: round(breakoutMetrics.score, 2),
        accumulationScore: round(accumulationMetrics.score, 2),
        impulseScore: round(impulseScore, 2),
        liquidityScore: round(liquidityScore, 2),
        riskScore: round(riskScore, 2),
        opportunityScore: round(opportunityScore, 2),
        category,
        reasons,
        warnings,
        recommendation,
        paper_only: true
    };
}

function buildMarketSummary(candidates = [], totalSymbolsScanned) {
    const strongWatch = candidates.filter((candidate) => candidate.recommendation === 'STRONG_WATCH');
    const watch = candidates.filter((candidate) => candidate.recommendation === 'WATCH');
    const highRisk = candidates.filter((candidate) => candidate.recommendation === 'TOO_RISKY');
    const categoryCounts = candidates.reduce((acc, candidate) => {
        const key = candidate.category || 'WATCHLIST';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const topCategory = Object.entries(categoryCounts).sort((left, right) => right[1] - left[1])[0] ?.[ 0] || 'WATCHLIST';
    const avgOpportunityScore = average(candidates.map((candidate) => candidate.opportunityScore)) || 0;
    const avgPriceChange24h = average(candidates.map((candidate) => candidate.priceChange24h)) || 0;
    const avgPriceChange7d = average(candidates.map((candidate) => candidate.priceChange7d)) || 0;

    let conclusion = 'Spot market is quiet; keep candidates on watch only.';
    if (strongWatch.length >= 5) {
        conclusion = 'Spot market shows multiple strong-watch candidates with swing-style momentum.';
    } else if (watch.length >= 12 && topCategory === 'BREAKOUT') {
        conclusion = 'Spot market is breakout-led; several USDT pairs are pressing recent highs.';
    } else if (watch.length >= 10 && topCategory === 'ACCUMULATION') {
        conclusion = 'Spot market is showing accumulation setups that could transition into swing impulses.';
    } else if (highRisk.length > strongWatch.length + watch.length) {
        conclusion = 'Spot market is active but too speculative; monitor carefully and avoid chasing.';
    }

    return {
        total_symbols_scanned: totalSymbolsScanned,
        candidates_count: candidates.length,
        strong_watch_count: strongWatch.length,
        watch_count: watch.length,
        ignore_count: candidates.filter((candidate) => candidate.recommendation === 'IGNORE').length,
        high_risk_count: highRisk.length,
        top_category: topCategory,
        avg_opportunity_score: round(avgOpportunityScore, 2),
        avg_price_change_24h: round(avgPriceChange24h, 2),
        avg_price_change_7d: round(avgPriceChange7d, 2),
        conclusion
    };
}

function buildScanPayload(scanId, candidates = [], totalSymbolsScanned) {
    const topOpportunities = sortByScore(
        candidates.filter((candidate) => candidate.recommendation === 'STRONG_WATCH' || candidate.recommendation === 'WATCH'),
        'opportunityScore'
    ).slice(0, 20).map(summarizeCandidate);
    const marketSummary = buildMarketSummary(candidates, totalSymbolsScanned);

    return {
        id: scanId,
        created_at: new Date().toISOString(),
        scanner_version: SCANNER_VERSION,
        paper_only: true,
        total_symbols_scanned: totalSymbolsScanned,
        top_opportunities: topOpportunities,
        rejected_count: candidates.filter((candidate) => candidate.recommendation === 'IGNORE').length,
        high_risk_count: marketSummary.high_risk_count,
        market_summary: marketSummary
    };
}

async function saveScan(db, scanDoc, candidates) {
    await db.collection(SCAN_COLLECTION).doc(scanDoc.id).set(scanDoc);

    const documents = candidates.map((candidate) => ({
        id: `${scanDoc.id}_${candidate.symbol}`,
        payload: {
            scan_id: scanDoc.id,
            created_at: scanDoc.created_at,
            scanner_version: SCANNER_VERSION,
            symbol: candidate.symbol,
            price: candidate.price,
            quoteVolume24h: candidate.quoteVolume24h,
            volumeChangeScore: candidate.volumeChangeScore,
            priceChange24h: candidate.priceChange24h,
            priceChange7d: candidate.priceChange7d,
            priceChange30d: candidate.priceChange30d,
            volatilityScore: candidate.volatilityScore,
            breakoutScore: candidate.breakoutScore,
            accumulationScore: candidate.accumulationScore,
            impulseScore: candidate.impulseScore,
            liquidityScore: candidate.liquidityScore,
            riskScore: candidate.riskScore,
            opportunityScore: candidate.opportunityScore,
            category: candidate.category,
            reasons: candidate.reasons,
            warnings: candidate.warnings,
            recommendation: candidate.recommendation,
            paper_only: true
        }
    }));

    for (const group of chunk(documents)) {
        const batch = db.batch();
        for (const doc of group) {
            const ref = db.collection(CANDIDATE_COLLECTION).doc(doc.id);
            batch.set(ref, doc.payload);
        }
        await batch.commit();
    }
}

function buildEligibleSymbols(exchangeInfo = {}, tickers = []) {
    const tickersBySymbol = new Map(
        (Array.isArray(tickers) ? tickers : []).map((item) => [String(item.symbol || '').toUpperCase(), item])
    );

    const allSymbols = Array.isArray(exchangeInfo ?.symbols) ? exchangeInfo.symbols : [];
    const usdtPairs = allSymbols
        .filter((item) => String(item ?.quoteAsset || '').toUpperCase() === 'USDT')
        .filter((item) => String(item ?.status || '').toUpperCase() === 'TRADING');

    let excludedStablesCount = 0;
    let excludedLeveragedCount = 0;

    const filteredSymbols = usdtPairs.filter((item) => {
        if (!hasSpotPermission(item)) {
            return false;
        }

        const baseAsset = String(item ?.baseAsset || '').toUpperCase();
        if (STABLE_BASE_ASSETS.has(baseAsset)) {
            excludedStablesCount += 1;
            return false;
        }
        if (LEVERAGED_SUFFIXES.some((suffix) => baseAsset.endsWith(suffix))) {
            excludedLeveragedCount += 1;
            return false;
        }

        return true;
    });

    const eligibleSymbols = filteredSymbols
        .map((item) => ({
            symbol: String(item.symbol || '').toUpperCase(),
            baseAsset: String(item.baseAsset || '').toUpperCase(),
            ticker: tickersBySymbol.get(String(item.symbol || '').toUpperCase()) || null
        }))
        .filter((item) => item.ticker)
        .filter((item) => Number(item ?.ticker ?.quoteVolume || 0) >= MIN_QUOTE_VOLUME_USDT);

    return {
        eligibleSymbols,
        diagnostics: {
            exchangeInfo_symbols_count: allSymbols.length,
            ticker_24hr_count: tickersBySymbol.size,
            usdt_pairs_after_filter: usdtPairs.length,
            excluded_stables_count: excludedStablesCount,
            excluded_leveraged_count: excludedLeveragedCount,
            final_symbols_to_scan: eligibleSymbols.length,
            top_5_symbols_before_scoring: eligibleSymbols.slice(0, 5).map((item) => item.symbol)
        }
    };
}

async function scanBinanceSpotOpportunities(db, options = {}) {
    if (!db) {
        throw new Error('spot_scanner_requires_db');
    }

    const [exchangeInfo, tickers] = await Promise.all([
        fetchSpotExchangeInfo(),
        fetchSpotTicker24hr()
    ]);

    const { eligibleSymbols, diagnostics } = buildEligibleSymbols(exchangeInfo, tickers);
    console.info('[spot-opportunity-scanner] eligibility_diagnostics', diagnostics);
    const klineResults = await mapWithConcurrency(eligibleSymbols, MAX_CONCURRENCY, async(entry) => ({
        entry,
        klines: await fetchSpotDailyKlines(entry.symbol)
    }));

    const candidates = [];
    for (const result of klineResults) {
        if (!result || result.error || !result.entry) continue;
        const candidate = analyzeSymbol(result.entry, result.klines || []);
        candidates.push(candidate);
    }

    const sortedCandidates = sortByScore(candidates, 'opportunityScore');
    const scanId = `spot_scan_${Date.now()}`;
    const scanDoc = buildScanPayload(scanId, sortedCandidates, eligibleSymbols.length);
    await saveScan(db, scanDoc, sortedCandidates);
    const validationSeedSummary = await seedSpotOpportunityValidations(db, scanDoc, sortedCandidates.slice(0, 20));
    const validationProcessSummary = await processSpotOpportunityValidations(db, options);

    return {
        scan_id: scanId,
        scanner_version: SCANNER_VERSION,
        total_symbols_scanned: eligibleSymbols.length,
        candidates_saved: sortedCandidates.length,
        validation_observations_saved: validationSeedSummary.observations_saved,
        validation_horizons_completed: validationProcessSummary.horizons_completed,
        rejected_count: scanDoc.rejected_count,
        high_risk_count: scanDoc.high_risk_count,
        top_symbol: sortedCandidates[0] ?.symbol || null,
        top_score: sortedCandidates[0] ?.opportunityScore || null,
        market_summary: scanDoc.market_summary,
        top_opportunities: scanDoc.top_opportunities
    };
}

async function getLatestSpotOpportunityDiagnostic(db) {
    if (!db) {
        throw new Error('spot_scanner_requires_db');
    }

    const snapshot = await db.collection(SCAN_COLLECTION).orderBy('created_at', 'desc').limit(1).get();
    if (snapshot.empty) {
        return {
            last_scan_at: null,
            total_symbols_scanned: 0,
            top_opportunities: [],
            top_10_volume_spikes: [],
            top_10_breakouts: [],
            top_10_accumulation_candidates: [],
            high_risk_list: [],
            summary_conclusion: 'No spot opportunity scans available yet.'
        };
    }

    const latestDoc = snapshot.docs[0];
    const scan = { id: latestDoc.id, ...(latestDoc.data() || {}) };
    const candidateSnapshot = await db.collection(CANDIDATE_COLLECTION).where('scan_id', '==', scan.id).get();
    const candidates = candidateSnapshot.docs.map((doc) => doc.data() || {});

    return {
        last_scan_at: scan.created_at || null,
        total_symbols_scanned: Number(scan.total_symbols_scanned || 0),
        top_20_opportunities: sortByScore(candidates, 'opportunityScore').slice(0, 20),
        top_10_volume_spikes: sortByScore(
            candidates.filter((candidate) => candidate.category === 'VOLUME_SPIKE' || (candidate.reasons || []).includes('volume_24h_above_recent_average')),
            'volumeChangeScore'
        ).slice(0, 10),
        top_10_breakouts: sortByScore(
            candidates.filter((candidate) => candidate.category === 'BREAKOUT' || (candidate.reasons || []).includes('recent_high_breakout')),
            'breakoutScore'
        ).slice(0, 10),
        top_10_accumulation_candidates: sortByScore(
            candidates.filter((candidate) => candidate.category === 'ACCUMULATION' || (candidate.reasons || []).includes('accumulation_then_impulse')),
            'accumulationScore'
        ).slice(0, 10),
        high_risk_list: sortByScore(
            candidates.filter((candidate) => candidate.category === 'HIGH_RISK' || candidate.recommendation === 'TOO_RISKY'),
            'riskScore'
        ).slice(0, 20),
        summary_conclusion: scan.market_summary ?.conclusion || 'Spot opportunity scan loaded.',
        market_summary: scan.market_summary || null
    };
}

module.exports = {
    SCANNER_VERSION,
    SCAN_COLLECTION,
    CANDIDATE_COLLECTION,
    scanBinanceSpotOpportunities,
    getLatestSpotOpportunityDiagnostic
};
