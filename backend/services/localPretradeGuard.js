'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({
  samples: 5,
  sampleIntervalMs: 3500,
  maxLastSpreadPct: 0.006,
  maxMedianSpreadPct: 0.004,
  minEndReturnPct: -0.006,
  minPeakToEndPct: -0.012,
  maxLatencyMs: 1500,
  maxClockSkewMs: 3000
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
    for (let i = 0; i < cfg.samples; i += 1) {
      const book = await fetchJson(`${base}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);
      const bid = Number(book.bidPrice || 0);
      const ask = Number(book.askPrice || 0);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
      rows.push({ at: Date.now(), bid, ask, mid, spreadPct });
      if (i + 1 < cfg.samples) await new Promise((resolve) => setTimeout(resolve, cfg.sampleIntervalMs));
    }

    const decision = evaluateMicrostructure(rows, { latencyMs, clockSkewMs }, cfg);
    persist({
      ts: new Date().toISOString(),
      symbol,
      lane,
      signalPrice: finite(signalPrice),
      currentPrice: finite(currentPrice),
      allow: decision.allow,
      code: decision.code,
      reason: decision.reason,
      metrics: decision.metrics,
      elapsedMs: Date.now() - startedAt
    });
    return decision;
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
