const {
    PAPER_ONLY_LOCK,
    MIN_OPPORTUNITY_SCORE,
    MAX_SIMULATED_CAPITAL_USDT,
    MAX_OPEN_POSITIONS,
    MAX_OPEN_POSITIONS_PER_SYMBOL,
    STOP_LOSS_PCT,
    TAKE_PROFIT_LEVELS,
    TIMEOUT_HOURS,
    ESTIMATED_FEE_PCT,
    round,
    average,
    isEligiblePaperCategory,
    buildTakeProfitLevels,
    summarizePositiveValidation,
    buildPaperExecutionConclusion
} = require('../lib/spotPaperRiskRules');

const SPOT_PUBLIC_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const PUBLIC_KLINE_INTERVAL = '5m';
const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.BINANCE_SPOT_PAPER_TIMEOUT_MS || 12000));
const RECENT_MAX_DOCS = Math.max(50, Math.min(500, Number(process.env.BINANCE_SPOT_PAPER_MAX_DOCS || 250)));

const SCAN_COLLECTION = 'spot_opportunity_scans';
const CANDIDATE_COLLECTION = 'spot_opportunity_candidates';
const VALIDATION_COLLECTION = 'spot_opportunity_validations';
const INTENTS_COLLECTION = 'spot_paper_execution_intents';
const POSITIONS_COLLECTION = 'spot_paper_positions';
const RESULTS_COLLECTION = 'spot_paper_execution_results';

const FORBIDDEN_BINANCE_PATH_SEGMENTS = ['/api/v3/order', '/api/v3/order/test', '/sapi/', '/fapi/', '/papi/'];

function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value ?.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date ?.getTime ?.()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function sum(values = []) {
    return values.map((value) => Number(value)).filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function buildRate(numerator, denominator) {
    if (!denominator) return 0;
    return round((Number(numerator || 0) / Number(denominator || 0)) * 100, 2);
}

function resolveMovePct(entryPrice, targetPrice) {
    const entry = Number(entryPrice);
    const target = Number(targetPrice);
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(target) || target <= 0) return null;
    return ((target - entry) / entry) * 100;
}

function assertPaperOnlySafety(options = {}) {
    if (PAPER_ONLY_LOCK !== true) {
        throw new Error('spot_paper_execution_paper_only_lock_failed');
    }
    if (
        options.real_execution === true ||
        options.enableRealTrading === true ||
        options.usePrivateBinanceApi === true ||
        options.signedRequest === true ||
        options.apiKey ||
        options.apiSecret ||
        options.secretKey
    ) {
        throw new Error('spot_paper_execution_private_api_forbidden');
    }
}

function assertPublicSpotUrl(urlString) {
    const url = new URL(urlString);
    const normalized = `${url.pathname}${url.search}`.toLowerCase();
    if (url.host !== 'api.binance.com') {
        throw new Error('spot_paper_execution_public_host_required');
    }
    if (FORBIDDEN_BINANCE_PATH_SEGMENTS.some((segment) => normalized.includes(segment))) {
        throw new Error('spot_paper_execution_private_endpoint_forbidden');
    }
    if (url.searchParams.has('signature') || url.searchParams.has('timestamp')) {
        throw new Error('spot_paper_execution_signed_request_forbidden');
    }
}

async function fetchPublicSpotKlines(symbol, startTime, endTime, interval = PUBLIC_KLINE_INTERVAL) {
    assertPaperOnlySafety();
    const query = new URLSearchParams({
        symbol: String(symbol || '').toUpperCase(),
        interval,
        startTime: String(Number(startTime || 0)),
        endTime: String(Number(endTime || 0)),
        limit: '1000'
    });
    const url = `${SPOT_PUBLIC_KLINES_URL}?${query.toString()}`;
    assertPublicSpotUrl(url);

    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`spot_paper_execution_status_${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeTime: Number(row[6]),
        quoteVolume: Number(row[7])
    })).filter((row) => Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
}

/**
 * Fetch current price from Binance public ticker
 * Used as fallback when klines are unavailable (timeout closure)
 * Paper-only, public endpoint
 */
async function fetchPublicSpotPrice(symbol) {
    assertPaperOnlySafety();
    const query = new URLSearchParams({
        symbol: String(symbol || '').toUpperCase()
    });
    const url = `https://api.binance.com/api/v3/ticker/price?${query.toString()}`;
    assertPublicSpotUrl(url);

    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) return null;
        const data = await response.json();
        const price = Number(data.price || 0);
        return price > 0 ? round(price, 8) : null;
    } catch (error) {
        return null;
    }
}

function buildOpenPositionId(scanId, symbol) {
    return `spot_paper_position_${scanId}_${String(symbol || '').toUpperCase()}`;
}

function buildOpenIntentId(scanId, symbol) {
    return `spot_paper_intent_${scanId}_${String(symbol || '').toUpperCase()}`;
}

function buildRejectedIntentId(scanId, symbol, cycleId) {
    return `spot_paper_reject_${scanId}_${String(symbol || '').toUpperCase()}_${cycleId}`;
}

function buildClosedResultId(positionId) {
    return `spot_paper_result_${positionId}`;
}

function buildCandidateId(scanId, symbol) {
    return `${scanId}_${String(symbol || '').toUpperCase()}`;
}

function sortCandidates(items = []) {
    return [...items].sort((left, right) => {
        const rightValidation = Number(right.validation_priority || 0);
        const leftValidation = Number(left.validation_priority || 0);
        if (Math.abs(rightValidation - leftValidation) > 0.000001) return rightValidation - leftValidation;
        const scoreDiff = Number(right.opportunityScore || 0) - Number(left.opportunityScore || 0);
        if (Math.abs(scoreDiff) > 0.000001) return scoreDiff;
        return Number(right.quoteVolume24h || 0) - Number(left.quoteVolume24h || 0);
    });
}

function buildIntentReason(candidate = {}, validationSummary = {}) {
    const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 3) : [];
    if (validationSummary.completed_count > 0) {
        reasons.push(`validation_${validationSummary.strongest_horizon || 'recent'}_${validationSummary.positive ? 'positive' : 'negative'}`);
    }
    return reasons.filter(Boolean).join(', ') || 'spot_paper_execution_candidate';
}

function calculatePnlFields(entryPrice, exitPrice, capitalUsdt) {
    const grossPnlPct = resolveMovePct(entryPrice, exitPrice);
    const grossPnlUsdt = Number(capitalUsdt || 0) * Number(grossPnlPct || 0) / 100;
    const estimatedNetPnlPct = Number(grossPnlPct || 0) - ESTIMATED_FEE_PCT;
    const estimatedNetPnlUsdt = Number(capitalUsdt || 0) * estimatedNetPnlPct / 100;

    return {
        gross_pnl_usdt: round(grossPnlUsdt, 4),
        gross_pnl_pct: round(grossPnlPct, 4),
        estimated_fee_pct: round(ESTIMATED_FEE_PCT, 4),
        estimated_net_pnl_usdt: round(estimatedNetPnlUsdt, 4),
        estimated_net_pnl_pct: round(estimatedNetPnlPct, 4)
    };
}

function evaluatePositionExit(position = {}, klines = [], now = new Date(), fallbackPrice = null) {
    const entryPrice = Number(position.entry_price_simulated || 0);
    if (!(entryPrice > 0)) {
        return null;
    }

    const tp1Price = entryPrice * (1 + (TAKE_PROFIT_LEVELS[0].target_pct / 100));
    const tp2Price = entryPrice * (1 + (TAKE_PROFIT_LEVELS[1].target_pct / 100));
    const stopLossPrice = entryPrice * (1 + (STOP_LOSS_PCT / 100));

    let maxFavorableMovePct = null;
    let maxAdverseMovePct = null;
    let exitReason = null;
    let exitPrice = null;
    let triggerAt = null;

    // Evaluate TP/SL if klines exist
    if (Array.isArray(klines) && klines.length > 0) {
        for (const row of klines) {
            const favorableMove = resolveMovePct(entryPrice, row.high);
            const adverseMove = resolveMovePct(entryPrice, row.low);
            if (Number.isFinite(favorableMove)) {
                maxFavorableMovePct = maxFavorableMovePct === null ? favorableMove : Math.max(maxFavorableMovePct, favorableMove);
            }
            if (Number.isFinite(adverseMove)) {
                maxAdverseMovePct = maxAdverseMovePct === null ? adverseMove : Math.min(maxAdverseMovePct, adverseMove);
            }

            const stopHit = Number(row.low || 0) <= stopLossPrice;
            const tp2Hit = Number(row.high || 0) >= tp2Price;
            const tp1Hit = Number(row.high || 0) >= tp1Price;

            if (stopHit && (tp1Hit || tp2Hit)) {
                exitReason = 'SL';
                exitPrice = stopLossPrice;
                triggerAt = Number(row.closeTime || row.openTime || 0);
                break;
            }
            if (stopHit) {
                exitReason = 'SL';
                exitPrice = stopLossPrice;
                triggerAt = Number(row.closeTime || row.openTime || 0);
                break;
            }
            if (tp2Hit) {
                exitReason = 'TP2';
                exitPrice = tp2Price;
                triggerAt = Number(row.closeTime || row.openTime || 0);
                break;
            }
            if (tp1Hit) {
                exitReason = 'TP1';
                exitPrice = tp1Price;
                triggerAt = Number(row.closeTime || row.openTime || 0);
                break;
            }
        }
    }

    const latestClose = (Array.isArray(klines) && klines.length > 0) ? Number(klines[klines.length - 1] ?.close || 0) : 0;
    const openedAt = parseDateLike(position.created_at || position.opened_at);
    const timeoutAt = openedAt ? new Date(openedAt.getTime() + (TIMEOUT_HOURS * 60 * 60 * 1000)) : null;

    // TIMEOUT: Time-based only (no price requirement)
    if (!exitReason && timeoutAt && timeoutAt.getTime() <= now.getTime()) {
        exitReason = 'TIMEOUT';
        // Use fallback price if klines unavailable, else use latest close
        exitPrice = fallbackPrice > 0 ? fallbackPrice : (latestClose > 0 ? latestClose : null);
        triggerAt = now.getTime();
    }

    return {
        exit_reason: exitReason,
        exit_price_simulated: exitPrice ? round(exitPrice, 8) : null,
        trigger_at: triggerAt ? new Date(triggerAt).toISOString() : null,
        latest_market_price: latestClose > 0 ? round(latestClose, 8) : null,
        fallback_price_used: (exitReason === 'TIMEOUT' && fallbackPrice > 0) ? true : false,
        max_favorable_move_pct: round(maxFavorableMovePct, 4),
        max_adverse_move_pct: round(maxAdverseMovePct, 4)
    };
}

async function loadLatestSpotOpportunities(db) {
    const latestScanSnapshot = await db.collection(SCAN_COLLECTION).orderBy('created_at', 'desc').limit(1).get();
    if (latestScanSnapshot.empty) {
        return {
            latestScan: null,
            rankedCandidates: []
        };
    }

    const latestScan = { id: latestScanSnapshot.docs[0].id, ...(latestScanSnapshot.docs[0].data() || {}) };
    const [candidateSnapshot, validationSnapshot] = await Promise.all([
        db.collection(CANDIDATE_COLLECTION).where('scan_id', '==', latestScan.id).get(),
        db.collection(VALIDATION_COLLECTION).where('scan_id', '==', latestScan.id).get()
    ]);

    const validationsBySymbol = new Map(
        validationSnapshot.docs.map((doc) => {
            const item = { id: doc.id, ...(doc.data() || {}) };
            return [String(item.symbol || '').toUpperCase(), item];
        })
    );

    const rankedCandidates = sortCandidates(candidateSnapshot.docs.map((doc) => {
        const candidate = { id: doc.id, ...(doc.data() || {}) };
        const symbol = String(candidate.symbol || '').toUpperCase();
        const validation = validationsBySymbol.get(symbol) || null;
        const validationSummary = summarizePositiveValidation(validation);
        const isHighRisk = (
            String(candidate.category || '').toUpperCase() === 'HIGH_RISK' ||
            String(candidate.recommendation || '').toUpperCase() === 'TOO_RISKY' ||
            Number(candidate.riskScore || 0) >= 75
        );

        let rejectionReason = null;
        if (!isEligiblePaperCategory(candidate.category)) {
            rejectionReason = 'category_not_allowed';
        } else if (Number(candidate.opportunityScore || 0) < MIN_OPPORTUNITY_SCORE) {
            rejectionReason = 'score_below_threshold';
        } else if (isHighRisk) {
            rejectionReason = 'high_risk_symbol';
        } else if (validationSummary.completed_count > 0 && validationSummary.positive !== true) {
            rejectionReason = 'validation_not_positive';
        }

        return {
            ...candidate,
            symbol,
            scan_id: latestScan.id,
            candidate_id: candidate.id || buildCandidateId(latestScan.id, symbol),
            validation_id: validation ? validation.id : null,
            validation_summary: validationSummary,
            validation_priority: (validationSummary.positive_completed_count * 10) + Number(validationSummary.strongest_favorable_move_pct || 0),
            rejected: rejectionReason !== null,
            rejection_reason: rejectionReason,
            paper_only: true
        };
    }));

    return {
        latestScan,
        rankedCandidates
    };
}

async function loadOpenPaperPositions(db) {
    const snapshot = await db.collection(POSITIONS_COLLECTION).where('status', '==', 'PAPER_OPEN').get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function loadRecentPaperIntents(db, maxDocs = RECENT_MAX_DOCS) {
    const snapshot = await db.collection(INTENTS_COLLECTION).orderBy('created_at', 'desc').limit(maxDocs).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function createRejectedIntent(db, candidate, cycleId, reason) {
    const intentId = buildRejectedIntentId(candidate.scan_id, candidate.symbol, cycleId);
    await db.collection(INTENTS_COLLECTION).doc(intentId).set({
        id: intentId,
        symbol: candidate.symbol,
        scan_id: candidate.scan_id,
        candidate_id: candidate.candidate_id,
        validation_id: candidate.validation_id || null,
        category: candidate.category || null,
        opportunityScore: Number(candidate.opportunityScore || 0),
        entry_price_simulated: Number(candidate.price || 0),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        simulated_capital_usdt: MAX_SIMULATED_CAPITAL_USDT,
        simulated_quantity: null,
        take_profit_levels: buildTakeProfitLevels(candidate.price),
        stop_loss_simulado: round(Number(candidate.price || 0) * (1 + (STOP_LOSS_PCT / 100)), 8),
        reason,
        status: 'PAPER_REJECTED',
        paper_only: true
    }, { merge: true });

    return intentId;
}

async function openPaperPosition(db, candidate, cycleId) {
    const createdAt = new Date().toISOString();
    const entryPrice = Number(candidate.price || 0);
    if (!(entryPrice > 0)) {
        throw new Error(`spot_paper_execution_invalid_entry_price_${candidate.symbol || 'unknown'}`);
    }

    const positionId = buildOpenPositionId(candidate.scan_id, candidate.symbol);
    const intentId = buildOpenIntentId(candidate.scan_id, candidate.symbol);
    const simulatedQuantity = round(MAX_SIMULATED_CAPITAL_USDT / entryPrice, 8);
    const takeProfitLevels = buildTakeProfitLevels(entryPrice);
    const stopLossPrice = round(entryPrice * (1 + (STOP_LOSS_PCT / 100)), 8);
    const timeoutAt = new Date(new Date(createdAt).getTime() + (TIMEOUT_HOURS * 60 * 60 * 1000)).toISOString();
    const reason = buildIntentReason(candidate, candidate.validation_summary);

    await db.collection(INTENTS_COLLECTION).doc(intentId).set({
        id: intentId,
        cycle_id: cycleId,
        position_id: positionId,
        symbol: candidate.symbol,
        scan_id: candidate.scan_id,
        candidate_id: candidate.candidate_id,
        validation_id: candidate.validation_id || null,
        category: candidate.category || null,
        opportunityScore: Number(candidate.opportunityScore || 0),
        entry_price_simulated: round(entryPrice, 8),
        created_at: createdAt,
        updated_at: createdAt,
        simulated_capital_usdt: MAX_SIMULATED_CAPITAL_USDT,
        simulated_quantity: simulatedQuantity,
        take_profit_levels: takeProfitLevels,
        stop_loss_simulado: stopLossPrice,
        reason,
        status: 'PAPER_OPEN',
        paper_only: true
    }, { merge: true });

    await db.collection(POSITIONS_COLLECTION).doc(positionId).set({
        id: positionId,
        intent_id: intentId,
        cycle_id: cycleId,
        symbol: candidate.symbol,
        scan_id: candidate.scan_id,
        candidate_id: candidate.candidate_id,
        validation_id: candidate.validation_id || null,
        category: candidate.category || null,
        opportunityScore: Number(candidate.opportunityScore || 0),
        entry_price_simulated: round(entryPrice, 8),
        simulated_capital_usdt: MAX_SIMULATED_CAPITAL_USDT,
        simulated_quantity: simulatedQuantity,
        take_profit_levels: takeProfitLevels,
        stop_loss_simulado: stopLossPrice,
        created_at: createdAt,
        opened_at: createdAt,
        updated_at: createdAt,
        timeout_at: timeoutAt,
        status: 'PAPER_OPEN',
        reason,
        validation_summary: candidate.validation_summary,
        paper_only: true
    }, { merge: true });

    return {
        intent_id: intentId,
        position_id: positionId,
        symbol: candidate.symbol
    };
}

async function closePaperPosition(db, position, exitEvaluation, now = new Date()) {
    const closedAt = now.toISOString();
    const exitPrice = Number(exitEvaluation.exit_price_simulated || 0);
    const pnl = calculatePnlFields(position.entry_price_simulated, exitPrice, position.simulated_capital_usdt);
    const takeProfitLevels = Array.isArray(position.take_profit_levels) ? position.take_profit_levels.map((level) => ({
        ...level,
        status: exitEvaluation.exit_reason === 'TP2' ? 'hit' : (exitEvaluation.exit_reason === 'TP1' && level.label === 'TP1' ? 'hit' : 'pending')
    })) : [];

    await db.collection(POSITIONS_COLLECTION).doc(position.id).set({
        status: 'PAPER_CLOSED',
        closed_at: closedAt,
        updated_at: closedAt,
        close_reason: exitEvaluation.exit_reason,
        exit_price_simulated: round(exitPrice, 8),
        trigger_at: exitEvaluation.trigger_at || closedAt,
        latest_market_price: exitEvaluation.latest_market_price,
        fallback_price_used: exitEvaluation.fallback_price_used || false,
        max_favorable_move_pct: exitEvaluation.max_favorable_move_pct,
        max_adverse_move_pct: exitEvaluation.max_adverse_move_pct,
        take_profit_levels: takeProfitLevels,
        paper_only: true,
        ...pnl
    }, { merge: true });

    if (position.intent_id) {
        await db.collection(INTENTS_COLLECTION).doc(position.intent_id).set({
            status: 'PAPER_CLOSED',
            updated_at: closedAt,
            close_reason: exitEvaluation.exit_reason,
            exit_price_simulated: round(exitPrice, 8),
            paper_only: true,
            ...pnl
        }, { merge: true });
    }

    await db.collection(RESULTS_COLLECTION).doc(buildClosedResultId(position.id)).set({
        id: buildClosedResultId(position.id),
        position_id: position.id,
        intent_id: position.intent_id || null,
        symbol: position.symbol,
        scan_id: position.scan_id,
        candidate_id: position.candidate_id || null,
        validation_id: position.validation_id || null,
        category: position.category || null,
        created_at: position.created_at || position.opened_at || closedAt,
        closed_at: closedAt,
        close_reason: exitEvaluation.exit_reason,
        entry_price_simulated: Number(position.entry_price_simulated || 0),
        exit_price_simulated: round(exitPrice, 8),
        simulated_capital_usdt: Number(position.simulated_capital_usdt || 0),
        simulated_quantity: Number(position.simulated_quantity || 0),
        fallback_price_used: exitEvaluation.fallback_price_used || false,
        paper_only: true,
        ...pnl
    }, { merge: true });

    return {
        symbol: position.symbol,
        close_reason: exitEvaluation.exit_reason,
        estimated_net_pnl_pct: pnl.estimated_net_pnl_pct,
        estimated_net_pnl_usdt: pnl.estimated_net_pnl_usdt
    };
}

async function updateOpenPaperPositions(db, openPositions = [], options = {}) {
    assertPaperOnlySafety(options);
    const now = parseDateLike(options.now) || new Date();
    let closedPositions = 0;
    let updatedOpenPositions = 0;
    const closedSummaries = [];
    const timeoutPositionsWithoutPrice = [];

    for (const position of openPositions) {
        const openedAt = parseDateLike(position.opened_at || position.created_at);
        if (!openedAt || !position.symbol) continue;

        // Try to fetch klines (historical data)
        let klines = [];
        try {
            klines = await fetchPublicSpotKlines(position.symbol, openedAt.getTime(), now.getTime());
        } catch (error) {
            // Klines fetch failed, but we can still evaluate TIMEOUT with fallback price
            console.log(`[PAPER_TIMEOUT] Klines fetch failed for ${position.symbol}:`, error.message);
        }

        // If no klines, try to fetch current price as fallback
        let fallbackPrice = null;
        if (!klines || !klines.length) {
            try {
                fallbackPrice = await fetchPublicSpotPrice(position.symbol);
                if (fallbackPrice) {
                    console.log(`[PAPER_TIMEOUT] Using fallback price for ${position.symbol}: ${fallbackPrice}`);
                }
            } catch (error) {
                console.log(`[PAPER_TIMEOUT] Fallback price fetch also failed for ${position.symbol}`);
            }
        }

        // Evaluate exit (with or without klines, TIMEOUT will be evaluated)
        const exitEvaluation = evaluatePositionExit(position, klines, now, fallbackPrice);
        if (!exitEvaluation) continue;

        if (exitEvaluation.exit_reason) {
            // Has exit reason (TP1, TP2, SL, or TIMEOUT)
            if (exitEvaluation.exit_reason === 'TIMEOUT' && !exitEvaluation.exit_price_simulated) {
                // TIMEOUT triggered but no price available
                timeoutPositionsWithoutPrice.push({
                    symbol: position.symbol,
                    position_id: position.id,
                    age_hours: (now.getTime() - openedAt.getTime()) / (60 * 60 * 1000),
                    reason: 'timeout_price_unavailable'
                });
                // Do NOT close without a price - log for visibility
                console.log(`[PAPER_TIMEOUT_WARNING] ${position.symbol} exceeded timeout but no exit price available`);
                continue;
            }

            const closed = await closePaperPosition(db, position, exitEvaluation, now);
            closedPositions += 1;
            closedSummaries.push(closed);
            continue;
        }

        // No exit reason - update position with latest data
        await db.collection(POSITIONS_COLLECTION).doc(position.id).set({
            updated_at: now.toISOString(),
            latest_market_price: exitEvaluation.latest_market_price,
            max_favorable_move_pct: exitEvaluation.max_favorable_move_pct,
            max_adverse_move_pct: exitEvaluation.max_adverse_move_pct,
            paper_only: true
        }, { merge: true });
        updatedOpenPositions += 1;
    }

    return {
        open_positions_seen: openPositions.length,
        open_positions_updated: updatedOpenPositions,
        positions_closed: closedPositions,
        timeout_positions_without_price: timeoutPositionsWithoutPrice.length,
        timeout_details: timeoutPositionsWithoutPrice,
        closed_summaries: closedSummaries
    };
}

async function createPaperIntents(db, rankedCandidates = [], options = {}) {
    assertPaperOnlySafety(options);
    const cycleId = `spot_paper_cycle_${Date.now()}`;
    const recentIntents = await loadRecentPaperIntents(db, RECENT_MAX_DOCS);
    const openPositions = await loadOpenPaperPositions(db);
    const openSymbols = new Map();
    for (const position of openPositions) {
        const symbol = String(position.symbol || '').toUpperCase();
        openSymbols.set(symbol, (openSymbols.get(symbol) || 0) + 1);
    }

    let availableSlots = Math.max(0, MAX_OPEN_POSITIONS - openPositions.length);
    let intentsCreated = 0;
    let intentsRejected = 0;
    const openedSymbols = [];
    const recentIntentKeys = new Set(
        recentIntents
        .filter((item) => item.scan_id && item.symbol)
        .map((item) => `${item.scan_id}:${String(item.symbol || '').toUpperCase()}`)
    );

    for (const candidate of rankedCandidates.slice(0, 20)) {
        const candidateKey = `${candidate.scan_id}:${candidate.symbol}`;
        if (recentIntentKeys.has(candidateKey)) continue;

        if (candidate.rejected) {
            await createRejectedIntent(db, candidate, cycleId, candidate.rejection_reason);
            intentsRejected += 1;
            continue;
        }

        if ((openSymbols.get(candidate.symbol) || 0) >= MAX_OPEN_POSITIONS_PER_SYMBOL) {
            await createRejectedIntent(db, candidate, cycleId, 'symbol_already_open');
            intentsRejected += 1;
            continue;
        }

        if (availableSlots <= 0) {
            await createRejectedIntent(db, candidate, cycleId, 'max_open_positions_reached');
            intentsRejected += 1;
            continue;
        }

        const opened = await openPaperPosition(db, candidate, cycleId);
        intentsCreated += 1;
        availableSlots -= 1;
        openSymbols.set(candidate.symbol, (openSymbols.get(candidate.symbol) || 0) + 1);
        openedSymbols.push(opened.symbol);
    }

    return {
        cycle_id: cycleId,
        intents_created: intentsCreated,
        intents_rejected: intentsRejected,
        opened_symbols: openedSymbols
    };
}

async function getSpotPaperExecutionDiagnostic(db, options = {}) {
    assertPaperOnlySafety(options);
    if (!db) {
        throw new Error('spot_paper_execution_requires_db');
    }

    const maxDocs = Math.max(20, Math.min(500, Number(options.maxDocs || RECENT_MAX_DOCS)));
    const [intentsSnapshot, positionsSnapshot, resultsSnapshot] = await Promise.all([
        db.collection(INTENTS_COLLECTION).orderBy('created_at', 'desc').limit(maxDocs).get(),
        db.collection(POSITIONS_COLLECTION).orderBy('created_at', 'desc').limit(maxDocs).get(),
        db.collection(RESULTS_COLLECTION).orderBy('closed_at', 'desc').limit(maxDocs).get()
    ]);

    const intents = intentsSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    const positions = positionsSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    const results = resultsSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));

    const openPaperPositions = positions.filter((item) => item.status === 'PAPER_OPEN');
    const closedPaperPositions = positions.filter((item) => item.status === 'PAPER_CLOSED');
    const winningResults = results.filter((item) => Number(item.estimated_net_pnl_usdt || 0) > 0);
    const losingResults = results.filter((item) => Number(item.estimated_net_pnl_usdt || 0) < 0);

    const symbolStats = new Map();
    for (const item of results) {
        const symbol = String(item.symbol || '').toUpperCase();
        if (!symbolStats.has(symbol)) {
            symbolStats.set(symbol, { symbol, total_net_pnl_usdt: 0, total_net_pnl_pct: 0, trades: 0 });
        }
        const current = symbolStats.get(symbol);
        current.total_net_pnl_usdt += Number(item.estimated_net_pnl_usdt || 0);
        current.total_net_pnl_pct += Number(item.estimated_net_pnl_pct || 0);
        current.trades += 1;
    }
    const symbolSummary = Array.from(symbolStats.values()).map((item) => ({
        symbol: item.symbol,
        total_net_pnl_usdt: round(item.total_net_pnl_usdt, 4),
        avg_net_pnl_pct: round(item.total_net_pnl_pct / Math.max(1, item.trades), 4),
        trades: item.trades
    })).sort((left, right) => Number(right.total_net_pnl_usdt || 0) - Number(left.total_net_pnl_usdt || 0));

    const totalClosedCapital = sum(results.map((item) => item.simulated_capital_usdt));
    const summary = {
        open_paper_positions: openPaperPositions.length,
        closed_paper_positions: closedPaperPositions.length,
        total_simulated_capital: round(sum(positions.map((item) => item.simulated_capital_usdt)), 4),
        total_net_pnl_usdt: round(sum(results.map((item) => item.estimated_net_pnl_usdt)), 4),
        total_net_pnl_pct: totalClosedCapital > 0 ? round((sum(results.map((item) => item.estimated_net_pnl_usdt)) / totalClosedCapital) * 100, 4) : 0,
        win_rate: buildRate(winningResults.length, results.length),
        avg_win_pct: round(average(winningResults.map((item) => item.estimated_net_pnl_pct)), 4) || 0,
        avg_loss_pct: round(average(losingResults.map((item) => item.estimated_net_pnl_pct)), 4) || 0,
        best_symbol: symbolSummary[0] || null,
        worst_symbol: symbolSummary.length ? symbolSummary[symbolSummary.length - 1] : null,
        positions_by_status: intents.reduce((acc, item) => {
            const key = item.status || 'UNKNOWN';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {}),
        positions_by_category: positions.reduce((acc, item) => {
            const key = item.category || 'UNKNOWN';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {}),
        recent_paper_trades: results.slice(0, 20),
        conclusion: ''
    };

    summary.conclusion = buildPaperExecutionConclusion(summary);
    return summary;
}

async function runSpotPaperExecutionCycle(db, options = {}) {
    assertPaperOnlySafety(options);
    if (!db) {
        throw new Error('spot_paper_execution_requires_db');
    }

    const updateSummary = await updateOpenPaperPositions(db, await loadOpenPaperPositions(db), options);
    const { latestScan, rankedCandidates } = await loadLatestSpotOpportunities(db);
    const creationSummary = await createPaperIntents(db, rankedCandidates, options);
    const diagnostic = await getSpotPaperExecutionDiagnostic(db, { maxDocs: options.maxDocs || RECENT_MAX_DOCS });

    return {
        paper_only: true,
        latest_scan_id: latestScan ? latestScan.id : null,
        open_positions_seen: updateSummary.open_positions_seen,
        open_positions_updated: updateSummary.open_positions_updated,
        positions_closed: updateSummary.positions_closed,
        intents_created: creationSummary.intents_created,
        intents_rejected: creationSummary.intents_rejected,
        opened_symbols: creationSummary.opened_symbols,
        diagnostic
    };
}

module.exports = {
    INTENTS_COLLECTION,
    POSITIONS_COLLECTION,
    RESULTS_COLLECTION,
    assertPaperOnlySafety,
    getSpotPaperExecutionDiagnostic,
    runSpotPaperExecutionCycle
};
