const express = require('express');

const db = require('../firebase-admin-config');
const {
  getPreAlertRuntimeMetrics,
  getLastPredictionCycleMetrics
} = require('../tasks/velasScheduler');

const router = express.Router();

async function countRecentSignals(hours = 12, limit = 100) {
  const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
  const snapshot = await db
    .collection('velas_predicciones')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();

  let total = 0;
  for (const doc of snapshot.docs) {
    const row = doc.data() || {};
    const createdMs = Date.parse(row.created_at || row.timestamp || 0);
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) {
      continue;
    }
    if (row.signal_emitted === true) {
      total += 1;
    }
  }
  return total;
}

async function getLatestPersistedCycleSummary(limit = 20) {
  const snapshot = await db
    .collection('velas_monitoring_snapshots')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();

  for (const doc of snapshot.docs) {
    const row = doc.data() || {};
    if (row.source === 'prediction_cycle' || row.source === 'prealert_cycle') {
      return row;
    }
  }

  return null;
}

async function getRecentPredictionSummary(hours = 12, limit = 50) {
  const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
  const snapshot = await db
    .collection('velas_predicciones')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();

  const symbols = new Set();
  const symbolsWithDataSet = new Set();
  let predictionsRecent = 0;
  let fetchOk = 0;
  let emitted = 0;
  let lastPredictionAt = null;

  for (const doc of snapshot.docs) {
    const row = doc.data() || {};
    const createdAt = row.created_at || row.timestamp || null;
    const createdMs = Date.parse(createdAt || 0);
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) {
      continue;
    }

    predictionsRecent += 1;
    lastPredictionAt = lastPredictionAt || createdAt;
    if (row.simbolo || row.symbol) {
      symbols.add(String(row.simbolo || row.symbol));
    }

    const symbolKey = String(row.simbolo || row.symbol || '');
    const sourceUsed = row?.profiling?.fetch_candles?.source_used || row.fetch_source || null;
    const spotPrice = Number(row.spot_price || row.precio_actual || 0);
    const hasValidSpot = Number.isFinite(spotPrice) && spotPrice > 0;
    const hasDecisionScores = [
      Number(row?.decision_post_learning?.confidence),
      Number(row?.decision_post_learning?.quantum),
      Number(row?.decision_post_learning?.timing),
      Number(row.confidence_score || row.confidence),
      Number(row.quantum_score || row.quantum),
      Number(row.timing_score || row.timing)
    ].some(Number.isFinite);
    const hasUsablePrediction =
      hasValidSpot ||
      hasDecisionScores ||
      row.signal_emitted === true ||
      row.status === 'pendiente' ||
      row.status === 'suprimida';

    if ((sourceUsed && sourceUsed !== 'all_failed') || hasUsablePrediction) {
      fetchOk += 1;
    }
    if (hasUsablePrediction && symbolKey) {
      symbolsWithDataSet.add(symbolKey);
    }
    if (row.signal_emitted === true) {
      emitted += 1;
    }
  }

  return {
    predictions_recent: predictionsRecent,
    symbols_with_recent_predictions: symbols.size,
    symbols_with_data: symbolsWithDataSet.size,
    fetch_ok_predictions: fetchOk,
    signals_recent: emitted,
    last_prediction_at: lastPredictionAt
  };
}

router.get('/health-deep', async (_req, res) => {
  try {
    const lastCycle = getLastPredictionCycleMetrics() || await getLatestPersistedCycleSummary();
    const prealert = getPreAlertRuntimeMetrics() || null;
    const recentPredictions = await getRecentPredictionSummary();
    const signalsRecent = Math.max(await countRecentSignals(), Number(recentPredictions?.signals_recent || 0));
    const lastCycleCreatedMs = Date.parse(lastCycle?.created_at || 0);
    const pipelineAlive =
      Boolean(prealert?.running) ||
      (Number.isFinite(lastCycleCreatedMs) && Date.now() - lastCycleCreatedMs <= 30 * 60 * 1000) ||
      Number(recentPredictions?.predictions_recent || 0) > 0;
    const symbolsWithData = Math.max(
      Number(lastCycle?.debug_cycle?.symbols_with_data || 0),
      Number(recentPredictions?.symbols_with_data || 0)
    );
    const fetchOk =
      (Boolean(lastCycle) &&
        symbolsWithData > 0 &&
        Number(lastCycle?.debug_cycle?.symbols_without_data || 0) < Number(lastCycle?.symbols_total || 0)) ||
      Number(recentPredictions?.fetch_ok_predictions || 0) > 0;
    const lastCycleOk =
      ((Boolean(lastCycle) &&
        Number(lastCycle?.failed || 0) < Number(lastCycle?.symbols_total || 0) &&
        !prealert?.last_error) ||
        Number(recentPredictions?.predictions_recent || 0) > 0) &&
      !prealert?.last_error;

    return res.json({
      pipeline_alive: pipelineAlive,
      fetch_ok: fetchOk,
      symbols_with_data: symbolsWithData,
      signals_recent: signalsRecent,
      last_cycle_ok: lastCycleOk,
      last_cycle_at: lastCycle?.created_at || recentPredictions?.last_prediction_at || null,
      prealert_running: Boolean(prealert?.running),
      recent_predictions: recentPredictions,
      last_cycle_summary: lastCycle
        ? {
            source: lastCycle.source,
            symbols_total: Number(lastCycle.symbols_total || 0),
            failed: Number(lastCycle.failed || 0),
            signals_emitted: Number(lastCycle.signals_emitted || 0),
            signals_suppressed: Number(lastCycle.signals_suppressed || 0)
          }
        : null
    });
  } catch (err) {
    return res.status(500).json({
      pipeline_alive: false,
      fetch_ok: false,
      symbols_with_data: 0,
      signals_recent: 0,
      last_cycle_ok: false,
      error: err?.message || 'health_deep_failed'
    });
  }
});

module.exports = router;
