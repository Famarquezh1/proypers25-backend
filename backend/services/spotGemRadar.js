'use strict';

const axios = require('axios');
const { runQuantResearchLab } = require('./spotQuantAdvancedResearchLab');

const BINANCE_API = 'https://api.binance.com';
const REGISTRY = 'spot_symbol_registry';
const CATALOG = 'spot_asset_catalog';
const RADAR_RUNS = 'spot_gem_radar_runs';
const RADAR_CURRENT = 'spot_gem_radar';
const MAX_RESEARCH_SYMBOLS = 10;

const EXCLUDED_BASE_ASSETS = new Set([
  'USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'EUR', 'AEUR', 'TRY', 'BRL'
]);

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n(value)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(n(value) * factor) / factor;
}

function isEligibleSymbol(symbol = {}) {
  if (symbol.status !== 'TRADING' || symbol.quoteAsset !== 'USDT') return false;
  if (symbol.isSpotTradingAllowed === false) return false;
  const base = String(symbol.baseAsset || '').toUpperCase();
  if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
  if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
  const permissions = Array.isArray(symbol.permissions) ? symbol.permissions : [];
  return permissions.length === 0 || permissions.includes('SPOT');
}

async function getJson(path) {
  const response = await axios.get(`${BINANCE_API}${path}`, {
    timeout: 15000,
    headers: { 'User-Agent': 'Proypers25-Spot-Gem-Radar/2.0' }
  });
  return response.data;
}

async function fetchSpotUniverse() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJson('/api/v3/exchangeInfo'),
    getJson('/api/v3/ticker/24hr')
  ]);
  const tickerBySymbol = new Map((tickers || []).map((ticker) => [ticker.symbol, ticker]));
  const unique = new Map();

  for (const symbol of (exchangeInfo.symbols || []).filter(isEligibleSymbol)) {
    const ticker = tickerBySymbol.get(symbol.symbol) || {};
    unique.set(symbol.symbol, {
      symbol: symbol.symbol,
      base_asset: symbol.baseAsset,
      quote_asset: symbol.quoteAsset,
      price: n(ticker.lastPrice, 0),
      quote_volume_24h: n(ticker.quoteVolume, 0),
      price_change_24h_pct: n(ticker.priceChangePercent, 0),
      high_24h: n(ticker.highPrice, 0),
      low_24h: n(ticker.lowPrice, 0),
      trades_24h: n(ticker.count, 0)
    });
  }

  return [...unique.values()];
}

function ageDays(firstSeenAt, now = Date.now()) {
  const timestamp = Date.parse(firstSeenAt || '');
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86400000) : null;
}

function logScore(value, floor, ceiling, maxPoints) {
  if (value <= floor) return 0;
  if (value >= ceiling) return maxPoints;
  const normalized = (Math.log10(value) - Math.log10(floor)) /
    (Math.log10(ceiling) - Math.log10(floor));
  return clamp(normalized * maxPoints, 0, maxPoints);
}

function momentumScore(change) {
  if (change <= -10 || change >= 35) return 0;
  if (change >= 3 && change <= 12) return 18;
  if (change > 12 && change <= 20) return 14;
  if (change > 20 && change < 35) return 7;
  if (change > 0 && change < 3) return 9;
  if (change >= -3 && change <= 0) return 4;
  return 1;
}

function volatilityScore(rangePct) {
  if (rangePct < 1 || rangePct > 25) return 0;
  if (rangePct >= 3 && rangePct <= 12) return 14;
  if (rangePct > 12 && rangePct <= 18) return 9;
  if (rangePct >= 1 && rangePct < 3) return 6;
  return 3;
}

function noveltyScore(days) {
  if (days === null) return 0;
  if (days <= 7) return 10;
  if (days <= 30) return 8;
  if (days <= 90) return 5;
  if (days <= 180) return 2;
  return 0;
}

function scoreGemCandidate(asset, prior = {}, now = Date.now()) {
  const volume = n(asset.quote_volume_24h);
  const change = n(asset.price_change_24h_pct);
  const price = n(asset.price);
  const rangePct = price > 0 ? Math.max(0, (n(asset.high_24h) - n(asset.low_24h)) / price * 100) : 0;
  const days = ageDays(prior.first_seen_at, now);
  const reasons = [];
  const risks = [];

  const liquidity = logScore(volume, 500000, 150000000, 26);
  const momentum = momentumScore(change);
  const activity = logScore(n(asset.trades_24h), 1000, 500000, 18);
  const volatility = volatilityScore(rangePct);
  const novelty = noveltyScore(days);
  const continuity = prior.active === true ? 4 : 0;

  let penalty = 0;
  if (volume < 1000000) { risks.push('LOW_LIQUIDITY'); penalty += 20; }
  if (Math.abs(change) > 35) { risks.push('EXTREME_24H_MOVE'); penalty += 20; }
  if (change < -15) { risks.push('SHARP_NEGATIVE_MOVE'); penalty += 12; }
  if (rangePct > 25) { risks.push('EXCESSIVE_INTRADAY_RANGE'); penalty += 15; }
  if (n(asset.trades_24h) < 3000) { risks.push('LOW_MARKET_ACTIVITY'); penalty += 8; }

  const rawScore = liquidity + momentum + activity + volatility + novelty + continuity;
  const score = clamp(rawScore - penalty, 0, 96);

  if (liquidity >= 16) reasons.push('LIQUID_MARKET');
  if (momentum >= 12) reasons.push('CONSTRUCTIVE_MOMENTUM');
  if (activity >= 10) reasons.push('STRONG_TRADING_ACTIVITY');
  if (volatility >= 9) reasons.push('TRADEABLE_RANGE');
  if (novelty >= 5) reasons.push('RECENT_LISTING');

  const researchEligible = score >= 68 && volume >= 5000000 && n(asset.trades_24h) >= 10000 &&
    !risks.includes('EXTREME_24H_MOVE') && !risks.includes('EXCESSIVE_INTRADAY_RANGE');
  const watchEligible = score >= 48 && volume >= 1000000;

  return {
    gem_score: round(score),
    raw_score: round(rawScore),
    penalty: round(penalty),
    components: {
      liquidity: round(liquidity),
      momentum: round(momentum),
      activity: round(activity),
      volatility: round(volatility),
      novelty: round(novelty),
      continuity: round(continuity)
    },
    reasons,
    risks,
    age_days: days === null ? null : round(days, 1),
    state: researchEligible ? 'RESEARCH' : watchEligible ? 'WATCH' : 'OBSERVE',
    research_eligible: researchEligible,
    real_entry_approved: false,
    requires_quant_validation: true,
    requires_paper_validation: true,
    requires_runtime_gate: true
  };
}

function preserveProtectedState(previousState, proposedState) {
  return ['PAPER', 'PROMOTED', 'REAL'].includes(previousState) ? previousState : proposedState;
}

function deduplicateRankedAssets(items = []) {
  const bySymbol = new Map();
  for (const item of items) {
    const symbol = String(item?.symbol || '').toUpperCase();
    if (!symbol) continue;
    const previous = bySymbol.get(symbol);
    if (!previous || n(item.gem_score) > n(previous.gem_score) ||
      (n(item.gem_score) === n(previous.gem_score) && n(item.quote_volume_24h) > n(previous.quote_volume_24h))) {
      bySymbol.set(symbol, { ...item, symbol });
    }
  }
  return [...bySymbol.values()];
}

async function commitInChunks(db, operations, chunkSize = 400) {
  for (let index = 0; index < operations.length; index += chunkSize) {
    const batch = db.batch();
    for (const operation of operations.slice(index, index + chunkSize)) operation(batch);
    await batch.commit();
  }
}

async function runSpotGemRadar(db, options = {}) {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const universe = await fetchSpotUniverse();
  const [registrySnapshot, catalogSnapshot] = await Promise.all([
    db.collection(REGISTRY).get(),
    db.collection(CATALOG).get()
  ]);
  const registry = new Map(registrySnapshot.docs.map((doc) => [doc.id, doc.data()]));
  const catalog = new Map(catalogSnapshot.docs.map((doc) => [doc.id, doc.data()]));

  const assessed = universe.map((asset) => {
    const priorRegistry = registry.get(asset.symbol) || {};
    const priorCatalog = catalog.get(asset.symbol) || {};
    const firstSeenAt = priorRegistry.first_seen_at || priorCatalog.first_seen_at || createdAt;
    const assessment = scoreGemCandidate(asset, { ...priorCatalog, ...priorRegistry, first_seen_at: firstSeenAt }, now);
    return {
      ...asset,
      first_seen_at: firstSeenAt,
      last_seen_at: createdAt,
      gem_score: assessment.gem_score,
      gem_raw_score: assessment.raw_score,
      gem_penalty: assessment.penalty,
      gem_components: assessment.components,
      reasons: assessment.reasons,
      risks: assessment.risks,
      age_days: assessment.age_days,
      state: preserveProtectedState(priorCatalog.state, assessment.state),
      research_eligible: assessment.research_eligible,
      spot_only: true,
      real_entry_approved: false,
      requires_quant_validation: true,
      requires_paper_validation: true,
      requires_runtime_gate: true,
      active: true,
      version: 'spot_gem_radar_v2'
    };
  });

  const ranked = deduplicateRankedAssets(assessed)
    .sort((left, right) => right.gem_score - left.gem_score || right.quote_volume_24h - left.quote_volume_24h);

  const requested = Math.max(1, Math.min(MAX_RESEARCH_SYMBOLS, n(options.maxResearch, 10)));
  const researchCandidates = ranked
    .filter((asset) => asset.research_eligible)
    .slice(0, requested);

  const operations = ranked.flatMap((asset) => [
    (batch) => batch.set(db.collection(REGISTRY).doc(asset.symbol), {
      symbol: asset.symbol,
      base_asset: asset.base_asset,
      quote_asset: 'USDT',
      first_seen_at: asset.first_seen_at,
      last_seen_at: createdAt,
      active: true
    }, { merge: true }),
    (batch) => batch.set(db.collection(CATALOG).doc(asset.symbol), asset, { merge: true })
  ]);
  await commitInChunks(db, operations);

  let quant = null;
  if (options.runQuant !== false && researchCandidates.length) {
    quant = await runQuantResearchLab(db, {
      symbols: researchCandidates.map((asset) => asset.symbol),
      interval: options.interval || '5m',
      limit: Math.max(1000, Math.min(5000, n(options.quantLimit, 4000))),
      feeRate: n(options.feeRate, 0.001),
      slippageRate: n(options.slippageRate, 0.0005)
    });
    const quantBySymbol = new Map((quant.results || []).map((result) => [result.symbol, result]));
    const quantOperations = researchCandidates.map((asset) => (batch) => {
      const result = quantBySymbol.get(asset.symbol);
      batch.set(db.collection(CATALOG).doc(asset.symbol), {
        last_quant_run_id: quant.id || null,
        quant_promotion_eligible: Boolean(result?.promotion_eligible),
        quant_family: result?.champion?.config?.family || null,
        quant_score: n(result?.champion?.score, null),
        state: result?.promotion_eligible ? 'PAPER' : 'RESEARCH',
        real_entry_approved: false,
        updated_at: createdAt
      }, { merge: true });
    });
    await commitInChunks(db, quantOperations);
  }

  const run = {
    id: `gem_radar_${now}`,
    created_at: createdAt,
    universe_size: ranked.length,
    unique_symbol_count: ranked.length,
    research_candidate_count: researchCandidates.length,
    research_symbols: researchCandidates.map((asset) => asset.symbol),
    top_candidates: ranked.slice(0, 30),
    quant_run_id: quant?.id || null,
    quant_promotion_eligible: Boolean(quant?.promotion_eligible),
    spot_only: true,
    no_order_created: true,
    real_entry_approved: false,
    version: 'spot_gem_radar_v2'
  };

  await Promise.all([
    db.collection(RADAR_RUNS).doc(run.id).set(run),
    db.collection(RADAR_CURRENT).doc('current').set(run)
  ]);

  console.log(JSON.stringify({
    event: 'SPOT_GEM_RADAR_RESULT',
    run_id: run.id,
    version: run.version,
    universe_size: run.universe_size,
    unique_symbol_count: run.unique_symbol_count,
    research_candidate_count: run.research_candidate_count,
    research_symbols: run.research_symbols,
    quant_run_id: run.quant_run_id,
    quant_promotion_eligible: run.quant_promotion_eligible
  }));

  return run;
}

module.exports = {
  fetchSpotUniverse,
  isEligibleSymbol,
  scoreGemCandidate,
  preserveProtectedState,
  deduplicateRankedAssets,
  runSpotGemRadar
};