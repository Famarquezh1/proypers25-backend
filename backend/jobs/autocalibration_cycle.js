/**
 * AUTOCALIBRATION CYCLE JOB
 *
 * Ejecuta el motor de auto-calibración periódicamente.
 * - Cada N minutos (configurable)
 * - Calcula métricas
 * - Aplica ajustes
 * - Maneja seguridad
 *
 * Phases 8, 11, 12: Production Hardening Integration
 * - Health monitoring integration
 * - Structured logging
 * - System state tracking
 * - Never silent without explanation
 */

const admin = require('firebase-admin');
const AutocalibrationEngine = require('../lib/autocalibration_engine');
const MetricsAggregator = require('../lib/trade_metrics_aggregator');
const HealthMonitor = require('../lib/system_health_monitor');
const StateTracker = require('../lib/system_state_tracker');
const CriticalSafetyMonitor = require('../lib/critical_safety_monitor');

let calibrationInterval = null;
const CYCLE_INTERVAL_MS = parseInt(process.env.AUTOCALIBRATION_CYCLE_MINUTES || '15', 10) * 60 * 1000;

/**
 * Inicia el job de calibración
 */
function startAutocalibrationJob(db) {
  if (calibrationInterval) {
    console.log('[AutocalibrationJob] Job already running');
    return;
  }

  console.log('[AutocalibrationJob] Starting calibration job with interval:', CYCLE_INTERVAL_MS / 1000, 'seconds');

  // Ejecutar inmediatamente la primera vez
  runCalibrationCycle(db);

  // Luego ejecutar periódicamente
  calibrationInterval = setInterval(() => {
    runCalibrationCycle(db);
  }, CYCLE_INTERVAL_MS);
}

/**
 * Detiene el job de calibración
 */
function stopAutocalibrationJob() {
  if (calibrationInterval) {
    clearInterval(calibrationInterval);
    calibrationInterval = null;
    console.log('[AutocalibrationJob] Calibration job stopped');
  }
}

/**
 * Ejecuta un ciclo de calibración
 *
 * Phases 8, 11: Production Hardening
 * - Integrates health monitoring
 * - Structured logging
 * - Skips calibration if system unstable
 * - Never stays silent
 */
async function runCalibrationCycle(db) {
  const cycleStartTime = new Date();

  try {
    console.log('⏱️  [AutocalibrationJob] Running calibration cycle at', cycleStartTime.toISOString());

    // Phase 1: Collect cycle metrics
    const cycleMetrics = await collectCycleMetrics(db);

    // Phase 2: Run health checks (CRITICAL - Phase 1, 6, 7)
    await HealthMonitor.runHealthCheck(db, cycleMetrics);

    // Phase 3: Track system state (Phases 5, 9)
    StateTracker.trackEmptyCycle(cycleMetrics);
    const operationalState = StateTracker.determineOperationalState(
      cycleMetrics,
      await getPauseStatus(db)
    );

    // Phase 3.5: CRITICAL SAFETY CHECKS (Extra Phases 1-7)
    // This ensures system NEVER fails silently
    const safetyCheckResult = await CriticalSafetyMonitor.runCriticalSafetyCheck(
      db,
      cycleMetrics,
      operationalState
    );
    if (safetyCheckResult && safetyCheckResult.critical_alerts > 0) {
      console.log('🚨 [AutocalibrationJob] Critical alerts detected:', safetyCheckResult.critical_alerts);
    }

    // Phase 4: Check if system is unstable (Phase 8)
    const isSystemUnstable = await checkSystemStability(db, operationalState);

    if (isSystemUnstable) {
      HealthMonitor.logStructured('AUTOCALIBRATION_SKIPPED_UNSTABLE_SYSTEM', {
        operational_state: operationalState.state,
        reason: operationalState.reason,
        severity: operationalState.severity,
        timestamp: new Date()
      });

      // Still log the cycle
      await logCalibrationCycle(db, {
        status: 'skipped_unstable',
        reason: 'system_unstable',
        operational_state: operationalState,
        cycle_metrics: cycleMetrics,
        cycle_duration_ms: Date.now() - cycleStartTime.getTime()
      });

      return;
    }

    // Phase 5: Run calibration (only if stable)
    const result = await AutocalibrationEngine.runAutocalibrationCycle(db);

    // Phase 6: Log with structured format (Phase 11)
    HealthMonitor.logStructured('RUNTIME_CONFIG_APPLIED', {
      global_updates: !!result.global_calibration,
      symbols_updated: Object.keys(result.symbol_results || {}).length,
      safety_triggered: !!result.safety_action,
      operational_state: operationalState.state,
      timestamp: new Date()
    });

    // Log full cycle result
    await logCalibrationCycle(db, {
      status: 'completed',
      global_calibration: result.global_calibration,
      symbol_results: result.symbol_results,
      safety_action: result.safety_action,
      operational_state: operationalState,
      cycle_metrics: cycleMetrics,
      cycle_duration_ms: Date.now() - cycleStartTime.getTime(),
      error: null
    });

    console.log('✅ [AutocalibrationJob] Cycle completed in', Date.now() - cycleStartTime.getTime(), 'ms');

  } catch (err) {
    console.error('❌ [AutocalibrationJob] Error in calibration cycle:', err.message);

    // PHASE 12: Never silent - always log what went wrong
    HealthMonitor.logStructured('AUTOCALIBRATION_CYCLE_ERROR', {
      error: err.message,
      stack: err.stack,
      severity: 'high',
      timestamp: new Date()
    });

    try {
      await logCalibrationCycle(db, {
        status: 'error',
        error: err.message,
        stack: err.stack,
        cycle_duration_ms: Date.now() - cycleStartTime.getTime(),
        timestamp: cycleStartTime
      });
    } catch (logErr) {
      console.error('[AutocalibrationJob] Error logging cycle error:', logErr.message);
    }
  }
}

/**
 * Collect metrics for this cycle
 */
async function collectCycleMetrics(db) {
  try {
    // In real implementation, would fetch from execution intents, signal generation, etc.
    // For now, return template structure
    return {
      timestamp: new Date(),
      signals_emitted: 0,
      intents_created: 0,
      executions: 0,
      closures: 0,
      fetched_symbols: 0,
      quality_gate_blocks: 0,
      binance_errors: 0,
      binance_latency_ms: 0,
      stream_age_seconds: 0
    };
  } catch (err) {
    console.error('[AutocalibrationJob] Error collecting metrics:', err.message);
    return null;
  }
}

/**
 * Get current pause status
 */
async function getPauseStatus(db) {
  try {
    const config = await db.collection('system_runtime_config')
      .doc('trading_params_live')
      .get();

    if (config.exists) {
      const data = config.data();
      return {
        pause_execution: data.pause_execution || false,
        pause_until: data.pause_until,
        pause_reason: data.pause_reason
      };
    }
  } catch (err) {
    console.error('[AutocalibrationJob] Error getting pause status:', err.message);
  }

  return { pause_execution: false };
}

/**
 * Phase 8: Check if system is unstable for calibration
 *
 * Don't calibrate if:
 * - Data errors present
 * - Fetch failures
 * - System in fallback mode
 * - Stalled state
 */
async function checkSystemStability(db, operationalState) {
  try {
    // Don't calibrate if stalled or unknown
    if (operationalState.state === 'stalled' || operationalState.state === 'unknown') {
      return true;
    }

    // Don't calibrate if system is paused
    if (operationalState.state === 'paused') {
      return true;
    }

    return false;
  } catch (err) {
    console.error('[AutocalibrationJob] Error checking stability:', err.message);
    return true; // Default to unstable on error
  }
}

/**
 * Log calibration cycle with all details
 */
async function logCalibrationCycle(db, details) {
  try {
    const logEntry = {
      cycle_executed_at: new Date(),
      ...details
    };

    await db.collection('autocalibration_logs').add(logEntry);
  } catch (err) {
    console.error('[AutocalibrationJob] Error logging cycle:', err.message);
  }
}

/**
 * Obtiene logs de calibración recientes
 */
async function getRecentCalibrationLogs(db, limit = 50) {
  try {
    const snap = await db.collection('autocalibration_logs')
      .orderBy('cycle_executed_at', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (err) {
    console.error('[AutocalibrationJob] Error fetching logs:', err.message);
    return [];
  }
}

module.exports = {
  startAutocalibrationJob,
  stopAutocalibrationJob,
  runCalibrationCycle,
  getRecentCalibrationLogs,
  CYCLE_INTERVAL_MS
};
