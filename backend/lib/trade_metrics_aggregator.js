/**
 * TRADE METRICS AGGREGATOR
 *
 * Calcula métricas de desempeño desde trades cerrados.
 * - Global metrics (últimos 10 trades cerrados)
 * - Per-symbol metrics (últimos 10 trades por símbolo)
 * - Persistencia en Firestore
 */

const METRICS_WINDOW_SIZE = 10; // Mínimo de trades para calcular

/**
 * Obtiene últimos N trades cerrados globales
 */
async function getRecentClosedTrades(db, limit = 30) {
  try {
    const snap = await db.collection('binance_execution_intents')
      .where('status', '==', 'closed')
      .orderBy('executed_at', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (err) {
    console.error('[MetricsAggregator] Error fetching closed trades:', err.message);
    return [];
  }
}

/**
 * Obtiene últimos N trades cerrados por símbolo
 */
async function getRecentClosedTradesBySymbol(db, symbol, limit = 30) {
  try {
    const snap = await db.collection('binance_execution_intents')
      .where('symbol', '==', symbol)
      .where('status', '==', 'closed')
      .orderBy('executed_at', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (err) {
    console.error('[MetricsAggregator] Error fetching closed trades for symbol:', err.message);
    return [];
  }
}

/**
 * Calcula PnL en porcentaje de una operación
 */
function calculatePnLPercent(trade) {
  try {
    const entry = trade.entry_price || 0;
    const exit = trade.exit_price || 0;
    const side = trade.entry_side || 'buy';

    if (entry === 0) return 0;

    const pnl = side === 'buy' ? exit - entry : entry - exit;
    const pnlPercent = (pnl / entry) * 100;

    return parseFloat(pnlPercent.toFixed(2));
  } catch (err) {
    return 0;
  }
}

/**
 * Calcula si fue TP o SL
 */
function getExitType(trade) {
  const reason = trade.close_reason || '';
  if (reason.includes('take_profit') || reason.includes('tp')) return 'tp';
  if (reason.includes('stop_loss') || reason.includes('sl')) return 'sl';
  return 'other';
}

/**
 * Calcula duración en minutos
 */
function calculateDurationMinutes(trade) {
  try {
    const entryTime = trade.executed_at?.toDate?.() || new Date(trade.executed_at);
    const closeTime = trade.closed_at?.toDate?.() || new Date(trade.closed_at);
    const durationMs = closeTime - entryTime;
    return Math.round(durationMs / 60000);
  } catch (err) {
    return 0;
  }
}

/**
 * Calcula métricas globales desde últimos trades cerrados
 */
function calculateGlobalMetrics(trades) {
  if (!trades || trades.length === 0) {
    return null;
  }

  const recentTrades = trades.slice(0, METRICS_WINDOW_SIZE);

  if (recentTrades.length < METRICS_WINDOW_SIZE) {
    return null; // Esperar a tener suficientes trades
  }

  const metrics = {
    closed_trades_count: recentTrades.length,
    wins: 0,
    losses: 0,
    pnl_values: [],
    durations: [],
    exit_types: {}
  };

  recentTrades.forEach(trade => {
    const pnl = calculatePnLPercent(trade);
    const exitType = getExitType(trade);
    const duration = calculateDurationMinutes(trade);

    metrics.pnl_values.push(pnl);
    metrics.durations.push(duration);

    metrics.exit_types[exitType] = (metrics.exit_types[exitType] || 0) + 1;

    if (pnl > 0) {
      metrics.wins++;
    } else if (pnl < 0) {
      metrics.losses++;
    }
  });

  const winrate = (metrics.wins / metrics.closed_trades_count * 100).toFixed(2);
  const avgPnL = (metrics.pnl_values.reduce((a, b) => a + b, 0) / metrics.closed_trades_count).toFixed(2);
  const avgDuration = (metrics.durations.reduce((a, b) => a + b, 0) / metrics.closed_trades_count).toFixed(1);
  const tpHitRatio = ((metrics.exit_types['tp'] || 0) / metrics.closed_trades_count * 100).toFixed(2);
  const slHitRatio = ((metrics.exit_types['sl'] || 0) / metrics.closed_trades_count * 100).toFixed(2);

  return {
    closed_trades_count: metrics.closed_trades_count,
    wins: metrics.wins,
    losses: metrics.losses,
    winrate: parseFloat(winrate),
    avg_pnl: parseFloat(avgPnL),
    loss_rate: parseFloat(((metrics.losses / metrics.closed_trades_count) * 100).toFixed(2)),
    avg_duration_minutes: parseFloat(avgDuration),
    tp_hit_ratio: parseFloat(tpHitRatio),
    sl_hit_ratio: parseFloat(slHitRatio),
    sample_window_size: METRICS_WINDOW_SIZE,
    updated_at: new Date()
  };
}

/**
 * Calcula métricas por símbolo
 */
function calculateSymbolMetrics(trades) {
  if (!trades || trades.length === 0) {
    return null;
  }

  const recentTrades = trades.slice(0, METRICS_WINDOW_SIZE);

  if (recentTrades.length < METRICS_WINDOW_SIZE) {
    return null;
  }

  return calculateGlobalMetrics(recentTrades);
}

/**
 * Actualiza métricas globales en Firestore
 */
async function updateGlobalMetrics(db) {
  try {
    const trades = await getRecentClosedTrades(db, 50);
    const metrics = calculateGlobalMetrics(trades);

    if (!metrics) {
      console.log('[MetricsAggregator] Insufficient closed trades for global metrics (need >= 10)');
      return null;
    }

    const metricsRef = db.collection('system_runtime_metrics').doc('global_metrics_latest');
    await metricsRef.set(metrics, { merge: true });

    console.log('[MetricsAggregator] Global metrics updated:', {
      closed_trades: metrics.closed_trades_count,
      winrate: metrics.winrate,
      avg_pnl: metrics.avg_pnl
    });

    return metrics;
  } catch (err) {
    console.error('[MetricsAggregator] Error updating global metrics:', err.message);
    return null;
  }
}

/**
 * Actualiza métricas por símbolo en Firestore
 */
async function updateSymbolMetrics(db, symbol) {
  try {
    const trades = await getRecentClosedTradesBySymbol(db, symbol, 50);
    const metrics = calculateSymbolMetrics(trades);

    if (!metrics) {
      return null;
    }

    const metricsRef = db.collection('symbol_runtime_metrics').doc(symbol);
    await metricsRef.set(metrics, { merge: true });

    console.log('[MetricsAggregator] Symbol metrics updated:', {
      symbol,
      closed_trades: metrics.closed_trades_count,
      winrate: metrics.winrate
    });

    return metrics;
  } catch (err) {
    console.error('[MetricsAggregator] Error updating symbol metrics:', err.message);
    return null;
  }
}

/**
 * Obtiene métricas globales
 */
async function getGlobalMetrics(db) {
  try {
    const doc = await db.collection('system_runtime_metrics').doc('global_metrics_latest').get();

    if (doc.exists) {
      return doc.data();
    }

    // Si no existe, calcular
    return await updateGlobalMetrics(db);
  } catch (err) {
    console.error('[MetricsAggregator] Error getting global metrics:', err.message);
    return null;
  }
}

/**
 * Obtiene métricas por símbolo
 */
async function getSymbolMetrics(db, symbol) {
  try {
    const doc = await db.collection('symbol_runtime_metrics').doc(symbol).get();

    if (doc.exists) {
      return doc.data();
    }

    return null;
  } catch (err) {
    console.error('[MetricsAggregator] Error getting symbol metrics:', err.message);
    return null;
  }
}

/**
 * Obtiene métricas de todos los símbolos
 */
async function getAllSymbolMetrics(db) {
  try {
    const snap = await db.collection('symbol_runtime_metrics').get();
    const metrics = {};

    snap.docs.forEach(doc => {
      metrics[doc.id] = doc.data();
    });

    return metrics;
  } catch (err) {
    console.error('[MetricsAggregator] Error getting all symbol metrics:', err.message);
    return {};
  }
}

/**
 * Detecta degradación grave
 */
function detectSevereDegradation(metrics) {
  if (!metrics) return false;

  // Winrate < 30% es degradación grave
  return metrics.winrate < 30 && metrics.closed_trades_count >= METRICS_WINDOW_SIZE;
}

/**
 * Detecta degradación por símbolo
 */
function detectSymbolDegradation(metrics) {
  if (!metrics) return false;

  // Winrate < 25% es degradación grave por símbolo
  return metrics.winrate < 25 && metrics.closed_trades_count >= METRICS_WINDOW_SIZE;
}

module.exports = {
  getRecentClosedTrades,
  getRecentClosedTradesBySymbol,
  calculateGlobalMetrics,
  calculateSymbolMetrics,
  updateGlobalMetrics,
  updateSymbolMetrics,
  getGlobalMetrics,
  getSymbolMetrics,
  getAllSymbolMetrics,
  detectSevereDegradation,
  detectSymbolDegradation,
  METRICS_WINDOW_SIZE,
  calculatePnLPercent,
  calculateDurationMinutes,
  getExitType
};
