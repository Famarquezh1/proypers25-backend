'use strict';

const MIN_PCT = 1;
const MAX_PCT = 18;
const MIN_QUOTE_VOLUME = 200000;
const MAX_QUBO_CANDIDATES = 10;
const MAX_SELECTED = 3;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizedLog(value, floor, ceiling) {
  const v = Number(value) || 0;
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}

function utility(candidate) {
  const pct = Number(candidate.pct) || 0;
  const qv = Number(candidate.qv) || 0;
  const momentum = clamp(pct / 12);
  const liquidity = normalizedLog(qv, MIN_QUOTE_VOLUME, 150000000);
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return Number((momentum * 0.45 + liquidity * 0.30 + freshness * 0.25 - chasePenalty * 0.15).toFixed(6));
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
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'proypers25-github-radar/1.0' } });
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
    .sort((a, b) => utility(b) - utility(a))
    .slice(0, MAX_QUBO_CANDIDATES);
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
  const candidates = eligible(market.rows);
  if (!candidates.length) {
    console.log(JSON.stringify({ ok: true, notify: false, source: market.source, mode: 'PRODUCTION', qubo: 'LOCAL_QUBO_EXACT_PRODUCTION' }));
    return;
  }
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
    symbol: candidate.symbol,
    pct: candidate.pct,
    price: candidate.price,
    quote_volume: candidate.qv,
    utility: utility(candidate)
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
