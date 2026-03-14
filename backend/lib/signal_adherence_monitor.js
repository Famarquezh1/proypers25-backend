function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function findBestSignalMatch(trade, signals, matchWindowMs, usedSignalIds = new Set()) {
  const candidates = signals
    .filter((signal) => !usedSignalIds.has(signal.prediction_id))
    .filter((signal) => signal.binance_symbol === trade.binance_symbol || signal.symbol === trade.symbol)
    .filter((signal) => Math.abs((trade.entry_time_ms || 0) - (signal.timestamp_ms || 0)) <= matchWindowMs)
    .filter((signal) => trade.direction === 'neutral' || signal.direction === trade.direction)
    .map((signal) => ({
      signal,
      score:
        Math.abs((trade.entry_time_ms || 0) - (signal.timestamp_ms || 0)) +
        (trade.direction !== 'neutral' && signal.direction !== trade.direction ? 60 * 60 * 1000 : 0)
    }))
    .sort((a, b) => a.score - b.score);

  return candidates[0]?.signal || null;
}

function classifyTradesAgainstSignals({ trades, signals, matchWindowMs }) {
  const usedSignalIds = new Set();
  const matchedPairs = [];
  const unmatchedTrades = [];

  const signalsByPredictionId = new Map(signals.map((signal) => [signal.prediction_id, signal]));

  for (const trade of trades) {
    let signal = null;
    if (trade.prediction_id && signalsByPredictionId.has(trade.prediction_id) && !usedSignalIds.has(trade.prediction_id)) {
      signal = signalsByPredictionId.get(trade.prediction_id);
    }
    if (!signal) {
      signal = findBestSignalMatch(trade, signals, matchWindowMs, usedSignalIds);
    }

    if (!signal) {
      unmatchedTrades.push({
        ...trade,
        trade_classification: 'manual_trade'
      });
      continue;
    }

    usedSignalIds.add(signal.prediction_id);
    matchedPairs.push({
      trade,
      signal,
      trade_classification: 'model_trade'
    });
  }

  const unmatchedSignals = signals.filter((signal) => !usedSignalIds.has(signal.prediction_id));
  const totalTrades = trades.length;
  const modelTrades = matchedPairs.length;
  const manualTrades = unmatchedTrades.length;

  return {
    matchedPairs,
    unmatchedTrades,
    unmatchedSignals,
    stats: {
      total_trades: totalTrades,
      model_trades: modelTrades,
      manual_trades: manualTrades,
      signal_adherence: totalTrades > 0 ? modelTrades / totalTrades : null,
      manual_trade_rate: totalTrades > 0 ? manualTrades / totalTrades : null
    }
  };
}

function buildExecutionDisciplineMetrics(executionRows, totalTrades, signalAdherence = null) {
  const rows = Array.isArray(executionRows) ? executionRows : [];
  const tradeCount = Number(totalTrades || rows.length || 0);
  const earlyExitRate = tradeCount > 0 ? rows.filter((row) => row.early_exit).length / tradeCount : null;
  const lateExitRate = tradeCount > 0 ? rows.filter((row) => row.late_exit).length / tradeCount : null;
  const slViolationRate = tradeCount > 0 ? rows.filter((row) => row.sl_violation).length / tradeCount : null;

  const profitCaptureValues = rows
    .map((row) => Number(row.profit_capture_ratio))
    .filter((value) => Number.isFinite(value));
  const profitCaptureRatio =
    profitCaptureValues.length > 0
      ? profitCaptureValues.reduce((sum, value) => sum + value, 0) / profitCaptureValues.length
      : null;

  const adherence = clamp01(signalAdherence, 0);
  const capture = clamp01(profitCaptureRatio, 0);
  const disciplineScore = Math.round(
    100 *
      (
        0.35 * adherence +
        0.25 * (1 - clamp01(slViolationRate, 0)) +
        0.15 * (1 - clamp01(earlyExitRate, 0)) +
        0.15 * (1 - clamp01(lateExitRate, 0)) +
        0.1 * capture
      )
  );

  return {
    signal_adherence: signalAdherence,
    manual_trade_rate: signalAdherence == null ? null : 1 - signalAdherence,
    early_exit_rate: earlyExitRate,
    late_exit_rate: lateExitRate,
    sl_violation_rate: slViolationRate,
    profit_capture_ratio: profitCaptureRatio,
    execution_discipline_score: disciplineScore
  };
}

module.exports = {
  classifyTradesAgainstSignals,
  buildExecutionDisciplineMetrics
};
