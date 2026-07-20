'use strict';

const axios = require('axios');

const BINANCE_API = 'https://api.binance.com';
const RUNS = 'spot_market_opportunity_runs';
const CURRENT = 'spot_market_opportunity_current';
const SYMBOLS = 'spot_market_opportunity_symbols';
const EXCLUDED = new Set(['USDT','USDC','FDUSD','TUSD','DAI','USDP','BUSD','EUR','AEUR','TRY','BRL']);

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(n(value) * factor) / factor;
}

function eligibleTicker(ticker = {}) {
  const symbol = String(ticker.symbol || '').toUpperCase();
  if (!symbol.endsWith('USDT')) return false;
  const base = symbol.slice(0, -4);
  if (!base || EXCLUDED.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
  return n(ticker.lastPrice) > 0 && n(ticker.quoteVolume) >= 1000000 && n(ticker.count) >= 3000;
}

function opportunityScore(ticker = {}) {
  const change = n(ticker.priceChangePercent);
  const volume = n(ticker.quoteVolume);
  const trades = n(ticker.count);
  const price = n(ticker.lastPrice);
  const rangePct = price > 0 ? ((n(ticker.highPrice) - n(ticker.lowPrice)) / price) * 100 : 0;
  const moveFit = change >= 8 && change <= 40 ? 35 : change >= 4 && change < 8 ? 18 : 0;
  const continuationFit = change >= 8 && change <= 22 ? 18 : change > 22 && change <= 40 ? 10 : 0;
  const liquidity = Math.min(22, Math.max(0, Math.log10(Math.max(volume, 1) / 1000000 + 1) * 10));
  const activity = Math.min(15, Math.max(0, Math.log10(Math.max(trades, 1) / 3000 + 1) * 7));
  const rangeFit = rangePct >= 4 && rangePct <= 24 ? 10 : rangePct > 24 ? 2 : 5;
  const penalty = change > 40 ? 35 : change < 0 ? 25 : rangePct > 35 ? 20 : 0;
  return round(Math.max(0, Math.min(100, moveFit + continuationFit + liquidity + activity + rangeFit - penalty)));
}

function classify(change) {
  if (change >= 8 && change < 15) return 'WINNER_8_15';
  if (change >= 15 && change < 25) return 'WINNER_15_25';
  if (change >= 25 && change <= 40) return 'WINNER_25_40';
  if (change > 40) return 'OVEREXTENDED_ABOVE_40';
  if (change >= 4) return 'EMERGING_4_8';
  return 'OTHER';
}

async function fetchTickers() {
  const response = await axios.get(`${BINANCE_API}/api/v3/ticker/24hr`, {
    timeout: 15000,
    headers: { 'User-Agent': 'Proypers25-Market-Opportunity/1.0' }
  });
  return Array.isArray(response.data) ? response.data : [];
}

async function runSpotMarketOpportunityIntelligence(db, options = {}) {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const tickers = (await fetchTickers()).filter(eligibleTicker).map((ticker) => {
    const change = n(ticker.priceChangePercent);
    return {
      symbol: String(ticker.symbol || '').toUpperCase(),
      price: n(ticker.lastPrice),
      change_24h_pct: round(change),
      quote_volume_24h: round(n(ticker.quoteVolume), 2),
      trades_24h: n(ticker.count),
      high_24h: n(ticker.highPrice),
      low_24h: n(ticker.lowPrice),
      winner_band: classify(change),
      opportunity_score: opportunityScore(ticker),
      observed_at: createdAt,
      spot_only: true,
      real_entry_approved: false
    };
  });

  const winners = tickers.filter((item) => item.change_24h_pct >= 8 && item.change_24h_pct <= 40)
    .sort((a, b) => b.opportunity_score - a.opportunity_score || b.quote_volume_24h - a.quote_volume_24h);
  const emerging = tickers.filter((item) => item.change_24h_pct >= 4 && item.change_24h_pct < 8)
    .sort((a, b) => b.opportunity_score - a.opportunity_score);
  const overextended = tickers.filter((item) => item.change_24h_pct > 40)
    .sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  const researchLimit = Math.max(3, Math.min(12, n(options.researchLimit, 10)));
  const researchSymbols = [...new Set([...winners, ...emerging]
    .filter((item) => item.opportunity_score >= 55)
    .map((item) => item.symbol))].slice(0, researchLimit);

  const counts = tickers.reduce((acc, item) => {
    acc[item.winner_band] = (acc[item.winner_band] || 0) + 1;
    return acc;
  }, {});
  const breadth = {
    eligible_universe: tickers.length,
    positive_count: tickers.filter((item) => item.change_24h_pct > 0).length,
    above_4_count: tickers.filter((item) => item.change_24h_pct >= 4).length,
    winner_8_40_count: winners.length,
    overextended_above_40_count: overextended.length,
    positive_ratio: tickers.length ? round(tickers.filter((item) => item.change_24h_pct > 0).length / tickers.length, 4) : 0,
    winner_ratio: tickers.length ? round(winners.length / tickers.length, 4) : 0,
    bands: counts
  };

  const run = {
    id: `market_opportunity_${now}`,
    created_at: createdAt,
    breadth,
    research_symbols: researchSymbols,
    top_winners: winners.slice(0, 30),
    emerging_candidates: emerging.slice(0, 20),
    overextended_watch_only: overextended.slice(0, 20),
    learning_mode: 'OBSERVE_AND_FEED_QUANT',
    no_order_created: true,
    real_entry_approved: false,
    spot_only: true,
    version: 'spot_market_opportunity_v1'
  };

  const batch = db.batch();
  for (const item of winners.slice(0, 50)) {
    batch.set(db.collection(SYMBOLS).doc(item.symbol), {
      ...item,
      last_seen_at: createdAt,
      last_run_id: run.id,
      continuation_learning_pending: true
    }, { merge: true });
  }
  batch.set(db.collection(RUNS).doc(run.id), run);
  batch.set(db.collection(CURRENT).doc('current'), run);
  await batch.commit();

  console.log(JSON.stringify({
    event: 'SPOT_MARKET_OPPORTUNITY_RESULT',
    run_id: run.id,
    breadth,
    research_symbols: researchSymbols,
    top_winners: run.top_winners.slice(0, 10).map((item) => ({ symbol: item.symbol, change_24h_pct: item.change_24h_pct, opportunity_score: item.opportunity_score })),
    no_order_created: true
  }));
  return run;
}

module.exports = { eligibleTicker, opportunityScore, classify, runSpotMarketOpportunityIntelligence };
