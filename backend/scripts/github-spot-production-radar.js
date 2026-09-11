'use strict';

const MIN_PCT = 1;
const MAX_PCT = 18;
const MIN_QUOTE_VOLUME = 200000;
const MAX_QUBO_CANDIDATES = 10;
const MAX_SELECTED = 3;
const STABLE_AGENTS = ['EARLY_MOMENTUM', 'BREAKOUT'];

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizedLog(value, floor, ceiling) {
  const v = Number(value) || 0;
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
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

function utility(candidate) {
  const base = baseUtility(candidate);
  const trained = Number.isFinite(candidate.trained_norm) ? candidate.trained_norm : 0.5;
  return Number((base * 0.65 + trained * 0.35).toFixed(6));
}

function pairPenalty(a, b) {
  const distance = Math.abs((Number(a.pct) || 0) - (Number(b.pct) || 0));
  return distance <= 1.5 ? 0.025 : 0;
}

function objective(selected) {
  let score = selected.reduce((sum, item) => sum + utility(item), 0);
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) score -= pairPenalty(selected[i], selected[j]);
  }
  return Number(score.toFixed(6));
}

function exactQubo(candidates) {
  const size = Math.min(candidates.length, MAX_QUBO_CANDIDATES);
  let best = [];
  let bestScore = -Infinity;
  for (let mask = 1; mask < (1 << size); mask += 1) {
    const selected = [];
    for (let i = 0; i < size; i += 1) if (mask & (1 << i)) selected.push(candidates[i]);
    if (selected.length > MAX_SELECTED) continue;
    const score = objective(selected);
    if (score > bestScore) {
      bestScore = score;
      best = selected;
    }
  }
  return { method: 'LOCAL_QUBO_EXACT_PRODUCTION', objective: bestScore, selected: best };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'proypers25-github-radar/1.1' } });
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

function eligible(rows) {
  return rows
    .filter((row) => row.symbol.endsWith('USDT'))
    .filter((row) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(row.symbol))
    .filter((row) => row.price > 0 && row.pct >= MIN_PCT && row.pct < MAX_PCT && row.qv >= MIN_QUOTE_VOLUME)
    .sort((a, b) => baseUtility(b) - baseUtility(a))
    .slice(0, MAX_QUBO_CANDIDATES);
}

function pctFrom(oldValue, newValue) {
  return oldValue > 0 ? (newValue / oldValue) - 1 : 0;
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function historicalFeatures(symbol) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=100`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length < 97) throw new Error('insufficient klines');
  const bars = rows.map((r) => ({ h: Number(r[2]), c: Number(r[4]), q: Number(r[7]) }));
  const i = bars.length - 1;
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

function stableAgentScore(f) {
  const logVol = Math.log(Math.max(0.2, f.volAccel));
  const earlyMomentum = 1.8 * f.r1h + 1.1 * f.r4h + 0.25 * logVol;
  const breakout = 2.2 * f.breakout + 0.9 * f.r4h + 0.2 * logVol;
  // Both agents were positive and champions in 4/4 historical windows.
  return { earlyMomentum, breakout, ensemble: earlyMomentum * 0.55 + breakout * 0.45 };
}

async function enrichWithStableAgents(candidates) {
  const enriched = await Promise.all(candidates.map(async (candidate) => {
    try {
      const f = await historicalFeatures(candidate.symbol);
      const scores = stableAgentScore(f);
      return { ...candidate, trained_raw: scores.ensemble, trained_detail: scores };
    } catch (error) {
      console.error(`STABLE_AGENT_FEATURES_FAILED ${candidate.symbol} ${error.message}`);
      return { ...candidate, trained_raw: NaN, trained_detail: null };
    }
  }));

  const valid = enriched.map((x) => x.trained_raw).filter(Number.isFinite);
  if (!valid.length) return enriched.map((x) => ({ ...x, trained_norm: 0.5 }));
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return enriched.map((x) => ({
    ...x,
    trained_norm: Number.isFinite(x.trained_raw) ? (max > min ? clamp((x.trained_raw - min) / (max - min)) : 0.5) : 0.5
  }));
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
  const baseCandidates = eligible(market.rows);
  if (!baseCandidates.length) {
    console.log(JSON.stringify({ ok: true, notify: false, source: market.source, mode: 'PRODUCTION', qubo: 'LOCAL_QUBO_EXACT_PRODUCTION', stable_agents: STABLE_AGENTS }));
    return;
  }

  const candidates = await enrichWithStableAgents(baseCandidates);
  candidates.sort((a, b) => utility(b) - utility(a));
  const decision = exactQubo(candidates);
  const selected = [...decision.selected].sort((a, b) => utility(b) - utility(a));
  const candidate = selected[0];
  console.log(JSON.stringify({
    ok: true,
    notify: true,
    mode: 'PRODUCTION',
    source: market.source,
    qubo_method: decision.method,
    qubo_objective: decision.objective,
    qubo_selected_symbols: selected.map((item) => item.symbol),
    stable_agents: STABLE_AGENTS,
    stable_agent_weight: 0.35,
    symbol: candidate.symbol,
    pct: candidate.pct,
    price: candidate.price,
    quote_volume: candidate.qv,
    base_utility: Number(baseUtility(candidate).toFixed(6)),
    trained_score: Number.isFinite(candidate.trained_raw) ? Number(candidate.trained_raw.toFixed(6)) : null,
    trained_norm: candidate.trained_norm,
    utility: utility(candidate)
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
