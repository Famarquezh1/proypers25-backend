/**
 * AUTOCALIBRATION ENGINE
 *
 * Motor de decisión automático que ajusta parámetros basándose en métricas reales.
 * - Reglas globales
 * - Reglas por símbolo
 * - Límites duros
 * - Protecciones de seguridad
 * - Suavizado de cambios
 * - Cooldown anti-oscilación
 */

const RuntimeConfigManager = require('./runtime_config_manager');
const MetricsAggregator = require('./trade_metrics_aggregator');

const RECALIBRATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutos
const MAX_CHANGE_PER_CYCLE = 0.02; // ±2% máximo por ciclo
let lastRecalibrationTime = 0;
let lastSymbolRecalibrationTime = {};

/**
 * FASE 4: MOTOR DE DECISIÓN GLOBAL
 */

async function applyGlobalCalibrationRules(db, metrics) {
  if (!metrics || metrics.closed_trades_count < MetricsAggregator.METRICS_WINDOW_SIZE) {
    return null;
  }

  const currentConfig = await RuntimeConfigManager.loadGlobalConfig(db);
  const updates = {};
  const reasons = [];

  // Caso A: rendimiento débil (winrate < 45%)
  if (metrics.winrate < 45) {
    updates.confidence_min = Math.min(
      currentConfig.confidence_min + MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.confidence_min.max
    );
    updates.quantum_min = Math.min(
      currentConfig.quantum_min + MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.quantum_min.max
    );
    updates.timing_min = Math.min(
      currentConfig.timing_min + MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.timing_min.max
    );
    reasons.push(`weak_performance: winrate=${metrics.winrate.toFixed(2)}%`);
  }

  // Caso B: rendimiento fuerte (winrate > 65%)
  if (metrics.winrate > 65) {
    updates.confidence_min = Math.max(
      currentConfig.confidence_min - MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.confidence_min.min
    );
    updates.quantum_min = Math.max(
      currentConfig.quantum_min - MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.quantum_min.min
    );
    reasons.push(`strong_performance: winrate=${metrics.winrate.toFixed(2)}%`);
  }

  // Caso C: SL muy dominante (sl_hit_ratio > 60%)
  if (metrics.sl_hit_ratio > 60) {
    updates.min_expected_move_pct = Math.min(
      currentConfig.min_expected_move_pct + 0.05,
      RuntimeConfigManager.HARD_LIMITS.min_expected_move_pct.max
    );
    reasons.push(`high_sl_ratio: sl_ratio=${metrics.sl_hit_ratio.toFixed(2)}%`);
  }

  // Caso D: TP pobre (tp_hit_ratio < 40%)
  if (metrics.tp_hit_ratio < 40) {
    updates.rr_min = Math.min(
      currentConfig.rr_min + 0.10,
      RuntimeConfigManager.HARD_LIMITS.rr_min.max
    );
    reasons.push(`low_tp_ratio: tp_ratio=${metrics.tp_hit_ratio.toFixed(2)}%`);
  }

  if (Object.keys(updates).length === 0) {
    return null; // Sin cambios
  }

  return {
    updates,
    reasons: reasons.join(' | '),
    metrics_snapshot: metrics
  };
}

/**
 * FASE 5: MOTOR DE DECISIÓN POR SÍMBOLO
 */

async function applySymbolCalibrationRules(db, symbol, metrics) {
  if (!metrics || metrics.closed_trades_count < MetricsAggregator.METRICS_WINDOW_SIZE) {
    return null;
  }

  const currentConfig = (await RuntimeConfigManager.loadSymbolConfigs(db))[symbol] || {};
  const globalConfig = await RuntimeConfigManager.loadGlobalConfig(db);
  const updates = {};
  const reasons = [];

  // Si winrate < 40%, subir thresholds solo para ese símbolo
  if (metrics.winrate < 40) {
    updates.confidence_min = Math.min(
      (currentConfig.confidence_min ?? globalConfig.confidence_min) + MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.confidence_min.max
    );
    updates.quantum_min = Math.min(
      (currentConfig.quantum_min ?? globalConfig.quantum_min) + MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.quantum_min.max
    );
    reasons.push(`symbol_weak: winrate=${metrics.winrate.toFixed(2)}%`);
  }

  // Si winrate > 70%, relajar thresholds solo para ese símbolo
  if (metrics.winrate > 70) {
    updates.confidence_min = Math.max(
      (currentConfig.confidence_min ?? globalConfig.confidence_min) - MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.confidence_min.min
    );
    updates.quantum_min = Math.max(
      (currentConfig.quantum_min ?? globalConfig.quantum_min) - MAX_CHANGE_PER_CYCLE,
      RuntimeConfigManager.HARD_LIMITS.quantum_min.min
    );
    reasons.push(`symbol_strong: winrate=${metrics.winrate.toFixed(2)}%`);
  }

  // Si sl_hit_ratio > 65%, ajustar parámetros
  if (metrics.sl_hit_ratio > 65) {
    updates.min_expected_move_pct = Math.min(
      (currentConfig.min_expected_move_pct ?? globalConfig.min_expected_move_pct) + 0.05,
      RuntimeConfigManager.HARD_LIMITS.min_expected_move_pct.max
    );
    updates.timing_min = Math.min(
      (currentConfig.timing_min ?? globalConfig.timing_min) + 0.01,
      RuntimeConfigManager.HARD_LIMITS.timing_min.max
    );
    reasons.push(`symbol_high_sl: sl_ratio=${metrics.sl_hit_ratio.toFixed(2)}%`);
  }

  // Si tp_hit_ratio > 60% y avg_pnl > 0, relajar RR
  if (metrics.tp_hit_ratio > 60 && metrics.avg_pnl > 0) {
    updates.rr_min = Math.max(
      (currentConfig.rr_min ?? globalConfig.rr_min) - 0.05,
      RuntimeConfigManager.HARD_LIMITS.rr_min.min
    );
    reasons.push(`symbol_high_tp: tp_ratio=${metrics.tp_hit_ratio.toFixed(2)}%`);
  }

  if (Object.keys(updates).length === 0) {
    return null;
  }

  return {
    updates,
    reasons: reasons.join(' | '),
    metrics_snapshot: metrics
  };
}

/**
 * FASE 7: Suavizado y anti-oscilación
 */

function shouldApplyCalibration(now) {
  if (now - lastRecalibrationTime < RECALIBRATION_COOLDOWN_MS) {
    return false;
  }
  return true;
}

function shouldApplySymbolCalibration(symbol, now) {
  const lastTime = lastSymbolRecalibrationTime[symbol] || 0;
  if (now - lastTime < RECALIBRATION_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/**
 * FASE 8: Seguridad Global
 */

async function checkGlobalSafety(db, metrics) {
  if (!metrics || metrics.closed_trades_count < MetricsAggregator.METRICS_WINDOW_SIZE) {
    return null;
  }

  // Si winrate < 30%, pausar todo
  if (metrics.winrate < 30) {
    console.log('[AutoCalibration] SEVERE DEGRADATION DETECTED - Pausing execution');
    await RuntimeConfigManager.pauseExecution(db, 10, 'severe_global_degradation');
    return {
      action: 'pause_global',
      winrate: metrics.winrate,
      pause_minutes: 10
    };
  }

  return null;
}

/**
 * FASE 9: Seguridad por Símbolo
 */

async function checkSymbolSafety(db, symbol, metrics) {
  if (!metrics || metrics.closed_trades_count < MetricsAggregator.METRICS_WINDOW_SIZE) {
    return null;
  }

  // Si winrate < 25%, pausar solo ese símbolo
  if (metrics.winrate < 25) {
    console.log('[AutoCalibration] SYMBOL DEGRADATION DETECTED - Pausing symbol:', symbol);
    await RuntimeConfigManager.pauseSymbol(db, symbol, 30, 'symbol_severe_degradation');
    return {
      action: 'pause_symbol',
      symbol,
      winrate: metrics.winrate,
      pause_minutes: 30
    };
  }

  return null;
}

/**
 * CICLO COMPLETO DE AUTO-CALIBRACIÓN
 */

async function runAutocalibrationCycle(db) {
  try {
    const now = Date.now();

    console.log('[AutoCalibration] Starting calibration cycle...');

    // Actualizar métricas
    const globalMetrics = await MetricsAggregator.updateGlobalMetrics(db);
    const allSymbolMetrics = await MetricsAggregator.getAllSymbolMetrics(db);

    // GLOBAL: Chequear seguridad
    if (globalMetrics) {
      const safetyAction = await checkGlobalSafety(db, globalMetrics);
      if (safetyAction) {
        console.log('[AutoCalibration] Safety action triggered:', safetyAction);
        return { safety_action: safetyAction };
      }
    }

    // GLOBAL: Aplicar calibración
    let globalCalibration = null;
    if (globalMetrics && shouldApplyCalibration(now)) {
      globalCalibration = await applyGlobalCalibrationRules(db, globalMetrics);

      if (globalCalibration) {
        const validated = RuntimeConfigManager.applyHardLimits(globalCalibration.updates);
        await RuntimeConfigManager.updateGlobalConfig(db, validated, globalCalibration.reasons);

        console.log('[AutoCalibration] Global calibration applied:', {
          reason: globalCalibration.reasons,
          updates: validated
        });

        lastRecalibrationTime = now;
      }
    }

    // POR SÍMBOLO: Calibración y seguridad
    const symbolResults = {};
    for (const [symbol, metrics] of Object.entries(allSymbolMetrics)) {
      // Chequear seguridad por símbolo
      const symbolSafetyAction = await checkSymbolSafety(db, symbol, metrics);
      if (symbolSafetyAction) {
        symbolResults[symbol] = { safety_action: symbolSafetyAction };
        continue;
      }

      // Aplicar calibración por símbolo
      if (shouldApplySymbolCalibration(symbol, now)) {
        const symbolCalibration = await applySymbolCalibrationRules(db, symbol, metrics);

        if (symbolCalibration) {
          const validated = RuntimeConfigManager.applyHardLimits(symbolCalibration.updates);
          await RuntimeConfigManager.updateSymbolConfig(db, symbol, validated, symbolCalibration.reasons);

          console.log('[AutoCalibration] Symbol calibration applied:', {
            symbol,
            reason: symbolCalibration.reasons,
            updates: validated
          });

          lastSymbolRecalibrationTime[symbol] = now;
          symbolResults[symbol] = { calibration: symbolCalibration };
        }
      }
    }

    console.log('[AutoCalibration] Cycle completed');

    return {
      global_calibration: globalCalibration,
      symbol_results: symbolResults,
      timestamp: new Date()
    };
  } catch (err) {
    console.error('[AutoCalibration] Error during calibration cycle:', err.message);
    return { error: err.message };
  }
}

/**
 * Fuerza una recalibración inmediata (bypass cooldown)
 */
async function forceRecalibration(db) {
  lastRecalibrationTime = 0;
  lastSymbolRecalibrationTime = {};
  return await runAutocalibrationCycle(db);
}

/**
 * Resetea la configuración a valores seguros por defecto
 */
async function resetToDefaults(db, scope = 'all') {
  try {
    if (scope === 'all' || scope === 'global') {
      await RuntimeConfigManager.updateGlobalConfig(db, RuntimeConfigManager.DEFAULT_GLOBAL_PARAMS, 'reset_to_defaults');
      console.log('[AutoCalibration] Global config reset to defaults');
    }

    if (scope === 'all' || scope === 'symbols') {
      await db.collection('system_runtime_config').doc('symbol_params_live').set({}, { merge: true });
      console.log('[AutoCalibration] Symbol configs cleared');
    }

    lastRecalibrationTime = 0;
    lastSymbolRecalibrationTime = {};

    return { message: 'Configuration reset to defaults', scope };
  } catch (err) {
    console.error('[AutoCalibration] Error resetting configuration:', err.message);
    throw err;
  }
}

module.exports = {
  runAutocalibrationCycle,
  forceRecalibration,
  resetToDefaults,
  applyGlobalCalibrationRules,
  applySymbolCalibrationRules,
  checkGlobalSafety,
  checkSymbolSafety,
  shouldApplyCalibration,
  shouldApplySymbolCalibration,
  RECALIBRATION_COOLDOWN_MS,
  MAX_CHANGE_PER_CYCLE
};
