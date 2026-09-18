'use strict';

const {
  DEFAULT_SELECTION_GUARD,
  evaluateProductionCandidate,
  summarizeSelectionRejections
} = require('../services/spotProductionSelection');
const {
  CONFIG: QUBO_V5_CONFIG,
  productionUtility,
  solveHardwareReadyQubo
} = require('../services/spotQuboProductionV5');

const MIN_PCT = 1;
const MAX_PCT = 18;
const MIN_QUOTE_VOLUME = 200000;
const PROBE_CANDIDATES = 100;
const PROBE_CONCURRENCY = 10;
const MAX_QUBO_CANDIDATES = QUBO_V5_CONFIG.qubo.max_candidates;
const V42_MIN_PASS_WINDOWS = 2;
const STABLE_AGENTS = ['EARLY_MOMENTUM', 'BREAKOUT'];
const V42_HIERARCHY = ['VOLUME_IGNITION', 'FRESH_RS_CONFIRM', 'RELATIVE_STRENGTH_EXTENSION'];
const V42_THRESHOLDS = [
  { days: 30, i: 0.904010256302157, c: 0.30262335308700017, e: 0.0333071863419859 },
  { days: 45, i: 0.7912647052581232, c: 0.36672756172128707, e: 0.029510140018270917 },
  { days: 60, i: 1.6626658194027173, c: 0.43305908219072103, e: 0.019614079751271593 }
];

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizedLog(value, floor, ceiling) {
  const v = Number(value) || 0;
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}

function pctFrom(oldValue, newValue) {
  return oldValue > 0 ? (newValue / oldValue) - 1 : 0;
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sumQuote(bars, i, n) {
  let sum = 0;
  for (let k = Math.max(0, i - n + 1); k <= i; k += 1) sum += bars[k].q;
  return sum;
}

function baseUtility(candidate) {
  const pct = Number(candidate.pct) || 0;
  const qv = Number(candidate.qv) || 0;
  const momentum = clamp(pct / 12);
  const liquidity = normalizedLog(qv, MIN_QUOTE_VOLUME, 150000000);
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return momentum * 0.45 + liquidity * 0.30 + freshness * 0.25 - chasePenalty * 0.15;
}

function probeLaneScore(candidate, lane = 'base') {
  const pct = Number(candidate.pct) || 0;
  const liquidity = normalizedLog(candidate.qv, MIN_QUOTE_VOLUME, 150000000);

  if (lane === 'fresh') {
    const freshSweetSpot = clamp(1 - (Math.abs(pct - 2) / 4));
    return freshSweetSpot * 0.65 + liquidity * 0.35;
  }
  if (lane === 'surge') {
    const surgeSweetSpot = clamp(1 - (Math.abs(pct - 9) / 8));
    return surgeSweetSpot * 0.60 + liquidity * 0.40;
  }
  if (lane === 'liquidity') {
    const notExtended = pct <= 12 ? 1 : clamp(1 - ((pct - 12) / 6));
    return liquidity * 0.80 + notExtended * 0.20;
  }
  return baseUtility(candidate);
}

function utility(candidate) {
  return Number(productionUtility({ ...candidate, base_utility: baseUtility(candidate) }, QUBO_V5_CONFIG).toFixed(6));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'proypers25-github-radar-v42/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBinance(rows) {
  return rows.map((row) => ({
    symbol: String(row.symbol || '').toUpperCase(),
    pct: Number(row.priceChangePercent || 0),
    price: Number(row.lastPrice || 0),
    qv: Number(row.quoteVolume || 0),
    source: 'BINANCE'
  }));
}

function normalizeCoinGecko(rows) {
  return rows.map((row) => ({
    symbol: `${String(row.symbol || '').toUpperCase()}USDT`,
    pct: Number(row.price_change_percentage_24h || 0),
    price: Number(row.current_price || 0),
    qv: Number(row.total_volume || 0),
    source: 'COINGECKO_FALLBACK'
  }));
}

function eligibleProbe(rows) {
  const eligible = rows
    .filter((row) => row.symbol.endsWith('USDT'))
    .filter((row) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(row.symbol))
    .filter((row) => row.price > 0 && row.pct >= MIN_PCT && row.pct < MAX_PCT && row.qv >= MIN_QUOTE_VOLUME);

  const lanes = {
    fresh: [...eligible].sort((a, b) => probeLaneScore(b, 'fresh') - probeLaneScore(a, 'fresh')),
    surge: [...eligible].sort((a, b) => probeLaneScore(b, 'surge') - probeLaneScore(a, 'surge')),
    liquidity: [...eligible].sort((a, b) => probeLaneScore(b, 'liquidity') - probeLaneScore(a, 'liquidity')),
    base: [...eligible].sort((a, b) => baseUtility(b) - baseUtility(a))
  };

  const selected = [];
  const seen = new Set();
  function addFrom(pool, quota) {
    let added = 0;
    for (const candidate of pool) {
      if (selected.length >= PROBE_CANDIDATES || added >= quota) break;
      if (seen.has(candidate.symbol)) continue;
      seen.add(candidate.symbol);
      selected.push(candidate);
      added += 1;
    }
  }

  addFrom(lanes.fresh, 30);
  addFrom(lanes.surge, 20);
  addFrom(lanes.liquidity, 20);
  addFrom(lanes.base, 30);
  addFrom(lanes.fresh, PROBE_CANDIDATES - selected.length);
  addFrom(lanes.base, PROBE_CANDIDATES - selected.length);

  return selected.slice(0, PROBE_CANDIDATES);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function klines(symbol, interval, limit) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error('invalid klines');
  return rows.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), q: Number(r[7]), n: Number(r[8]) }));
}

async function stableFeatures(symbol) {
  const bars = await klines(symbol, '15m', 100);
  if (bars.length < 97) throw new Error('insufficient 15m klines');
  const i = bars.length - 2;
  const c = bars[i].c;
  const r1h = pctFrom(bars[i - 4].c, c);
  const r4h = pctFrom(bars[i - 16].c, c);
  const recentVol = avg(bars.slice(i - 3, i + 1).map((x) => x.q));
  const baseVol = avg(bars.slice(i - 31, i - 3).map((x) => x.q));
  const volAccel = baseVol > 0 ? recentVol / baseVol : 1;
  const priorHigh = Math.max(...bars.slice(i - 16, i).map((x) => x.h));
  const breakout = priorHigh > 0 ? c / priorHigh - 1 : 0;
  return { r1h, r4h, volAccel, breakout };
}

function stableScore(f) {
  const logVol = Math.log(Math.max(0.2, f.volAccel));
  const earlyMomentum = 1.8 * f.r1h + 1.1 * f.r4h + 0.25 * logVol;
  const breakout = 2.2 * f.breakout + 0.9 * f.r4h + 0.2 * logVol;
  return { earlyMomentum, breakout, ensemble: earlyMomentum * 0.55 + breakout * 0.45 };
}

async function enrichStable(candidates) {
  const enriched = await mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (candidate) => {
    try {
      const scores = stableScore(await stableFeatures(candidate.symbol));
      return { ...candidate, stable_raw: scores.ensemble, stable_detail: scores };
    } catch (error) {
      console.error(`STABLE_FEATURES_FAILED ${candidate.symbol} ${error.message}`);
      return { ...candidate, stable_raw: NaN, stable_detail: null };
    }
  });
  const valid = enriched.map((x) => x.stable_raw).filter(Number.isFinite);
  if (!valid.length) return enriched.map((x) => ({ ...x, stable_norm: 0.5 }));
  const min = Math.min(...valid), max = Math.max(...valid);
  return enriched.map((x) => ({ ...x, stable_norm: Number.isFinite(x.stable_raw) ? (max > min ? clamp((x.stable_raw - min) / (max - min)) : 0.5) : 0.5 }));
}

function btcContext(bars) {
  const i = bars.length - 2;
  if (i < 48) throw new Error('insufficient BTC 5m context');
  return { t: bars[i].t, r60: pctFrom(bars[i - 12].c, bars[i].c), r240: pctFrom(bars[i - 48].c, bars[i].c) };
}

function v42Features(bars, btc) {
  const i = bars.length - 2;
  if (i < 288) throw new Error('insufficient 5m V4.2 context');
  const c = bars[i].c;
  const r15 = pctFrom(bars[i - 3].c, c);
  const r30 = pctFrom(bars[i - 6].c, c);
  const r60 = pctFrom(bars[i - 12].c, c);
  const r240 = pctFrom(bars[i - 48].c, c);
  const r24 = pctFrom(bars[i - 288].c, c);
  const base = avg(bars.slice(i - 72, i - 12).map((x) => x.q)) * 12;
  const ph60 = Math.max(...bars.slice(i - 12, i).map((x) => x.h));
  const ph240 = Math.max(...bars.slice(i - 48, i).map((x) => x.h));
  return {
    r15, r30, r60, r240, r24,
    vol15: base > 0 ? sumQuote(bars, i, 3) / (base / 4) : 1,
    vol30: base > 0 ? sumQuote(bars, i, 6) / (base / 2) : 1,
    tradeAccel: bars[i].n / Math.max(1, avg(bars.slice(i - 12, i).map((x) => x.n))),
    breakout60: ph60 > 0 ? c / ph60 - 1 : 0,
    breakout240: ph240 > 0 ? c / ph240 - 1 : 0,
    rs60: r60 - btc.r60,
    rs240: r240 - btc.r240
  };
}

function v42Parts(f) {
  const ignition = 0.9 * Math.log(Math.max(0.2, f.vol15)) + 0.65 * Math.log(Math.max(0.2, f.tradeAccel)) + 0.65 * f.r15 + 0.35 * f.breakout60;
  const confirm = 1.2 * f.breakout60 + 0.65 * f.rs60 + 0.35 * Math.log(Math.max(0.2, f.vol30)) - 0.8 * Math.max(0, f.r24 - 0.10) - 0.5 * Math.max(0, f.r60 - 0.06);
  const extension = 1.15 * f.rs60 + 0.75 * f.rs240 + 0.35 * f.r30 + 0.25 * f.breakout240 - 0.45 * Math.max(0, f.r24 - 0.12);
  return { ignition, confirm, extension };
}

function v42PassCount(parts) {
  return V42_THRESHOLDS.filter((th) => parts.ignition >= th.i && parts.confirm >= th.c && parts.extension >= th.e).length;
}

function v42Norm(parts, passCount) {
  const mid = V42_THRESHOLDS[1];
  const ignitionMargin = clamp(0.5 + (parts.ignition - mid.i) / 2.0);
  const confirmMargin = clamp(0.5 + (parts.confirm - mid.c) / 0.8);
  const extensionMargin = clamp(0.5 + (parts.extension - mid.e) / 0.12);
  return clamp((passCount / 3) * 0.55 + ignitionMargin * 0.20 + confirmMargin * 0.15 + extensionMargin * 0.10);
}

async function enrichV42(candidates) {
  let btc;
  try {
    btc = btcContext(await klines('BTCUSDT', '5m', 290));
  } catch (error) {
    console.error(`V42_BTC_CONTEXT_FAILED ${error.message}`);
    return candidates.map((x) => ({ ...x, v42_pass_windows: 0, v42_norm: 0, v42_detail: null }));
  }
  return mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (candidate) => {
    try {
      const bars = await klines(candidate.symbol, '5m', 290);
      const features = v42Features(bars, btc);
      const quboReturns = [];
      const last = bars.length - 2;
      for (let k = Math.max(1, last - 23); k <= last; k += 1) quboReturns.push(pctFrom(bars[k - 1].c, bars[k].c));
      const parts = v42Parts(features);
      const freshEnough = features.r24 < 0.18 && features.r60 < 0.10 && features.r15 < 0.06;
      const passCount = freshEnough ? v42PassCount(parts) : 0;
      return { ...candidate, v42_pass_windows: passCount, v42_norm: freshEnough ? v42Norm(parts, passCount) : 0, v42_detail: { ...parts, r15: features.r15, r60: features.r60, r24: features.r24, freshEnough }, qubo_returns: quboReturns };
    } catch (error) {
      console.error(`V42_FEATURES_FAILED ${candidate.symbol} ${error.message}`);
      return { ...candidate, v42_pass_windows: 0, v42_norm: 0, v42_detail: null, qubo_returns: [] };
    }
  });
}

async function loadMarket() {
  const sources = [
    ['BINANCE_VISION', 'https://data-api.binance.vision/api/v3/ticker/24hr'],
    ['BINANCE_API', 'https://api.binance.com/api/v3/ticker/24hr']
  ];
  for (const [source, url] of sources) {
    try {
      const rows = normalizeBinance(await fetchJson(url));
      return { source, rows };
    } catch (error) {
      console.error(`${source}_FAILED ${error.message}`);
    }
  }
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h';
  return { source: 'COINGECKO_FALLBACK', rows: normalizeCoinGecko(await fetchJson(url)) };
}

async function main() {
  const market = await loadMarket();
  const probe = eligibleProbe(market.rows);
  if (!probe.length) {
    console.log(JSON.stringify({ ok: true, notify: false, source: market.source, mode: 'PRODUCTION_V42_QUBO_V5', reason: 'no base candidates', v42_hierarchy: V42_HIERARCHY }));
    return;
  }

  let candidates = await enrichStable(probe);
  candidates = await enrichV42(candidates);
  const robust = candidates.filter((x) => x.v42_pass_windows >= V42_MIN_PASS_WINDOWS);
  if (!robust.length) {
    console.log(JSON.stringify({ ok: true, notify: false, source: market.source, mode: 'PRODUCTION_V42_QUBO_V5', reason: 'no candidate passed V4.2 in at least 2/3 trained windows', v42_hierarchy: V42_HIERARCHY, probed: candidates.length, probe_strategy: 'DIVERSIFIED_EARLY_MOMENTUM_100' }));
    return;
  }

  const evaluated = robust.map((candidate) => ({
    ...candidate,
    selection_gate: evaluateProductionCandidate(candidate)
  }));
  const productionCandidates = evaluated.filter((candidate) => candidate.selection_gate.ok);
  const rejected = evaluated.filter((candidate) => !candidate.selection_gate.ok);
  const selectionRejections = summarizeSelectionRejections(rejected);

  if (!productionCandidates.length) {
    console.log(JSON.stringify({
      ok: true,
      notify: false,
      source: market.source,
      mode: 'PRODUCTION_V42_QUBO_V5',
      reason: 'no V4.2 candidate passed production quality gate',
      probe_strategy: 'DIVERSIFIED_EARLY_MOMENTUM_100',
      probed: candidates.length,
      robust_candidates: robust.length,
      production_candidates: 0,
      selection_rejections: selectionRejections,
      selection_guard: DEFAULT_SELECTION_GUARD,
      v42_hierarchy: V42_HIERARCHY,
      v42_min_pass_windows: V42_MIN_PASS_WINDOWS
    }));
    return;
  }

  productionCandidates.sort((a, b) => utility(b) - utility(a));
  const quboPool = productionCandidates.slice(0, MAX_QUBO_CANDIDATES);
  const decision = solveHardwareReadyQubo(quboPool, QUBO_V5_CONFIG);
  const selected = [...decision.selected].sort((a, b) => utility(b) - utility(a));
  const candidate = selected[0];
  if (!candidate) {
    console.log(JSON.stringify({
      ok: true,
      notify: false,
      source: market.source,
      mode: 'PRODUCTION_V42_QUBO_V5',
      reason: 'QUBO selected none',
      probe_strategy: 'DIVERSIFIED_EARLY_MOMENTUM_100',
      robust_candidates: robust.length,
      production_candidates: productionCandidates.length,
      selection_rejections: selectionRejections,
      selection_guard: DEFAULT_SELECTION_GUARD
    }));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    notify: true,
    mode: 'PRODUCTION_V42_QUBO_V5',
    source: market.source,
    probe_strategy: 'DIVERSIFIED_EARLY_MOMENTUM_100',
    probed: candidates.length,
    robust_candidates: robust.length,
    production_candidates: productionCandidates.length,
    selection_rejections: selectionRejections,
    selection_guard: DEFAULT_SELECTION_GUARD,
    selection_gate: candidate.selection_gate,
    qubo_method: decision.method,
    qubo_objective: decision.objective,
    qubo_selected_symbols: selected.map((item) => item.symbol),
    qubo_model_version: decision.model_version,
    qubo_hardware_ready: decision.hardware_ready,
    qubo_hardware_schema: decision.hardware_schema,
    qubo_solver: decision.solver,
    qubo_model_stats: decision.model_stats,
    stable_agents: STABLE_AGENTS,
    v42_hierarchy: V42_HIERARCHY,
    v42_min_pass_windows: V42_MIN_PASS_WINDOWS,
    symbol: candidate.symbol,
    pct: candidate.pct,
    price: candidate.price,
    quote_volume: candidate.qv,
    base_utility: Number(baseUtility(candidate).toFixed(6)),
    stable_score: Number.isFinite(candidate.stable_raw) ? Number(candidate.stable_raw.toFixed(6)) : null,
    stable_norm: candidate.stable_norm,
    v42_pass_windows: candidate.v42_pass_windows,
    v42_norm: Number(candidate.v42_norm.toFixed(6)),
    v42_detail: candidate.v42_detail,
    utility: utility(candidate)
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});