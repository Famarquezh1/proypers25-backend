/**
 * Auditoria de edge para senales event-driven.
 * Solo lectura: no modifica prediccion, thresholds ni quality gate.
 *
 * Uso:
 *   node backend/scripts/audit-event-edge.js
 *
 * Env opcionales:
 *   AUDIT_EDGE_DAYS=30
 *   AUDIT_EDGE_MAX_SIGNALS=200
 *   AUDIT_EDGE_MIN_SIGNALS=30
 *   AUDIT_EDGE_CONCURRENCY=3
 */

const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const INTERVAL = '1m';
const WINDOW_SECONDS = 300;
const HORIZONS = [10, 30, 60, 120, 300];
const ENTRY_DELAYS = [0, 10, 20, 30, 60];

const AUDIT_EDGE_DAYS = Number(process.env.AUDIT_EDGE_DAYS || 30);
const AUDIT_EDGE_MAX_SIGNALS = Number(process.env.AUDIT_EDGE_MAX_SIGNALS || 200);
const AUDIT_EDGE_MIN_SIGNALS = Number(process.env.AUDIT_EDGE_MIN_SIGNALS || 30);
const AUDIT_EDGE_CONCURRENCY = Math.max(1, Number(process.env.AUDIT_EDGE_CONCURRENCY || 3));

function toBinanceSymbol(systemSymbol) {
  const clean = (systemSymbol || '').toUpperCase().replace('/', '').replace('-', '');
  if (clean.endsWith('USDT')) return clean;
  if (clean.endsWith('USD')) return clean.slice(0, -3) + 'USDT';
  return clean ? `${clean}USDT` : '';
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function bar(v) {
  const value = safeNum(v, 0);
  const scale = Math.min(40, Math.round(Math.abs(value) * 1000)); // 0.1% = 1 bloque
  const blocks = '#'.repeat(scale);
  return value >= 0 ? blocks : `-${blocks}`;
}

function parseDateAny(raw) {
  if (!raw) return null;
  const d = typeof raw?.toDate === 'function' ? raw.toDate() : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function outcomeLabel(signal) {
  const raw =
    signal?.verification?.verification_outcome ||
    signal?.verification?.outcome_label ||
    signal?.verification_outcome ||
    '';
  const value = String(raw).toUpperCase();
  if (value.includes('WIN') || value === 'VALIDADO') return 'WIN';
  if (value.includes('LOSS') || value === 'FALLIDO') return 'LOSS';
  return 'UNKNOWN';
}

async function fetchKlinesRange(symbol, startMs, endMs) {
  const binanceSymbol = toBinanceSymbol(symbol);
  if (!binanceSymbol) return [];

  const url = `${BINANCE_KLINES_URL}?symbol=${encodeURIComponent(binanceSymbol)}&interval=${INTERVAL}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance status ${response.status} for ${binanceSymbol}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    openTime: Number(r[0]),
    open: safeNum(r[1]),
    high: safeNum(r[2]),
    low: safeNum(r[3]),
    close: safeNum(r[4]),
    volume: safeNum(r[5]),
    closeTime: Number(r[6])
  }));
}

function firstCloseAtOrAfter(candles, targetMs) {
  const row = candles.find((c) => c.closeTime >= targetMs);
  return row ? row.close : null;
}

function classifyRegime(candlesBefore) {
  if (!candlesBefore.length) return 'range';
  const closes = candlesBefore.map((c) => c.close).filter((v) => v > 0);
  if (closes.length < 5) return 'range';

  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const vol = Math.sqrt(mean(returns.map((r) => r * r))); // rough sigma
  const trend = Math.abs((closes[closes.length - 1] - closes[0]) / closes[0]);

  if (vol >= 0.006) return 'high_volatility';
  if (vol <= 0.002) return 'low_volatility';
  if (trend >= 0.008) return 'trend';
  return 'range';
}

function analyzeSignal(signal, candles) {
  const t0 = signal.signalTimeMs;
  const p0 = signal.entryPrice;
  if (!t0 || !p0 || !candles.length) return null;

  const after = candles.filter((c) => c.closeTime >= t0 && c.openTime <= t0 + WINDOW_SECONDS * 1000 + 60_000);
  if (!after.length) return null;

  const direction = signal.direction;
  const multiplier = direction === 'down' ? -1 : 1;

  // Event return curve (aprox con velas 1m)
  const returnsByHorizon = {};
  for (const h of HORIZONS) {
    const ph = firstCloseAtOrAfter(after, t0 + h * 1000);
    if (!ph) continue;
    returnsByHorizon[h] = multiplier * ((ph - p0) / p0);
  }

  // MFE / MAE en 5 minutos
  const within5m = after.filter((c) => c.openTime <= t0 + WINDOW_SECONDS * 1000);
  if (!within5m.length) return null;
  const maxHigh = Math.max(...within5m.map((c) => c.high));
  const minLow = Math.min(...within5m.map((c) => c.low));
  const mfe = direction === 'down' ? (p0 - minLow) / p0 : (maxHigh - p0) / p0;
  const mae = direction === 'down' ? (maxHigh - p0) / p0 : (p0 - minLow) / p0;

  // Entry delay test
  const delayedReturns = {};
  const p300 = firstCloseAtOrAfter(after, t0 + 300 * 1000);
  for (const d of ENTRY_DELAYS) {
    const pd = firstCloseAtOrAfter(after, t0 + d * 1000);
    if (!pd || !p300) continue;
    delayedReturns[d] = multiplier * ((p300 - pd) / pd);
  }

  // Lead time (impulso >= 0.4% + volumen relativo alto)
  const impulseThreshold = 0.004;
  let leadTimeSec = null;
  for (let i = 1; i < within5m.length; i += 1) {
    const current = within5m[i];
    const prev = within5m.slice(Math.max(0, i - 5), i);
    const avgVol = prev.length ? mean(prev.map((c) => c.volume)) : 0;
    const volRel = avgVol > 0 ? current.volume / avgVol : 0;
    const favorableMove =
      direction === 'down'
        ? (p0 - current.low) / p0
        : (current.high - p0) / p0;
    if (favorableMove >= impulseThreshold && volRel >= 1.3) {
      leadTimeSec = Math.max(0, Math.round((current.openTime - t0) / 1000));
      break;
    }
  }

  // Regimen con 30 velas previas
  const before = candles.filter((c) => c.closeTime < t0).slice(-30);
  const regime = classifyRegime(before);

  return {
    id: signal.id,
    symbol: signal.symbol,
    direction,
    outcome: signal.outcome,
    returnsByHorizon,
    mfe,
    mae,
    delayedReturns,
    leadTimeSec,
    regime
  };
}

async function loadSignals() {
  const from = new Date(Date.now() - AUDIT_EDGE_DAYS * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const byId = new Map();

  try {
    const snapshotByCreatedAt = await firestore
      .collection('velas_predicciones')
      .where('created_at', '>=', from)
      .limit(AUDIT_EDGE_MAX_SIGNALS * 6)
      .get();
    snapshotByCreatedAt.docs.forEach((doc) => byId.set(doc.id, doc));
  } catch (_err) {
    // ignore: some datasets store created_at as string
  }

  try {
    const snapshotByTimestamp = await firestore
      .collection('velas_predicciones')
      .where('timestamp', '>=', fromIso)
      .limit(AUDIT_EDGE_MAX_SIGNALS * 6)
      .get();
    snapshotByTimestamp.docs.forEach((doc) => byId.set(doc.id, doc));
  } catch (_err) {
    // ignore
  }

  const rows = [];
  const docs = Array.from(byId.values()).sort((a, b) => {
    const ta = parseDateAny(a.data()?.created_at || a.data()?.timestamp || a.data()?.ahora)?.getTime() || 0;
    const tb = parseDateAny(b.data()?.created_at || b.data()?.timestamp || b.data()?.ahora)?.getTime() || 0;
    return tb - ta;
  });

  for (const doc of docs) {
    const d = doc.data() || {};
    const signalEmitted = d.signal_emitted === true;
    const direction = String(d.direction || '').toLowerCase();
    if (!signalEmitted) continue;
    if (direction !== 'up' && direction !== 'down') continue;

    const createdAt = parseDateAny(d.created_at || d.timestamp || d.ahora);
    const entryPrice = safeNum(d.spot_price ?? d.precio_actual ?? d.precio_estimado);
    if (!createdAt || !entryPrice) continue;

    rows.push({
      id: doc.id,
      symbol: (d.simbolo || d.simbolo_normalizado || '').toUpperCase(),
      direction,
      signalTimeMs: createdAt.getTime(),
      entryPrice,
      outcome: outcomeLabel(d)
    });
    if (rows.length >= AUDIT_EDGE_MAX_SIGNALS) break;
  }
  return rows;
}

async function mapWithConcurrency(items, concurrency, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function aggregateCurves(analyzed, direction) {
  const subset = analyzed.filter((x) => x.direction === direction);
  const curve = {};
  for (const h of HORIZONS) {
    const vals = subset.map((x) => x.returnsByHorizon[h]).filter((v) => Number.isFinite(v));
    curve[h] = vals.length ? mean(vals) : 0;
  }
  return { n: subset.length, curve };
}

function aggregateDelay(analyzed) {
  const out = {};
  for (const d of ENTRY_DELAYS) {
    const vals = analyzed.map((x) => x.delayedReturns[d]).filter((v) => Number.isFinite(v));
    out[d] = vals.length ? mean(vals) : 0;
  }
  return out;
}

function aggregateMfeMae(analyzed) {
  const mfe = analyzed.map((x) => x.mfe).filter((v) => Number.isFinite(v));
  const mae = analyzed.map((x) => x.mae).filter((v) => Number.isFinite(v));
  return {
    mfe: {
      avg: mean(mfe),
      med: quantile(mfe, 0.5),
      p75: quantile(mfe, 0.75),
      p90: quantile(mfe, 0.9)
    },
    mae: {
      avg: mean(mae),
      med: quantile(mae, 0.5),
      p75: quantile(mae, 0.75),
      p90: quantile(mae, 0.9)
    }
  };
}

function aggregateLeadTime(analyzed) {
  const values = analyzed.map((x) => x.leadTimeSec).filter((v) => Number.isFinite(v));
  if (!values.length) return { count: 0, avg: 0, med: 0, p75: 0 };
  return {
    count: values.length,
    avg: mean(values),
    med: quantile(values, 0.5),
    p75: quantile(values, 0.75)
  };
}

function aggregateByRegime(analyzed) {
  const map = new Map();
  for (const row of analyzed) {
    if (!map.has(row.regime)) {
      map.set(row.regime, []);
    }
    map.get(row.regime).push(row);
  }
  return Array.from(map.entries()).map(([regime, list]) => {
    const r300 = list.map((x) => x.returnsByHorizon[300]).filter((v) => Number.isFinite(v));
    const wins = list.filter((x) => x.outcome === 'WIN').length;
    const losses = list.filter((x) => x.outcome === 'LOSS').length;
    return {
      regime,
      n: list.length,
      avg_return_300s: mean(r300),
      win_rate: wins + losses > 0 ? wins / (wins + losses) : 0
    };
  });
}

function printCurve(label, curveData) {
  console.log(`\n${label} (n=${curveData.n})`);
  const table = HORIZONS.map((h) => ({
    horizon: `t+${h}s`,
    avg_return: pct(curveData.curve[h] || 0),
    chart: bar(curveData.curve[h] || 0)
  }));
  console.table(table);
}

async function run() {
  console.log('=== Audit Edge Event-Driven (solo lectura) ===');
  console.log(`Window: ultimos ${AUDIT_EDGE_DAYS} dias`);
  console.log(`Max senales: ${AUDIT_EDGE_MAX_SIGNALS}`);

  const signals = await loadSignals();
  if (signals.length < AUDIT_EDGE_MIN_SIGNALS) {
    console.log(`Senales emitidas insuficientes: ${signals.length} (min recomendado ${AUDIT_EDGE_MIN_SIGNALS})`);
  } else {
    console.log(`Senales emitidas cargadas: ${signals.length}`);
  }

  const analyzed = [];
  await mapWithConcurrency(signals, AUDIT_EDGE_CONCURRENCY, async (signal) => {
    try {
      const startMs = signal.signalTimeMs - 40 * 60 * 1000;
      const endMs = signal.signalTimeMs + 7 * 60 * 1000;
      const candles = await fetchKlinesRange(signal.symbol, startMs, endMs);
      const row = analyzeSignal(signal, candles);
      if (row) analyzed.push(row);
    } catch (err) {
      // silencioso por symbol para no contaminar mucho la salida
    }
  });

  console.log('\n1) Tabla resumen');
  console.table({
    signals_loaded: signals.length,
    signals_analyzed: analyzed.length,
    long_count: analyzed.filter((x) => x.direction === 'up').length,
    short_count: analyzed.filter((x) => x.direction === 'down').length
  });

  console.log('\n2) Event Return Curve');
  const longCurve = aggregateCurves(analyzed, 'up');
  const shortCurve = aggregateCurves(analyzed, 'down');
  printCurve('LONG', longCurve);
  printCurve('SHORT', shortCurve);

  console.log('\n3) Distribucion MFE / MAE');
  const mfeMae = aggregateMfeMae(analyzed);
  console.table({
    mfe_avg: pct(mfeMae.mfe.avg),
    mfe_med: pct(mfeMae.mfe.med),
    mfe_p75: pct(mfeMae.mfe.p75),
    mfe_p90: pct(mfeMae.mfe.p90),
    mae_avg: pct(mfeMae.mae.avg),
    mae_med: pct(mfeMae.mae.med),
    mae_p75: pct(mfeMae.mae.p75),
    mae_p90: pct(mfeMae.mae.p90)
  });

  console.log('\n4) Entry Delay Test (retorno medio a t+300s)');
  const delays = aggregateDelay(analyzed);
  console.table(
    ENTRY_DELAYS.map((d) => ({
      entry_delay: `t+${d}s`,
      avg_return_300s: pct(delays[d] || 0),
      chart: bar(delays[d] || 0)
    }))
  );

  console.log('\n5) Lead Time');
  const lead = aggregateLeadTime(analyzed);
  console.table({
    lead_samples: lead.count,
    lead_avg_sec: lead.avg.toFixed(1),
    lead_med_sec: lead.med.toFixed(1),
    lead_p75_sec: lead.p75.toFixed(1)
  });

  console.log('\n6) Resultados por regimen');
  const byRegime = aggregateByRegime(analyzed);
  console.table(
    byRegime.map((x) => ({
      regime: x.regime,
      n: x.n,
      avg_return_300s: pct(x.avg_return_300s),
      win_rate: pct(x.win_rate)
    }))
  );

  // Sugerencia execution layer basada en cuantiles observados.
  const tpRecommended = Math.max(0.002, Math.min(0.02, mfeMae.mfe.med));
  const slRecommended = Math.max(0.0015, Math.min(0.02, mfeMae.mae.p75));
  const bestDelay = ENTRY_DELAYS.reduce((best, d) => (delays[d] > delays[best] ? d : best), ENTRY_DELAYS[0]);
  const longPeak = HORIZONS.reduce((best, h) => (longCurve.curve[h] > longCurve.curve[best] ? h : best), HORIZONS[0]);
  const shortPeak = HORIZONS.reduce((best, h) => (shortCurve.curve[h] > shortCurve.curve[best] ? h : best), HORIZONS[0]);
  const horizonRecommendedSec = Math.round((longPeak + shortPeak) / 2);

  console.log('\n7) Sugerencia de execution layer (data-driven, no aplicada)');
  console.table({
    tp_recomendado: pct(tpRecommended),
    sl_recomendado: pct(slRecommended),
    rr_estimado: (tpRecommended / Math.max(slRecommended, 1e-6)).toFixed(2),
    entry_delay_recomendado_seg: bestDelay,
    horizonte_recomendado_seg: horizonRecommendedSec
  });

  console.log('\nNota metodologica: t+10s/t+30s se aproximan con vela de 1m por disponibilidad historica OHLC en Binance.');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Error audit-event-edge:', err);
    process.exit(1);
  });
}

module.exports = { run };
