'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateManipulationRisk } = require('./marketManipulationRisk');
const { momentumContinuationFactor } = require('./spotMomentumContinuation');

const DEFAULTS = Object.freeze({
  samples: 7,
  sampleIntervalMs: 15000,
  maxLastSpreadPct: 0.006,
  maxMedianSpreadPct: 0.004,
  minEndReturnPct: -0.006,
  minPeakToEndPct: -0.012,
  maxLatencyMs: 1500,
  maxClockSkewMs: 3000,
  minContinuationScore: 0
});

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function median(values) {
  const rows = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return NaN;
  const i = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[i] : (rows[i - 1] + rows[i]) / 2;
}

function evaluateMicrostructure(samples, health = {}, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const rows = (Array.isArray(samples) ? samples : [])
    .map((row) => ({
      at: Number(row.at || 0),
      bid: finite(row.bid, NaN),
      ask: finite(row.ask, NaN),
      mid: finite(row.mid, NaN),
      spreadPct: finite(row.spreadPct, NaN)
    }))
    .filter((row) => row.mid > 0 && row.bid > 0 && row.ask >= row.bid && Number.isFinite(row.spreadPct));

  const reasons = [];
  if (rows.length < 3) reasons.push('INSUFFICIENT_MICRO_SAMPLES');

  const mids = rows.map((row) => row.mid);
  const spreads = rows.map((row) => row.spreadPct);
  const startMid = mids[0] || NaN;
  const endMid = mids[mids.length - 1] || NaN;
  const peakMid = mids.length ? Math.max(...mids) : NaN;
  const endReturnPct = startMid > 0 && endMid > 0 ? endMid / startMid - 1 : NaN;
  const peakToEndPct = peakMid > 0 && endMid > 0 ? endMid / peakMid - 1 : NaN;
  const lastSpreadPct = spreads.length ? spreads[spreads.length - 1] : NaN;
  const medianSpreadPct = median(spreads);
  const latencyMs = finite(health.latencyMs, Infinity);
  const clockSkewMs = Math.abs(finite(health.clockSkewMs, Infinity));

  if (latencyMs > cfg.maxLatencyMs) reasons.push('LOCAL_BINANCE_LATENCY');
  if (clockSkewMs > cfg.maxClockSkewMs) reasons.push('LOCAL_CLOCK_SKEW');
  if (Number.isFinite(lastSpreadPct) && lastSpreadPct > cfg.maxLastSpreadPct) reasons.push('WIDE_SPREAD');
  if (Number.isFinite(medianSpreadPct) && medianSpreadPct > cfg.maxMedianSpreadPct) reasons.push('PERSISTENT_WIDE_SPREAD');
  if (Number.isFinite(endReturnPct) && endReturnPct < cfg.minEndReturnPct) reasons.push('MICRO_REVERSAL');
  if (Number.isFinite(peakToEndPct) && peakToEndPct < cfg.minPeakToEndPct) reasons.push('MICRO_PEAK_REJECTION');

  return {
    allow: reasons.length === 0,
    code: reasons.length ? reasons[0] : 'LOCAL_MICRO_OK',
    reason: reasons.length ? reasons.join(',') : 'local microstructure healthy',
    metrics: {
      samples: rows.length,
      startMid,
      endMid,
      endReturnPct,
      peakToEndPct,
      lastSpreadPct,
      medianSpreadPct,
      latencyMs,
      clockSkewMs
    }
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.msg || response.statusText}`);
  return body;
}

function memoryPath() {
  return path.join(os.homedir(), '.proypers25', 'local-pretrade-memory.jsonl');
}

function persist(record) {
  try {
    const file = memoryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    const stat = fs.statSync(file);
    if (stat.size > 5 * 1024 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-3000);
      fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    }
  } catch (error) {
    console.warn(`LOCAL_PRETRADE_MEMORY_WARN ${error.message || error}`);
  }
}

async function runLocalPretradeGuard({ base, symbol, signalPrice, currentPrice, lane = 'CORE', config = {} }) {
  const startedAt = Date.now();
  try {
    const timeStarted = Date.now();
    const server = await fetchJson(`${base}/api/v3/time`);
    const timeFinished = Date.now();
    const latencyMs = timeFinished - timeStarted;
    const estimatedServerNow = Number(server.serverTime || 0) + latencyMs / 2;
    const clockSkewMs = estimatedServerNow > 0 ? Date.now() - estimatedServerNow : Infinity;

    const cfg = { ...DEFAULTS, ...config };
    const rows = [];
    const depthSnapshots = [];
    for (let i = 0; i < cfg.samples; i += 1) {
      const [book, depth] = await Promise.all([
        fetchJson(`${base}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`),
        fetchJson(`${base}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=20`)
      ]);
      const bid = Number(book.bidPrice || 0);
      const ask = Number(book.askPrice || 0);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
      const at = Date.now();
      rows.push({ at, bid, ask, mid, spreadPct });
      depthSnapshots.push({ at, bids: depth.bids || [], asks: depth.asks || [] });
      if (i + 1 < cfg.samples) await new Promise((resolve) => setTimeout(resolve, cfg.sampleIntervalMs));
    }

    const [recentTrades, recentKlines, btcKlines, ticker24h] = await Promise.all([
      fetchJson(`${base}/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=120`),
      fetchJson(`${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=70`),
      fetchJson(`${base}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=70`),
      fetchJson(`${base}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`)
    ]);

    const micro = evaluateMicrostructure(rows, { latencyMs, clockSkewMs }, cfg);
    const integrity = evaluateManipulationRisk({ depthSnapshots, recentTrades, recentKlines });
    const k = Array.isArray(recentKlines) ? recentKlines : [];
    const b = Array.isArray(btcKlines) ? btcKlines : [];
    const last = k.length - 2;
    const blast = b.length - 2;
    let continuation = { score: NaN, pass: false, components: {} };
    if (last >= 60 && blast >= 60) {
      const close = (arr, i) => Number(arr[i]?.[4] || 0);
      const quote = (arr, i) => Number(arr[i]?.[7] || 0);
      const high = (arr, i) => Number(arr[i]?.[2] || 0);
      const ret = (a, z) => a > 0 && z > 0 ? z / a - 1 : 0;
      const c = close(k, last);
      const r15 = ret(close(k, last - 15), c);
      const r60 = ret(close(k, last - 60), c);
      const btcR60 = ret(close(b, blast - 60), close(b, blast));
      const q15 = k.slice(last - 14, last + 1).reduce((s,row)=>s+Number(row?.[7]||0),0);
      const q30 = k.slice(last - 29, last + 1).reduce((s,row)=>s+Number(row?.[7]||0),0);
      const prior60 = Math.max(...k.slice(last - 60, last).map(row=>Number(row?.[2]||0)));
      continuation = momentumContinuationFactor({
        r15,
        r60,
        r24: Number(ticker24h?.priceChangePercent || 0) / 100,
        vol15: q30 > 0 ? q15 / (q30 / 2) : 1,
        vol30: 1,
        breakout60: prior60 > 0 ? c / prior60 - 1 : 0,
        rs60: r60 - btcR60
      });
    }

    const continuationPass = Number.isFinite(continuation.score) && continuation.score > cfg.minContinuationScore;
    const allow = micro.allow && !integrity.block && continuationPass;
    const code = !micro.allow
      ? micro.code
      : integrity.block
        ? integrity.code
        : !continuationPass
          ? 'MOMENTUM_CONTINUATION_WEAK'
          : micro.code;
    const reason = !micro.allow
      ? micro.reason
      : integrity.block
        ? `${integrity.code}:${integrity.reason}`
        : !continuationPass
          ? `MOMENTUM_CONTINUATION_WEAK score=${Number.isFinite(continuation.score) ? continuation.score.toFixed(4) : 'unavailable'}`
          : `${micro.reason}; continuation=${continuation.score.toFixed(4)}; manipulation_risk=${integrity.score.toFixed(3)}(${integrity.band})`;
    const metrics = {
      ...micro.metrics,
      continuationScore: continuation.score,
      continuationPass,
      continuationComponents: continuation.components,
      manipulationRisk: integrity.score,
      manipulationBand: integrity.band,
      manipulationReason: integrity.reason,
      manipulationMetrics: integrity.metrics
    };

    persist({
      ts: new Date().toISOString(),
      symbol,
      lane,
      signalPrice: finite(signalPrice),
      currentPrice: finite(currentPrice),
      allow,
      code,
      reason,
      metrics,
      elapsedMs: Date.now() - startedAt
    });
    return { allow, code, reason, metrics };
  } catch (error) {
    const reason = `MICROVALIDATION_UNAVAILABLE:${error.message || error}`;
    const decision = { allow: false, code: 'MICROVALIDATION_UNAVAILABLE', reason, metrics: { elapsedMs: Date.now() - startedAt } };
    persist({ ts: new Date().toISOString(), symbol, lane, signalPrice: finite(signalPrice), currentPrice: finite(currentPrice), allow: false, code: decision.code, reason });
    return decision;
  }
}

module.exports = {
  DEFAULTS,
  evaluateMicrostructure,
  runLocalPretradeGuard,
  memoryPath
};
