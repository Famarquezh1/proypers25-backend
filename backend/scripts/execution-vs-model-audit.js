/**
 * execution-vs-model-audit.js
 *
 * Read-only audit for:
 * 1) emitted-signal model edge
 * 2) suppressed-signal impact
 * 3) real execution quality vs model
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { fetchBinanceCandles } = require('../services/dataSources/binance');
const {
  classifyTradesAgainstSignals,
  buildExecutionDisciplineMetrics
} = require('../lib/signal_adherence_monitor');
const { run: runSuppressedValidationAudit } = require('./validate-suppressed-signals');

const db = new Firestore();

const DEFAULT_DAYS = Math.max(1, Number(process.env.AUDIT_DAYS || 30));
const DEFAULT_MAX_DOCS = Math.max(1, Number(process.env.AUDIT_MAX_DOCS || 500));
const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.AUDIT_CONCURRENCY || 6));
const DEFAULT_MATCH_WINDOW_MINUTES = Math.max(1, Number(process.env.EXEC_MATCH_WINDOW_MINUTES || 5));
const DEFAULT_INCLUDE_SUPPRESSED = String(process.env.EXEC_INCLUDE_SUPPRESSED || 'true').toLowerCase() !== 'false';

const REPORT_JSON_PATH =
  process.env.EXEC_AUDIT_REPORT_JSON ||
  path.resolve(process.cwd(), 'backend/scripts/execution_audit_report.json');
const REPORT_CSV_PATH =
  process.env.EXEC_AUDIT_REPORT_CSV ||
  path.resolve(process.cwd(), 'backend/scripts/execution_audit_report.csv');

function toNum(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    const normalized = value.replace(/[%,$\s]/g, '').replace(/,/g, '');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value?.toDate === 'function') {
    const out = value.toDate();
    return out instanceof Date && Number.isFinite(out.getTime()) ? out : null;
  }
  if (typeof value === 'number') {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const direct = new Date(trimmed);
  if (Number.isFinite(direct.getTime())) return direct;
  const match = trimmed.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const parsed = new Date(Date.UTC(year, month, day, hour, minute, second));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function mean(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (!filtered.length) return null;
  return filtered.reduce((sum, current) => sum + current, 0) / filtered.length;
}

function percentile(values, p) {
  const filtered = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const idx = (p / 100) * (filtered.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return filtered[lo];
  const weight = idx - lo;
  return filtered[lo] * (1 - weight) + filtered[hi] * weight;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value == null) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))].join('\n');
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (err) {
        results[currentIndex] = {
          ...items[currentIndex],
          audit_status: 'error',
          error: err?.message || String(err)
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

function normalizeOutcome(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'PENDING';
  if (value.includes('WIN') || value.includes('VALID')) return 'WIN';
  if (value.includes('LOSS') || value.includes('FAIL') || value.includes('PERD')) return 'LOSS';
  if (value.includes('SUPP')) return 'SUPPRESSED';
  if (value.includes('BREAKEVEN') || value.includes('BREAK')) return 'BREAKEVEN';
  if (value.includes('PEND')) return 'PENDING';
  return value;
}

function normalizeSystemSymbol(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase().replace('/', '-').replace(/\s+/g, '');
  if (upper.endsWith('-USD')) return upper;
  if (upper.endsWith('USDT')) return `${upper.slice(0, -4)}-USD`;
  if (upper.endsWith('-USDT')) return `${upper.slice(0, -5)}-USD`;
  return upper;
}

function normalizeBinanceSymbol(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper.endsWith('USDT')) return upper;
  if (upper.endsWith('USD')) return `${upper.slice(0, -3)}USDT`;
  return upper;
}

function normalizeDirection(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (['up', 'buy', 'long', 'alza'].includes(value)) return 'up';
  if (['down', 'sell', 'short', 'baja'].includes(value)) return 'down';
  return 'neutral';
}

function resolveSignalTimestamp(data) {
  return data.created_at || data.timestamp || data.signal_at || null;
}

function resolveSignalDirection(data) {
  return normalizeDirection(data.direction || data.trade_direction || data.side);
}

function resolveSignalEntry(data) {
  return (
    toNum(data.entry_price) ??
    toNum(data.trade_plan?.entry_price) ??
    toNum(data.precio_actual) ??
    toNum(data.spot_price) ??
    null
  );
}

function resolveSignalTp(data) {
  return (
    toNum(data.tp) ??
    toNum(data.take_profit) ??
    toNum(data.trade_plan?.take_profit) ??
    toNum(data.trade_plan?.target_exit_price) ??
    toNum(data.precio_estimado) ??
    toNum(data.model_price_estimate) ??
    null
  );
}

function resolveSignalSl(data) {
  return toNum(data.sl) ?? toNum(data.stop_loss) ?? toNum(data.trade_plan?.stop_loss) ?? null;
}

function resolveSignalTimeframe(data) {
  return data.timeframe || '5m';
}

function resolveModelOutcome(data) {
  return normalizeOutcome(
    data.verification_outcome ||
      data.verification?.verification_outcome ||
      data.verification?.outcome_label ||
      data.status
  );
}

function resolveDirectionalReturnPct(data) {
  const actualChange = toNum(data?.verification?.actual_change);
  const direction = resolveSignalDirection(data);
  if (!Number.isFinite(actualChange) || direction === 'neutral') return null;
  return direction === 'up' ? actualChange : -actualChange;
}

function resolveExpectedDurationSeconds(data) {
  const min = toNum(data?.expected_duration_seconds?.min ?? data?.window_seconds?.min);
  const max = toNum(data?.expected_duration_seconds?.max ?? data?.window_seconds?.max);
  const single = toNum(data?.expected_duration_seconds ?? data?.max_duration_seconds);
  if (Number.isFinite(min) || Number.isFinite(max)) {
    return {
      min: Number.isFinite(min) ? min : Number.isFinite(max) ? max : null,
      max: Number.isFinite(max) ? max : Number.isFinite(min) ? min : null
    };
  }
  if (Number.isFinite(single)) {
    return { min: single, max: single };
  }
  return { min: null, max: null };
}

function calcModelProfitPct(signal) {
  if (!Number.isFinite(signal.entry_price) || !Number.isFinite(signal.tp) || signal.direction === 'neutral') return null;
  if (signal.direction === 'up') return ((signal.tp - signal.entry_price) / signal.entry_price) * 100;
  return ((signal.entry_price - signal.tp) / signal.entry_price) * 100;
}

function calcModelRiskPct(signal) {
  if (!Number.isFinite(signal.entry_price) || !Number.isFinite(signal.sl) || signal.direction === 'neutral') return null;
  if (signal.direction === 'up') return ((signal.entry_price - signal.sl) / signal.entry_price) * 100;
  return ((signal.sl - signal.entry_price) / signal.entry_price) * 100;
}

async function loadEmittedSignals(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let snap;
  try {
    snap = await db
      .collection('velas_predicciones')
      .where('signal_emitted', '==', true)
      .where('created_at', '>=', new Date(cutoffMs))
      .limit(maxDocs)
      .get();
  } catch (err) {
    if (!String(err?.message || err).includes('FAILED_PRECONDITION')) throw err;
    snap = await db.collection('velas_predicciones').where('signal_emitted', '==', true).limit(maxDocs * 5).get();
  }

  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const timestamp = toDate(resolveSignalTimestamp(data));
      const direction = resolveSignalDirection(data);
      const entry_price = resolveSignalEntry(data);
      const tp = resolveSignalTp(data);
      const sl = resolveSignalSl(data);
      const timeframe = resolveSignalTimeframe(data);
      const expectedDuration = resolveExpectedDurationSeconds(data);
      return {
        prediction_id: doc.id,
        symbol: normalizeSystemSymbol(data.symbol || data.simbolo),
        binance_symbol: normalizeBinanceSymbol(data.symbol || data.simbolo),
        timestamp: timestamp ? timestamp.toISOString() : null,
        timestamp_ms: timestamp ? timestamp.getTime() : null,
        direction,
        entry_price,
        tp,
        sl,
        timeframe,
        expected_move_percent: toNum(data.expected_move_percent),
        expected_duration_min_seconds: expectedDuration.min,
        expected_duration_max_seconds: expectedDuration.max,
        model_outcome: resolveModelOutcome(data),
        model_directional_return_pct: resolveDirectionalReturnPct(data),
        verification_reached_target: Boolean(data?.verification?.reached_target),
        source_data: data
      };
    })
    .filter((row) => row.timestamp_ms && row.timestamp_ms >= cutoffMs)
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
}

async function loadInternalExecutedTrades(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let snap;
  try {
    snap = await db
      .collection('binance_execution_intents')
      .where('status', '==', 'executed')
      .where('created_at', '>=', new Date(cutoffMs))
      .limit(maxDocs)
      .get();
  } catch (err) {
    if (!String(err?.message || err).includes('FAILED_PRECONDITION')) throw err;
    snap = await db.collection('binance_execution_intents').where('status', '==', 'executed').limit(maxDocs * 5).get();
  }

  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const intent = data.intent || {};
      const audit = data.execution_audit || {};
      const executedAt = toDate(audit.executed_at || data.created_at);
      const closedAt = toDate(audit.closed_at);
      const avgOrderPrice = toNum(data?.exchange_response?.order?.avgPrice);
      const realEntry = Number.isFinite(avgOrderPrice) && avgOrderPrice > 0 ? avgOrderPrice : null;

      return {
        trade_id: doc.id,
        source: 'internal_execution_intent',
        prediction_id: data.prediction_id || null,
        source_profile: data.source_profile || null,
        symbol: normalizeSystemSymbol(intent.symbol),
        binance_symbol: normalizeBinanceSymbol(intent.symbol),
        direction: normalizeDirection(intent.direction || intent.side),
        entry_price: realEntry,
        fallback_entry_price: toNum(intent.entry_price),
        exit_price: null,
        entry_time: executedAt ? executedAt.toISOString() : null,
        entry_time_ms: executedAt ? executedAt.getTime() : null,
        exit_time: closedAt ? closedAt.toISOString() : null,
        exit_time_ms: closedAt ? closedAt.getTime() : null,
        pnl: toNum(audit.close_pnl_pct),
        roi: toNum(audit.close_pnl_pct),
        close_reason: audit.close_reason || null,
        win_exchange: normalizeOutcome(audit.win_exchange),
        delay_seconds: toNum(audit.delay_seconds),
        is_late_entry: typeof audit.is_late_entry === 'boolean' ? audit.is_late_entry : null,
        raw: data
      };
    })
    .filter((row) => row.entry_time_ms && row.entry_time_ms >= cutoffMs);
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current);
  return result.map((value) => value.trim());
}

function parseCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] ?? '';
      return acc;
    }, {});
  });
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

function discoverTradesFile(explicitPath = process.env.BINANCE_TRADES_FILE || '') {
  const candidates = [
    explicitPath,
    path.resolve(process.cwd(), 'backend/scripts/binance_trades_export.csv'),
    path.resolve(process.cwd(), 'backend/scripts/binance_trades_export.json'),
    path.resolve(process.cwd(), 'backend/scripts/binance_trades.csv'),
    path.resolve(process.cwd(), 'backend/scripts/binance_trades.json'),
    path.resolve(process.cwd(), 'data/binance_trades_export.csv'),
    path.resolve(process.cwd(), 'data/binance_trades_export.json')
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function normalizeExternalTradeRow(row, index) {
  const symbolRaw = pick(row, ['symbol', 'Symbol', 'pair', 'Pair', 'contract', 'Contract']);
  const entryPrice = toNum(pick(row, ['entry_price', 'Entry Price', 'entry', 'open_price', 'avg_entry_price']));
  const exitPrice = toNum(pick(row, ['exit_price', 'Exit Price', 'exit', 'close_price', 'avg_exit_price']));
  const entryTime = toDate(pick(row, ['entry_time', 'Entry Time', 'open_time', 'opened_at', 'Open time']));
  const exitTime = toDate(pick(row, ['exit_time', 'Exit Time', 'close_time', 'closed_at', 'Close time']));
  const pnl = toNum(pick(row, ['pnl', 'PnL', 'realized_pnl', 'profit', 'Profit']));
  const roi = toNum(pick(row, ['roi', 'ROI', 'pnl_pct', 'return', 'return_pct', 'ROE']));
  const direction = normalizeDirection(pick(row, ['direction', 'Direction', 'side', 'Side', 'position_side', 'Position Side']));

  return {
    trade_id: `external_${index + 1}`,
    source: 'external_binance_export',
    prediction_id: null,
    source_profile: 'external',
    symbol: normalizeSystemSymbol(symbolRaw),
    binance_symbol: normalizeBinanceSymbol(symbolRaw),
    direction,
    entry_price: entryPrice,
    fallback_entry_price: entryPrice,
    exit_price: exitPrice,
    entry_time: entryTime ? entryTime.toISOString() : null,
    entry_time_ms: entryTime ? entryTime.getTime() : null,
    exit_time: exitTime ? exitTime.toISOString() : null,
    exit_time_ms: exitTime ? exitTime.getTime() : null,
    pnl,
    roi,
    close_reason: pick(row, ['close_reason', 'Close Reason', 'remark', 'Remark']),
    win_exchange: pnl > 0 || roi > 0 ? 'WIN' : pnl < 0 || roi < 0 ? 'LOSS' : 'PENDING',
    delay_seconds: null,
    is_late_entry: null,
    raw: row
  };
}

function loadExternalTrades() {
  const filePath = discoverTradesFile();
  if (!filePath) {
    return { filePath: null, trades: [] };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  let rows = [];

  if (ext === '.json') {
    const parsed = JSON.parse(content);
    rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [];
  } else {
    rows = parseCsv(content);
  }

  return {
    filePath,
    trades: rows.map(normalizeExternalTradeRow).filter((trade) => trade.symbol && trade.entry_time_ms)
  };
}

function calcSignedReturnPct(direction, entryPrice, exitPrice, pnlPct = null) {
  if (Number.isFinite(pnlPct)) return pnlPct;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0) return null;
  if (direction === 'up') return ((exitPrice - entryPrice) / entryPrice) * 100;
  if (direction === 'down') return ((entryPrice - exitPrice) / entryPrice) * 100;
  return null;
}

function enrichExternalWithInternal(externalTrades, internalTrades, matchWindowMs) {
  return externalTrades.map((trade) => {
    const internalMatch = internalTrades
      .filter((internal) => internal.binance_symbol === trade.binance_symbol)
      .filter((internal) => Math.abs((internal.entry_time_ms || 0) - (trade.entry_time_ms || 0)) <= matchWindowMs)
      .sort(
        (a, b) =>
          Math.abs((a.entry_time_ms || 0) - (trade.entry_time_ms || 0)) -
          Math.abs((b.entry_time_ms || 0) - (trade.entry_time_ms || 0))
      )[0];

    if (!internalMatch) return trade;

    return {
      ...trade,
      prediction_id: internalMatch.prediction_id || trade.prediction_id,
      direction: trade.direction !== 'neutral' ? trade.direction : internalMatch.direction,
      close_reason: trade.close_reason || internalMatch.close_reason,
      delay_seconds: trade.delay_seconds ?? internalMatch.delay_seconds,
      is_late_entry: trade.is_late_entry ?? internalMatch.is_late_entry,
      internal_execution_intent_id: internalMatch.trade_id
    };
  });
}

function calcExpectancyFromReturns(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (!filtered.length) {
    return {
      win_rate: null,
      avg_win: null,
      avg_loss: null,
      expectancy: null
    };
  }
  const wins = filtered.filter((v) => v > 0);
  const losses = filtered.filter((v) => v < 0).map((v) => Math.abs(v));
  const winRate = wins.length / filtered.length;
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  return {
    win_rate: winRate,
    avg_win: avgWin,
    avg_loss: avgLoss,
    expectancy: winRate * (avgWin || 0) - (1 - winRate) * (avgLoss || 0)
  };
}

function evaluateSignalTradePair(signal, trade) {
  const modelProfitPct = calcModelProfitPct(signal);
  const modelRiskPct = calcModelRiskPct(signal);
  const resolvedEntryPrice = Number.isFinite(trade.entry_price) ? trade.entry_price : trade.fallback_entry_price;
  const realProfitPct = calcSignedReturnPct(
    signal.direction,
    resolvedEntryPrice,
    trade.exit_price,
    Number.isFinite(trade.roi) ? trade.roi : Number.isFinite(trade.pnl) ? trade.pnl : null
  );
  const slippageAbs =
    Number.isFinite(trade.entry_price) && Number.isFinite(signal.entry_price)
      ? trade.entry_price - signal.entry_price
      : null;
  const slippagePct =
    Number.isFinite(slippageAbs) && Number.isFinite(signal.entry_price) && signal.entry_price > 0
      ? (slippageAbs / signal.entry_price) * 100
      : null;

  const tradeDurationSec =
    Number.isFinite(trade.entry_time_ms) && Number.isFinite(trade.exit_time_ms)
      ? (trade.exit_time_ms - trade.entry_time_ms) / 1000
      : null;
  const expectedMin = signal.expected_duration_min_seconds;
  const expectedMax = signal.expected_duration_max_seconds;
  const expectedMid =
    Number.isFinite(expectedMin) && Number.isFinite(expectedMax)
      ? (expectedMin + expectedMax) / 2
      : Number.isFinite(expectedMax)
        ? expectedMax
        : Number.isFinite(expectedMin)
          ? expectedMin
          : null;
  const horizonAlignmentRatio =
    Number.isFinite(tradeDurationSec) && Number.isFinite(expectedMid) && expectedMid > 0
      ? tradeDurationSec / expectedMid
      : null;
  const horizonAligned =
    Number.isFinite(tradeDurationSec) &&
    ((Number.isFinite(expectedMin) ? tradeDurationSec >= expectedMin * 0.5 : true) &&
      (Number.isFinite(expectedMax) ? tradeDurationSec <= expectedMax * 2 : true));

  const earlyExit =
    (String(trade.close_reason || '').startsWith('early_exit') && (realProfitPct || 0) >= 0) ||
    (Number.isFinite(realProfitPct) &&
      realProfitPct > 0 &&
      Number.isFinite(modelProfitPct) &&
      realProfitPct < modelProfitPct &&
      Number.isFinite(tradeDurationSec) &&
      Number.isFinite(expectedMid) &&
      tradeDurationSec < expectedMid);

  const lateExit =
    (String(trade.close_reason || '') === 'max_hold_reached' && (realProfitPct || 0) < 0) ||
    (Number.isFinite(trade.exit_price) &&
      Number.isFinite(signal.sl) &&
      ((signal.direction === 'up' && trade.exit_price < signal.sl) ||
        (signal.direction === 'down' && trade.exit_price > signal.sl)));

  const slViolation = Boolean(lateExit);

  const profitCaptureRatio =
    Number.isFinite(realProfitPct) && Number.isFinite(modelProfitPct) && Math.abs(modelProfitPct) > 0
      ? realProfitPct / modelProfitPct
      : null;
  const profitMissedPct =
    Number.isFinite(modelProfitPct) &&
    modelProfitPct > 0 &&
    Number.isFinite(realProfitPct) &&
    realProfitPct >= 0 &&
    realProfitPct < modelProfitPct
      ? modelProfitPct - realProfitPct
      : null;

  return {
    prediction_id: signal.prediction_id,
    trade_id: trade.trade_id,
    trade_source: trade.source,
    symbol: signal.symbol,
    binance_symbol: signal.binance_symbol,
    direction: signal.direction,
    signal_timestamp: signal.timestamp,
    trade_entry_time: trade.entry_time,
    trade_exit_time: trade.exit_time,
    model_entry: signal.entry_price,
    real_entry: trade.entry_price,
    real_exit: trade.exit_price,
    model_tp: signal.tp,
    model_sl: signal.sl,
    model_outcome: signal.model_outcome,
    real_outcome: normalizeOutcome(trade.win_exchange || (realProfitPct > 0 ? 'WIN' : realProfitPct < 0 ? 'LOSS' : 'PENDING')),
    model_profit_pct: modelProfitPct,
    model_risk_pct: modelRiskPct,
    real_profit_pct: realProfitPct,
    pnl: trade.pnl,
    roi: trade.roi,
    execution_slippage: slippageAbs,
    execution_slippage_pct: slippagePct,
    delay_seconds: trade.delay_seconds,
    is_late_entry: trade.is_late_entry,
    early_exit: Boolean(earlyExit),
    late_exit: Boolean(lateExit),
    sl_violation: slViolation,
    profit_capture_ratio: profitCaptureRatio,
    profit_missed: Number.isFinite(profitMissedPct) && profitMissedPct > 0,
    profit_missed_pct: profitMissedPct,
    trade_duration_seconds: tradeDurationSec,
    expected_duration_min_seconds: expectedMin,
    expected_duration_max_seconds: expectedMax,
    horizon_alignment_ratio: horizonAlignmentRatio,
    horizon_aligned: Boolean(horizonAligned),
    close_reason: trade.close_reason || null
  };
}

async function fetchCandlesAfterTimestamp(symbol, timeframe, timestamp) {
  const candles = await fetchBinanceCandles(symbol, timeframe);
  const startMs = toDate(timestamp)?.getTime();
  if (!Number.isFinite(startMs)) return [];
  return candles
    .filter((candle) => Number.isFinite(Number(candle.timestamp)) && Number(candle.timestamp) >= startMs)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

function timeToMovePct(signal, candles, thresholdPct) {
  if (!Number.isFinite(signal.entry_price) || !Array.isArray(candles) || !candles.length) return null;
  const startMs = Number(candles[0].timestamp);
  for (const candle of candles) {
    const high = toNum(candle.high);
    const low = toNum(candle.low);
    let favorableMove = 0;
    if (signal.direction === 'up') {
      favorableMove = ((high - signal.entry_price) / signal.entry_price) * 100;
    } else if (signal.direction === 'down') {
      favorableMove = ((signal.entry_price - low) / signal.entry_price) * 100;
    }
    if (Number.isFinite(favorableMove) && favorableMove >= thresholdPct) {
      return (Number(candle.timestamp) - startMs) / 1000;
    }
  }
  return null;
}

async function analyzeLeadTime(signal) {
  const timestamp = toDate(signal.timestamp);
  if (!timestamp) {
    return { prediction_id: signal.prediction_id, lead_time_03: null, lead_time_05: null, source: 'missing' };
  }

  try {
    const candles = await fetchCandlesAfterTimestamp(signal.binance_symbol || signal.symbol, signal.timeframe, timestamp);
    if (candles.length) {
      return {
        prediction_id: signal.prediction_id,
        lead_time_03: timeToMovePct(signal, candles, 0.3),
        lead_time_05: timeToMovePct(signal, candles, 0.5),
        source: 'candles'
      };
    }
  } catch (_) {
    // fallback below
  }

  const verificationExecutedAt = toDate(signal.source_data?.verification?.executed_at);
  const directionalReturn = signal.model_directional_return_pct;
  if (!verificationExecutedAt || !timestamp || !Number.isFinite(directionalReturn)) {
    return { prediction_id: signal.prediction_id, lead_time_03: null, lead_time_05: null, source: 'missing' };
  }
  const delaySeconds = (verificationExecutedAt.getTime() - timestamp.getTime()) / 1000;
  return {
    prediction_id: signal.prediction_id,
    lead_time_03: Math.abs(directionalReturn) >= 0.3 ? delaySeconds : null,
    lead_time_05: Math.abs(directionalReturn) >= 0.5 ? delaySeconds : null,
    source: 'verification_proxy'
  };
}

function summarizeLeadTimes(items) {
  const lead03 = items.map((item) => item.lead_time_03).filter((v) => Number.isFinite(v));
  const lead05 = items.map((item) => item.lead_time_05).filter((v) => Number.isFinite(v));
  return {
    move_03: {
      lead_time_avg: mean(lead03),
      lead_time_p50: percentile(lead03, 50),
      lead_time_p75: percentile(lead03, 75),
      sample_size: lead03.length
    },
    move_05: {
      lead_time_avg: mean(lead05),
      lead_time_p50: percentile(lead05, 50),
      lead_time_p75: percentile(lead05, 75),
      sample_size: lead05.length
    }
  };
}

async function run(options = {}) {
  const days = Math.max(1, Number(options.days || DEFAULT_DAYS));
  const maxDocs = Math.max(1, Number(options.maxDocs || DEFAULT_MAX_DOCS));
  const concurrency = Math.max(1, Number(options.concurrency || DEFAULT_CONCURRENCY));
  const writeFiles = options.writeFiles !== false;
  const matchWindowMinutes = Math.max(1, Number(options.matchWindowMinutes || DEFAULT_MATCH_WINDOW_MINUTES));
  const matchWindowMs = matchWindowMinutes * 60 * 1000;
  const includeSuppressed = options.includeSuppressed !== false && DEFAULT_INCLUDE_SUPPRESSED;

  console.log('[execution-vs-model-audit] starting...');

  const [signals, internalTrades] = await Promise.all([
    loadEmittedSignals(days, maxDocs),
    loadInternalExecutedTrades(days, Math.max(maxDocs * 3, 300))
  ]);

  const externalTradesSource = loadExternalTrades();
  const externalTrades = enrichExternalWithInternal(externalTradesSource.trades, internalTrades, matchWindowMs);
  const effectiveTrades = externalTrades.length ? externalTrades : internalTrades;
  const tradeSource = externalTrades.length ? 'external_binance_export' : 'internal_execution_intent_fallback';
  const adherenceMonitor = classifyTradesAgainstSignals({
    trades: effectiveTrades,
    signals,
    matchWindowMs
  });

  const matchedPairs = adherenceMonitor.matchedPairs.map((pair) => ({
    ...evaluateSignalTradePair(pair.signal, pair.trade),
    trade_classification: pair.trade_classification
  }));
  const unmatchedTrades = adherenceMonitor.unmatchedTrades;
  const matchedSignals = adherenceMonitor.matchedPairs.map((pair) => pair.signal);
  const unmatchedSignals = adherenceMonitor.unmatchedSignals;
  const leadTimes = await runWithConcurrency(matchedSignals, concurrency, analyzeLeadTime);
  const leadTimeMap = new Map(leadTimes.map((item) => [item.prediction_id, item]));
  const enrichedPairs = matchedPairs.map((pair) => ({
    ...pair,
    lead_time_03: leadTimeMap.get(pair.prediction_id)?.lead_time_03 ?? null,
    lead_time_05: leadTimeMap.get(pair.prediction_id)?.lead_time_05 ?? null,
    lead_time_source: leadTimeMap.get(pair.prediction_id)?.source ?? 'missing'
  }));

  const modelReturnsAll = signals.map((signal) => signal.model_directional_return_pct);
  const modelReturnsMatched = matchedSignals.map((signal) => signal.model_directional_return_pct);
  const realReturns = enrichedPairs.map((pair) => pair.real_profit_pct);

  const modelAllStats = calcExpectancyFromReturns(modelReturnsAll);
  const modelMatchedStats = calcExpectancyFromReturns(modelReturnsMatched);
  const realStats = calcExpectancyFromReturns(realReturns);

  const avgExecutionSlippage = mean(enrichedPairs.map((pair) => pair.execution_slippage));
  const avgExecutionSlippagePct = mean(enrichedPairs.map((pair) => pair.execution_slippage_pct));
  const discipline = buildExecutionDisciplineMetrics(
    enrichedPairs,
    effectiveTrades.length,
    adherenceMonitor.stats.signal_adherence
  );
  const earlyExitRate = discipline.early_exit_rate;
  const lateExitRate = discipline.late_exit_rate;
  const slViolationRate = discipline.sl_violation_rate;
  const profitCaptureRatio = discipline.profit_capture_ratio;
  const manualTradeRate = discipline.manual_trade_rate;
  const executionDisciplineScore = discipline.execution_discipline_score;
  const edgeDecay =
    modelMatchedStats.expectancy != null && realStats.expectancy != null
      ? modelMatchedStats.expectancy - realStats.expectancy
      : null;
  const horizonAlignmentRate =
    enrichedPairs.length > 0
      ? enrichedPairs.filter((pair) => pair.horizon_aligned).length / enrichedPairs.length
      : null;
  const avgHorizonAlignmentRatio = mean(enrichedPairs.map((pair) => pair.horizon_alignment_ratio));
  const signalAdherence = discipline.signal_adherence;
  const profitMissedRate =
    enrichedPairs.length > 0 ? enrichedPairs.filter((pair) => pair.profit_missed).length / enrichedPairs.length : null;
  const avgProfitMissedPct = mean(enrichedPairs.map((pair) => pair.profit_missed_pct));

  const performanceBySymbol = Object.values(
    enrichedPairs.reduce((acc, pair) => {
      const symbol = pair.symbol || 'UNKNOWN';
      if (!acc[symbol]) acc[symbol] = { symbol, rows: [] };
      acc[symbol].rows.push(pair);
      return acc;
    }, {})
  )
    .map((bucket) => {
      const stats = calcExpectancyFromReturns(bucket.rows.map((row) => row.real_profit_pct));
      return {
        symbol: bucket.symbol,
        total_signals: bucket.rows.length,
        win_rate: stats.win_rate,
        expectancy: stats.expectancy,
        avg_MFE: mean(bucket.rows.map((row) => row.model_profit_pct)),
        avg_MAE: mean(bucket.rows.map((row) => row.model_risk_pct))
      };
    })
    .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));

  let suppressedValidation = null;
  if (includeSuppressed) {
    suppressedValidation = await runSuppressedValidationAudit({
      days,
      maxDocs,
      concurrency,
      writeFiles
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    config: {
      days,
      max_docs: maxDocs,
      concurrency,
      match_window_minutes: matchWindowMinutes,
      trades_source: tradeSource,
      external_trades_file: externalTradesSource.filePath || null
    },
    coverage: {
      emitted_signals_total: signals.length,
      matched_signals_total: matchedSignals.length,
      unmatched_signals_total: unmatchedSignals.length,
      executed_trades_total: effectiveTrades.length,
      matched_trades_total: enrichedPairs.length,
      unmatched_trades_total: unmatchedTrades.length
    },
    model_edge: {
      model_win_rate: modelAllStats.win_rate,
      model_expectancy: modelAllStats.expectancy,
      matched_model_win_rate: modelMatchedStats.win_rate,
      matched_model_expectancy: modelMatchedStats.expectancy
    },
    execution_quality: {
      real_win_rate: realStats.win_rate,
      real_expectancy: realStats.expectancy,
      execution_slippage: avgExecutionSlippage,
      execution_slippage_pct: avgExecutionSlippagePct,
      early_exit_rate: earlyExitRate,
      late_exit_rate: lateExitRate,
      sl_violation_rate: slViolationRate,
      profit_capture_ratio: profitCaptureRatio,
      profit_missed_rate: profitMissedRate,
      profit_missed_avg_pct: avgProfitMissedPct,
      edge_decay: edgeDecay,
      execution_delta:
        modelMatchedStats.expectancy != null && realStats.expectancy != null
          ? realStats.expectancy - modelMatchedStats.expectancy
          : null,
      trade_horizon_alignment_rate: horizonAlignmentRate,
      trade_horizon_alignment_ratio_avg: avgHorizonAlignmentRatio,
      signal_adherence: signalAdherence,
      manual_trade_rate: manualTradeRate
    },
    execution_discipline: {
      signal_adherence: signalAdherence,
      manual_trade_rate: manualTradeRate,
      early_exit_rate: earlyExitRate,
      late_exit_rate: lateExitRate,
      sl_violation_rate: slViolationRate,
      profit_capture_ratio: profitCaptureRatio,
      profit_missed_rate: profitMissedRate,
      execution_discipline_score: executionDisciplineScore,
      edge_decay: edgeDecay
    },
    lead_time_real: summarizeLeadTimes(leadTimes),
    performance_by_symbol: performanceBySymbol,
    suppressed_validation: suppressedValidation
      ? {
          total_suppressed: suppressedValidation?.suppressed_summary?.total_suppressed ?? null,
          win_rate_suprimidas: suppressedValidation?.suppressed_summary?.win_rate_suprimidas ?? null,
          expectancy_suprimidas: suppressedValidation?.suppressed_summary?.expectancy_suprimidas ?? null,
          delta_expectancy_vs_emitidas:
            suppressedValidation?.comparative_analysis?.delta_expectancy ?? null
        }
      : null,
    matched_trades: enrichedPairs,
    unmatched_trades: unmatchedTrades.map((trade) => ({
      trade_id: trade.trade_id,
      source: trade.source,
      symbol: trade.symbol,
      binance_symbol: trade.binance_symbol,
      direction: trade.direction,
      entry_time: trade.entry_time,
      exit_time: trade.exit_time,
      pnl: trade.pnl,
      roi: trade.roi
    }))
  };

  const csvRows = enrichedPairs.map((pair) => ({
    prediction_id: pair.prediction_id,
    trade_id: pair.trade_id,
    trade_source: pair.trade_source,
    symbol: pair.symbol,
    direction: pair.direction,
    signal_timestamp: pair.signal_timestamp,
    trade_entry_time: pair.trade_entry_time,
    trade_exit_time: pair.trade_exit_time,
    model_entry: pair.model_entry,
    real_entry: pair.real_entry,
    real_exit: pair.real_exit,
    execution_slippage: pair.execution_slippage,
    execution_slippage_pct: pair.execution_slippage_pct,
    model_profit_pct: pair.model_profit_pct,
    real_profit_pct: pair.real_profit_pct,
    profit_capture_ratio: pair.profit_capture_ratio,
    model_outcome: pair.model_outcome,
    real_outcome: pair.real_outcome,
    trade_classification: pair.trade_classification,
    early_exit: pair.early_exit,
    late_exit: pair.late_exit,
    sl_violation: pair.sl_violation,
    profit_missed: pair.profit_missed,
    profit_missed_pct: pair.profit_missed_pct,
    trade_duration_seconds: pair.trade_duration_seconds,
    horizon_alignment_ratio: pair.horizon_alignment_ratio,
    horizon_aligned: pair.horizon_aligned,
    lead_time_03: pair.lead_time_03,
    lead_time_05: pair.lead_time_05,
    close_reason: pair.close_reason
  }));

  if (writeFiles) {
    fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(REPORT_CSV_PATH, toCsv(csvRows), 'utf8');
  }

  console.log('\nExecution vs Model Audit Summary');
  console.table({
    modelo_win_rate: modelAllStats.win_rate,
    real_win_rate: realStats.win_rate,
    execution_slippage: avgExecutionSlippage,
    manual_trade_rate: manualTradeRate,
    execution_discipline_score: executionDisciplineScore,
    early_exit_rate: earlyExitRate,
    late_exit_rate: lateExitRate,
    sl_violation_rate: slViolationRate,
    profit_capture_ratio: profitCaptureRatio,
    edge_decay: edgeDecay,
    signal_adherence: signalAdherence
  });

  console.log('\nTop Symbols By Edge');
  console.table(performanceBySymbol.slice(0, 10));

  if (writeFiles) {
    console.log(`\nJSON: ${REPORT_JSON_PATH}`);
    console.log(`CSV: ${REPORT_CSV_PATH}`);
  }

  return report;
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Error en execution-vs-model-audit:', err);
    process.exit(1);
  });
}

module.exports = { run };
