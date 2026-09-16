'use strict';

const DEFAULTS = Object.freeze({
  blockScore: 0.65,
  warnScore: 0.45,
  dominantWallConcentration: 0.58,
  dominantWallDrop: 0.65,
  imbalanceJump: 0.95,
  thinVisibleDepthQuote: 4000,
  priceBurstPct: 0.012,
  weakAggressiveBuyRatio: 0.46,
  burstRejectionPct: -0.008
});

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finite(value)));
}

function normalizeSide(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map((row) => {
      const price = finite(Array.isArray(row) ? row[0] : row && row.price, NaN);
      const qty = finite(Array.isArray(row) ? row[1] : row && row.qty, NaN);
      return { price, qty, quote: price > 0 && qty > 0 ? price * qty : 0 };
    })
    .filter((row) => row.price > 0 && row.qty > 0 && row.quote > 0);
}

function summarizeDepth(snapshot = {}) {
  const bids = normalizeSide(snapshot.bids);
  const asks = normalizeSide(snapshot.asks);
  const bidQuote = bids.reduce((sum, row) => sum + row.quote, 0);
  const askQuote = asks.reduce((sum, row) => sum + row.quote, 0);
  const totalQuote = bidQuote + askQuote;
  const largestBid = bids.reduce((best, row) => row.quote > (best ? best.quote : 0) ? row : best, null);
  const largestAsk = asks.reduce((best, row) => row.quote > (best ? best.quote : 0) ? row : best, null);
  const bidConcentration = bidQuote > 0 && largestBid ? largestBid.quote / bidQuote : 0;
  const askConcentration = askQuote > 0 && largestAsk ? largestAsk.quote / askQuote : 0;
  return {
    at: finite(snapshot.at),
    bids,
    asks,
    bidQuote,
    askQuote,
    totalQuote,
    imbalance: totalQuote > 0 ? (bidQuote - askQuote) / totalQuote : 0,
    largestBid,
    largestAsk,
    maxConcentration: Math.max(bidConcentration, askConcentration)
  };
}

function quoteAtPrice(levels, price) {
  if (!(price > 0)) return 0;
  const row = (Array.isArray(levels) ? levels : []).find((item) => Math.abs(item.price / price - 1) < 1e-10);
  return row ? row.quote : 0;
}

function wallDrop(previous, current, side) {
  const wall = side === 'bid' ? previous.largestBid : previous.largestAsk;
  if (!wall || !(wall.quote > 0)) return 0;
  const levels = side === 'bid' ? current.bids : current.asks;
  const nowQuote = quoteAtPrice(levels, wall.price);
  return clamp01(1 - nowQuote / wall.quote);
}

function summarizeTrades(trades) {
  let buyQuote = 0;
  let sellQuote = 0;
  let count = 0;
  for (const trade of Array.isArray(trades) ? trades : []) {
    const price = finite(trade.p ?? trade.price, NaN);
    const qty = finite(trade.q ?? trade.qty, NaN);
    if (!(price > 0 && qty > 0)) continue;
    const quote = price * qty;
    // Binance aggTrades: m=true means buyer is maker, so the aggressive side was a seller.
    if (trade.m === true || trade.buyerIsMaker === true) sellQuote += quote;
    else buyQuote += quote;
    count += 1;
  }
  const totalQuote = buyQuote + sellQuote;
  return {
    count,
    buyQuote,
    sellQuote,
    totalQuote,
    aggressiveBuyRatio: totalQuote > 0 ? buyQuote / totalQuote : 0.5
  };
}

function summarizeKlines(klines) {
  const rows = (Array.isArray(klines) ? klines : [])
    .map((row) => ({
      open: finite(Array.isArray(row) ? row[1] : row && row.open, NaN),
      high: finite(Array.isArray(row) ? row[2] : row && row.high, NaN),
      close: finite(Array.isArray(row) ? row[4] : row && row.close, NaN)
    }))
    .filter((row) => row.open > 0 && row.high > 0 && row.close > 0);
  if (!rows.length) return { returnPct: 0, peakToEndPct: 0 };
  const start = rows[0].open;
  const end = rows[rows.length - 1].close;
  const peak = Math.max(...rows.map((row) => row.high));
  return {
    returnPct: end / start - 1,
    peakToEndPct: end / peak - 1
  };
}

function evaluateManipulationRisk({ depthSnapshots = [], recentTrades = [], recentKlines = [] } = {}, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const books = (Array.isArray(depthSnapshots) ? depthSnapshots : []).map(summarizeDepth).filter((row) => row.totalQuote > 0);
  const flow = summarizeTrades(recentTrades);
  const price = summarizeKlines(recentKlines);

  let maxWallDrop = 0;
  let maxImbalanceJump = 0;
  let imbalanceFlips = 0;
  for (let i = 1; i < books.length; i += 1) {
    const previous = books[i - 1];
    const current = books[i];
    maxWallDrop = Math.max(maxWallDrop, wallDrop(previous, current, 'bid'), wallDrop(previous, current, 'ask'));
    maxImbalanceJump = Math.max(maxImbalanceJump, Math.abs(current.imbalance - previous.imbalance));
    if (Math.sign(previous.imbalance) !== 0 && Math.sign(current.imbalance) !== 0 && Math.sign(previous.imbalance) !== Math.sign(current.imbalance)) imbalanceFlips += 1;
  }

  const maxConcentration = books.length ? Math.max(...books.map((row) => row.maxConcentration)) : 0;
  const minVisibleDepthQuote = books.length ? Math.min(...books.map((row) => Math.min(row.bidQuote, row.askQuote))) : 0;
  const reasons = [];
  let score = 0;

  if (books.length < 3) {
    score += 0.15;
    reasons.push('LIMITED_ORDERBOOK_EVIDENCE');
  }

  if (maxConcentration >= cfg.dominantWallConcentration && maxWallDrop >= cfg.dominantWallDrop) {
    score += 0.35;
    reasons.push('UNSTABLE_DOMINANT_WALL');
  }

  if (maxImbalanceJump >= cfg.imbalanceJump || imbalanceFlips >= 2) {
    score += 0.20;
    reasons.push('ORDERBOOK_IMBALANCE_INSTABILITY');
  }

  if (minVisibleDepthQuote > 0 && minVisibleDepthQuote < cfg.thinVisibleDepthQuote) {
    score += 0.15;
    reasons.push('THIN_VISIBLE_DEPTH');
  }

  if (price.returnPct >= cfg.priceBurstPct && flow.count >= 10 && flow.aggressiveBuyRatio <= cfg.weakAggressiveBuyRatio) {
    score += 0.25;
    reasons.push('PRICE_FLOW_DIVERGENCE');
  }

  if (price.returnPct >= cfg.priceBurstPct && price.peakToEndPct <= cfg.burstRejectionPct) {
    score += 0.20;
    reasons.push('BURST_REJECTION');
  }

  score = clamp01(score);
  const band = score >= cfg.blockScore ? 'HIGH' : score >= cfg.warnScore ? 'MEDIUM' : 'LOW';
  return {
    score,
    band,
    block: score >= cfg.blockScore,
    code: score >= cfg.blockScore ? 'MANIPULATION_RISK_HIGH' : score >= cfg.warnScore ? 'MANIPULATION_RISK_MEDIUM' : 'MANIPULATION_RISK_LOW',
    reason: reasons.length ? reasons.join(',') : 'no material market-integrity anomalies detected',
    metrics: {
      depthSamples: books.length,
      maxConcentration,
      maxWallDrop,
      maxImbalanceJump,
      imbalanceFlips,
      minVisibleDepthQuote,
      tradeCount: flow.count,
      aggressiveBuyRatio: flow.aggressiveBuyRatio,
      aggressiveBuyQuote: flow.buyQuote,
      aggressiveSellQuote: flow.sellQuote,
      recentReturnPct: price.returnPct,
      recentPeakToEndPct: price.peakToEndPct
    }
  };
}

module.exports = {
  DEFAULTS,
  summarizeDepth,
  summarizeTrades,
  summarizeKlines,
  evaluateManipulationRisk
};
