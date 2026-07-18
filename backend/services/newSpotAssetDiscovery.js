'use strict';

const axios = require('axios');

const BINANCE_API = 'https://api.binance.com';
const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const REGISTRY = 'spot_symbol_registry';
const DISCOVERIES = 'spot_new_asset_discoveries';
const RUNS = 'spot_new_asset_discovery_runs';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n(value)));
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

async function getJson(url, params = {}) {
  const response = await axios.get(url, {
    params,
    timeout: 12000,
    headers: { 'User-Agent': 'Proypers25-Spot-Research/1.0' }
  });
  return response.data;
}

function isTradableSpotUsdt(symbol = {}) {
  if (symbol.status !== 'TRADING' || symbol.quoteAsset !== 'USDT') return false;
  if (symbol.isSpotTradingAllowed === false) return false;
  const permissions = Array.isArray(symbol.permissions) ? symbol.permissions : [];
  return permissions.length === 0 || permissions.includes('SPOT');
}

async function fetchBinanceUniverse() {
  const [exchangeInfo, tickers] = await Promise.all([
    getJson(`${BINANCE_API}/api/v3/exchangeInfo`),
    getJson(`${BINANCE_API}/api/v3/ticker/24hr`)
  ]);
  const tickerMap = new Map((tickers || []).map((ticker) => [ticker.symbol, ticker]));
  return (exchangeInfo.symbols || [])
    .filter(isTradableSpotUsdt)
    .map((symbol) => ({
      symbol: symbol.symbol,
      base_asset: symbol.baseAsset,
      quote_asset: symbol.quoteAsset,
      status: symbol.status,
      ticker: tickerMap.get(symbol.symbol) || null
    }));
}

async function findCoinGeckoEvidence(baseAsset) {
  try {
    const search = await getJson(`${COINGECKO_API}/search`, { query: baseAsset });
    const candidates = (search.coins || []).filter((coin) =>
      String(coin.symbol || '').toUpperCase() === String(baseAsset || '').toUpperCase()
    ).slice(0, 5);
    if (!candidates.length) return { found: false, ambiguity: 0 };

    let best = null;
    for (const candidate of candidates.slice(0, 3)) {
      try {
        const detail = await getJson(`${COINGECKO_API}/coins/${encodeURIComponent(candidate.id)}`, {
          localization: false,
          tickers: false,
          market_data: true,
          community_data: false,
          developer_data: false,
          sparkline: false
        });
        const homepage = safeUrl(detail.links?.homepage?.find(Boolean));
        const github = safeUrl(detail.links?.repos_url?.github?.find(Boolean));
        const marketCap = n(detail.market_data?.market_cap?.usd, 0);
        const volume = n(detail.market_data?.total_volume?.usd, 0);
        const evidenceScore = (homepage ? 20 : 0) + (github ? 20 : 0) +
          (String(detail.description?.en || '').trim().length >= 120 ? 15 : 0) +
          (marketCap > 0 ? 15 : 0) + (volume > 0 ? 10 : 0) +
          (detail.genesis_date ? 10 : 0) + (Array.isArray(detail.categories) && detail.categories.length ? 10 : 0);
        const row = {
          found: true,
          coingecko_id: detail.id,
          name: detail.name,
          symbol: String(detail.symbol || '').toUpperCase(),
          homepage,
          github,
          genesis_date: detail.genesis_date || null,
          categories: (detail.categories || []).slice(0, 8),
          description_available: String(detail.description?.en || '').trim().length >= 120,
          market_cap_usd: marketCap || null,
          total_volume_usd: volume || null,
          evidence_score: evidenceScore,
          ambiguity: candidates.length
        };
        if (!best || row.evidence_score > best.evidence_score) best = row;
      } catch (_) {
        // Continue with another exact-symbol candidate.
      }
    }
    return best || { found: false, ambiguity: candidates.length };
  } catch (error) {
    return { found: false, ambiguity: 0, error: error.message };
  }
}

function scoreDiscovery(asset, evidence, ageHours) {
  const ticker = asset.ticker || {};
  const quoteVolume = n(ticker.quoteVolume, 0);
  const price = n(ticker.lastPrice, 0);
  const change24h = n(ticker.priceChangePercent, 0);
  const reasons = [];
  const risks = [];
  let score = 0;

  score += clamp(35 - ageHours * 1.5, 0, 35);
  if (quoteVolume >= 5000000) { score += 20; reasons.push('LIQUIDITY_STRONG'); }
  else if (quoteVolume >= 1000000) { score += 14; reasons.push('LIQUIDITY_ACCEPTABLE'); }
  else risks.push('LOW_LIQUIDITY');
  if (price > 0 && price <= 1) { score += 8; reasons.push('LOW_UNIT_PRICE'); }
  if (change24h > 0 && change24h <= 25) { score += 8; reasons.push('POSITIVE_NOT_EXHAUSTED'); }
  if (Math.abs(change24h) > 35) risks.push('EXTREME_24H_MOVE');
  score += clamp(evidence.evidence_score || 0, 0, 30);
  if (evidence.homepage) reasons.push('OFFICIAL_WEBSITE_FOUND');
  if (evidence.github) reasons.push('PUBLIC_CODE_REPOSITORY_FOUND');
  if (!evidence.found) risks.push('PROJECT_EVIDENCE_NOT_FOUND');
  if ((evidence.ambiguity || 0) > 2) risks.push('SYMBOL_IDENTITY_AMBIGUOUS');

  const researchEligible = score >= 65 && quoteVolume >= 1000000 &&
    evidence.found === true && Boolean(evidence.homepage) &&
    !risks.includes('EXTREME_24H_MOVE') && !risks.includes('SYMBOL_IDENTITY_AMBIGUOUS');

  return {
    score: clamp(score),
    reasons,
    risks,
    decision: researchEligible ? 'RESEARCH_CANDIDATE' : risks.length ? 'WATCH_OR_REJECT' : 'WATCH',
    research_eligible: researchEligible,
    real_entry_approved: false,
    requires_backtest: true,
    requires_paper_validation: true,
    requires_runtime_gate: true
  };
}

async function runNewSpotAssetDiscovery(db, options = {}) {
  const now = Date.now();
  const universe = await fetchBinanceUniverse();
  const registrySnapshot = await db.collection(REGISTRY).get();
  const known = new Map(registrySnapshot.docs.map((doc) => [doc.id, doc.data()]));
  const baseline = registrySnapshot.empty;
  const newAssets = universe.filter((asset) => !known.has(asset.symbol));
  const maxResearch = Math.max(1, Math.min(20, n(options.maxResearch, 8)));
  const discoveries = [];

  for (const asset of newAssets.slice(0, maxResearch)) {
    const evidence = baseline ? { found: false, baseline_only: true, ambiguity: 0 } :
      await findCoinGeckoEvidence(asset.base_asset);
    const ageHours = 0;
    const assessment = baseline ? {
      score: 0,
      reasons: ['INITIAL_BASELINE'],
      risks: [],
      decision: 'BASELINE_ONLY',
      research_eligible: false,
      real_entry_approved: false,
      requires_backtest: true,
      requires_paper_validation: true,
      requires_runtime_gate: true
    } : scoreDiscovery(asset, evidence, ageHours);

    const record = {
      symbol: asset.symbol,
      base_asset: asset.base_asset,
      detected_at: new Date(now).toISOString(),
      first_seen_at: new Date(now).toISOString(),
      price: n(asset.ticker?.lastPrice, null),
      quote_volume_24h: n(asset.ticker?.quoteVolume, null),
      price_change_24h_pct: n(asset.ticker?.priceChangePercent, null),
      evidence,
      assessment,
      spot_only: true,
      no_order_created: true,
      version: 'new_spot_asset_discovery_v1'
    };
    await db.collection(DISCOVERIES).doc(asset.symbol).set(record, { merge: true });
    discoveries.push(record);
  }

  const batch = db.batch();
  for (const asset of universe) {
    const ref = db.collection(REGISTRY).doc(asset.symbol);
    const prior = known.get(asset.symbol);
    batch.set(ref, {
      symbol: asset.symbol,
      base_asset: asset.base_asset,
      quote_asset: 'USDT',
      first_seen_at: prior?.first_seen_at || new Date(now).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      active: true
    }, { merge: true });
  }
  await batch.commit();

  const run = {
    id: `new_assets_${now}`,
    created_at: new Date(now).toISOString(),
    baseline,
    universe_size: universe.length,
    new_assets_detected: newAssets.length,
    researched: discoveries.length,
    discoveries,
    no_order_created: true,
    spot_only: true,
    version: 'new_spot_asset_discovery_v1'
  };
  await db.collection(RUNS).doc(run.id).set(run);
  return run;
}

module.exports = {
  runNewSpotAssetDiscovery,
  scoreDiscovery,
  isTradableSpotUsdt,
  findCoinGeckoEvidence
};