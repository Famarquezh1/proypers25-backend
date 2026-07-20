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
    headers: { 'User-Agent': 'Proypers25-Spot-Gem-Radar/1.0' }
  });
  return response.data;
}

async function fetchSpotUniverse() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJson('/api/v3/exchangeInfo'),
    getJson('/api/v3/ticker/24hr')
  ]);
  const tickerBySymbol = new Map((tickers || []).map((ticker) => [ticker.symbol, ticker]));
  return (exchangeInfo.symbols || []).filter(isEligibleSymbol).map((symbol) => {
    const ticker = tickerBySymbol.get(symbol.symbol) || {};
    return {
      symbol: symbol.symbol,
      base_asset: symbol.baseAsset,
      quote_asset: symbol.quoteAsset,
      price: n(ticker.lastPrice, 0),
      quote_volume_24h: n(ticker.quoteVolume, 0),
      price_change_24h_pct: n(ticker.priceChangePercent, 0),
      high_24h: n(ticker.highPrice, 0),
      low_24h: n(ticker.lowPrice, 0),
      trades_24h: n(ticker.count, 0)
    };
  });
}

function ageDays(firstSeenAt, now = Date.now()) {
  const timestamp = Date.parse(firstSeenAt || '');
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86400000) : null;
}

function scoreGemCandidate(asset, prior = {}, now = Date.now()) {
  const volume = n(asset.quote_volume_24h);
  const change = n(asset.price_change_24h_pct);
  const price = n(asset.price);
  const rangePct = price > 0 ? Math.max(0, (n(asset.high_24h) - n(asset.low_24h)) / price * 100) : 0;
  const days = ageDays(prior.first_seen_at, now);
  const reasons = [];
  const risks = [];

  let liquidity = 0;
  if (volume >= 100000000) liquidity = 25;
  else if (volume >= 25000000) liquidity = 21;
  else if (volume >= 5000000) liquidity = 16;
  else if (volume >= 1000000) liquidity = 9;
  else risks.push('LOW_LIQUIDITY');

  let momentum = 0;
  if (change >= 2 && change <= 15) momentum = 18;
  else if (change > 0 && change < 2) momentum = 10;
  else if (change > 15 && change <= 30) momentum = 9;
  else if (change < -15) risks.push('SHARP_NEGATIVE_MOVE');
  if (Math.abs(change) > 35) risks.push('EXTREME_24H_MOVE');

  let activity = 0;
  if (asset.trades_24h >= 500000) activity = 18;
  else if (asset.trades_24h >= 100000) activity = 14;
  else if (asset.trades_24h >= 20000) activity = 9;
  else if (asset.trades_24h >= 5000) activity = 5;

  let volatility = 0;
  if (rangePct >= 3 && rangePct <= 15) volatility = 14;
  else if (rangePct > 0 && rangePct < 3) volatility = 7;
  else if (rangePct > 15 && rangePct <= 25) volatility = 6;
  else if (rangePct > 25) risks.push('EXCESSIVE_INTRADAY_RANGE');

  let novelty = 0;
  if (days !== null && days <= 7) novelty = 15;
  else if (days !== null && days <= 30) novelty = 12;
  else if (days !== null && days <= 90) novelty = 8;
  else if (days !== null && days <= 180) novelty = 4;

  const continuity = prior.active === true ? 6 : 0;
  const score = clamp(liquidity + momentum + activity + volatility + novelty + continuity);

  if (liquidity >= 16) reasons.push('LIQUID_MARKET');
  if (momentum >= 10) reasons.push('CONSTRUCTIVE_MOMENTUM');
  if (activity >= 9) reasons.push('STRONG_TRADING_ACTIVITY');
  if (volatility >= 7) reasons.push('TRADEABLE_RANGE');
  if (novelty >= 8) reasons.push('RECENT_LISTING');

  const researchEligible = score >= 62 && volume >= 5000000 &&
    !risks.includes('EXTREME_24H_MOVE') && !risks.includes('EXCESSIVE_INTRADAY_RANGE');
  const watchEligible = score >= 42 && volume >= 1000000;

  return {
    gem_score: score,
    components: { liquidity, momentum, activity, volatility, novelty, continuity },
    reasons,
    risks,
    age_days: days,
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

  const ranked = universe.map((asset) => {
    const priorRegistry = registry.get(asset.symbol) || {};
    const priorCatalog = catalog.get(asset.symbol) || {};
    const firstSeenAt = priorRegistry.first_seen_at || priorCatalog.first_seen_at || createdAt;
    const assessment = scoreGemCandidate(asset, { ...priorCatalog, ...priorRegistry, first_seen_at: firstSeenAt }, now);
    return {
      ...asset,
      first_seen_at: firstSeenAt,
      last_seen_at: createdAt,
      gem_score: assessment.gem_score,
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
      version: 'spot_gem_radar_v1'
    };
  }).sort((left, right) => right.gem_score - left.gem_score || right.quote_volume_24h - left.quote_volume_24h);

  const requested = Math.max(1, Math.min(MAX_RESEARCH_SYMBOLS, n(options.maxResearch, 10)));
  const researchCandidates = ranked.filter((asset) => asset.research_eligible).slice(0, requested);

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
    research_candidate_count: researchCandidates.length,
    research_symbols: researchCandidates.map((asset) => asset.symbol),
    top_candidates: ranked.slice(0, 30),
    quant_run_id: quant?.id || null,
    quant_promotion_eligible: Boolean(quant?.promotion_eligible),
    spot_only: true,
    no_order_created: true,
    real_entry_approved: false,
    version: 'spot_gem_radar_v1'
  };

  await Promise.all([
    db.collection(RADAR_RUNS).doc(run.id).set(run),
    db.collection(RADAR_CURRENT).doc('current').set(run)
  ]);

  console.log(JSON.stringify({
    event: 'SPOT_GEM_RADAR_RESULT',
    run_id: run.id,
    universe_size: run.universe_size,
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
  runSpotGemRadar
};
