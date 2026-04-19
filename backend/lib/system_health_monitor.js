/**
 * SYSTEM HEALTH MONITOR
 *
 * Phases 1-2, 6-7, 11: Production Hardening
 *
 * ✔ Detects system inactivity (Fase 1)
 * ✔ Performs automatic diagnostics (Fase 2)
 * ✔ Validates real execution flow (Fase 6)
 * ✔ Monitors Binance connection (Fase 7)
 * ✔ Structured logging (Fase 11)
 *
 * Never stays silent without explanation.
 */

const admin = require('firebase-admin');

// State tracking for consecutive cycles
let previousCycleMetrics = null;
let inactiveCycleCount = 0;
let binanceErrorCount = 0;
let executionBlockCount = 0;

const INACTIVITY_THRESHOLD = 3; // 3 consecutive cycles with no signals/intents
const BINANCE_ERROR_THRESHOLD = 3; // Reconnect after 3 errors
const EXECUTION_BLOCK_THRESHOLD = 2; // Flag after 2 cycles with blocked execution

/**
 * Logs a structured event for monitoring
 */
function logStructured(eventType, data = {}) {
  const timestamp = new Date().toISOString();
  const structuredLog = {
    timestamp,
    event_type: eventType,
    data,
    severity: data.severity || 'info'
  };

  // Console output with emoji
  const emojiMap = {
    'SYSTEM_INACTIVE_DETECTED': '🔴',
    'SYSTEM_DIAGNOSTIC_RESULT': '🔍',
    'DATA_SOURCE_FALLBACK': '🔄',
    'EXECUTION_BLOCK_DETECTED': '⚠️',
    'BINANCE_RECONNECT': '🔌',
    'ANTI_STALL_TRIGGERED': '⚡',
    'RUNTIME_CONFIG_APPLIED': '⚙️',
    'SYSTEM_HEALTH_CHECK': '💓',
    'EXECUTION_FLOW_VALIDATED': '✅',
    'SYMBOL_NORMALIZATION_ERROR': '❌'
  };

  const emoji = emojiMap[eventType] || '📊';
  console.log(`${emoji} [${eventType}] ${JSON.stringify(structuredLog)}`);
}

/**
 * Fase 1: Detect system inactivity
 *
 * Triggers when:
 * - signals_emitted = 0
 * - AND intents_created = 0
 * - AND fetched_symbols > 0
 * - During 3 consecutive cycles
 */
async function checkSystemInactivity(db, currentMetrics) {
  try {
    // Extract key metrics
    const {
      signals_emitted = 0,
      intents_created = 0,
      fetched_symbols = 0
    } = currentMetrics || {};

    // Condition: no signals, no intents, but did fetch symbols
    const isInactive = signals_emitted === 0 &&
                       intents_created === 0 &&
                       fetched_symbols > 0;

    if (isInactive) {
      inactiveCycleCount++;

      if (inactiveCycleCount >= INACTIVITY_THRESHOLD) {
        // TRIGGER ALERT
        logStructured('SYSTEM_INACTIVE_DETECTED', {
          reason: 'no_signals_no_intents',
          fetched_symbols,
          inactive_cycle_count: inactiveCycleCount,
          severity: 'critical',
          timestamp: new Date()
        });

        // Trigger diagnostic
        await performAutoDiagnostic(db, currentMetrics);

        // Reset counter after reporting
        inactiveCycleCount = 0;
      }
    } else {
      inactiveCycleCount = 0;
    }
  } catch (err) {
    console.error('[HealthMonitor] Error checking inactivity:', err.message);
  }
}

/**
 * Fase 2: Automatic diagnostics
 *
 * Evaluates:
 * 1. fetched_symbols = 0? → data fetch problem
 * 2. source_used = none? → data provider problem
 * 3. quality_gate blocking? → thresholds too high
 * 4. execution paused? → pause_execution = true
 * 5. event stream stale? → MARKET_STREAM stale
 */
async function performAutoDiagnostic(db, metrics) {
  try {
    const diagnosis = {
      timestamp: new Date(),
      checks: []
    };

    // Check 1: Data fetch
    if ((metrics?.fetched_symbols || 0) === 0) {
      diagnosis.checks.push({
        check: 'data_fetch',
        status: 'FAILED',
        description: 'No symbols fetched - data provider issue'
      });
    }

    // Check 2: Data source
    if ((metrics?.source_used || 'none') === 'none') {
      diagnosis.checks.push({
        check: 'data_source',
        status: 'FAILED',
        description: 'No data source available'
      });
    }

    // Check 3: Quality gate
    if ((metrics?.quality_gate_blocks || 0) > 0) {
      diagnosis.checks.push({
        check: 'quality_gate',
        status: 'BLOCKING',
        blocks: metrics.quality_gate_blocks,
        description: 'Quality gate thresholds too high'
      });
    }

    // Check 4: Execution pause
    try {
      const config = await db.collection('system_runtime_config').doc('trading_params_live').get();
      if (config.exists && config.data().pause_execution) {
        diagnosis.checks.push({
          check: 'execution_pause',
          status: 'PAUSED',
          description: 'Global execution paused'
        });
      }
    } catch (err) {
      console.error('[HealthMonitor] Error checking pause status:', err.message);
    }

    // Check 5: Market stream
    if ((metrics?.stream_age_seconds || 0) > 60) {
      diagnosis.checks.push({
        check: 'market_stream',
        status: 'STALE',
        age_seconds: metrics.stream_age_seconds,
        description: 'Market stream data is stale'
      });
    }

    // Determine root cause and severity
    const rootCause = identifyRootCause(diagnosis.checks);
    diagnosis.root_cause = rootCause.cause;
    diagnosis.severity = rootCause.severity;

    logStructured('SYSTEM_DIAGNOSTIC_RESULT', diagnosis);

    // Save diagnostic to Firestore for history
    try {
      await db.collection('system_diagnostics').add(diagnosis);
    } catch (err) {
      console.error('[HealthMonitor] Error saving diagnostic:', err.message);
    }

  } catch (err) {
    console.error('[HealthMonitor] Error performing diagnostics:', err.message);
  }
}

/**
 * Determines root cause from diagnostic checks
 */
function identifyRootCause(checks) {
  if (checks.length === 0) {
    return { cause: 'unknown', severity: 'low' };
  }

  // Priority order of failures
  if (checks.some(c => c.check === 'data_fetch' && c.status === 'FAILED')) {
    return { cause: 'data_fetch_failed', severity: 'critical' };
  }
  if (checks.some(c => c.check === 'data_source' && c.status === 'FAILED')) {
    return { cause: 'no_data_source', severity: 'critical' };
  }
  if (checks.some(c => c.check === 'execution_pause' && c.status === 'PAUSED')) {
    return { cause: 'execution_paused', severity: 'medium' };
  }
  if (checks.some(c => c.check === 'quality_gate' && c.status === 'BLOCKING')) {
    return { cause: 'quality_gate_too_strict', severity: 'high' };
  }
  if (checks.some(c => c.check === 'market_stream' && c.status === 'STALE')) {
    return { cause: 'stale_market_data', severity: 'high' };
  }

  return { cause: 'multiple_issues', severity: 'high' };
}

/**
 * Fase 6: Validate real execution flow
 *
 * Check each cycle:
 * ✔ intents generated
 * ✔ intents executed
 * ✔ positions opened
 * ✔ positions closed
 *
 * If: intents_created > 0 AND executed = 0
 * → execution block detected
 */
async function validateExecutionFlow(db, metrics) {
  try {
    const {
      intents_created = 0,
      intents_executed = 0,
      positions_opened = 0,
      positions_closed = 0
    } = metrics || {};

    // Check for execution block
    if (intents_created > 0 && intents_executed === 0) {
      executionBlockCount++;

      if (executionBlockCount >= EXECUTION_BLOCK_THRESHOLD) {
        logStructured('EXECUTION_BLOCK_DETECTED', {
          intents_created,
          intents_executed: 0,
          positions_opened,
          positions_closed,
          block_count: executionBlockCount,
          severity: 'critical',
          timestamp: new Date()
        });

        // Reset counter
        executionBlockCount = 0;
      }
    } else if (intents_created > 0 && intents_executed > 0) {
      // Reset counter if execution resumes
      executionBlockCount = 0;

      logStructured('EXECUTION_FLOW_VALIDATED', {
        intents_created,
        intents_executed,
        positions_opened,
        positions_closed,
        status: 'flowing',
        timestamp: new Date()
      });
    }
  } catch (err) {
    console.error('[HealthMonitor] Error validating execution:', err.message);
  }
}

/**
 * Fase 7: Binance connection watchdog
 *
 * Monitor each cycle:
 * ✔ Active connection
 * ✔ API latency
 * ✔ Recent errors
 *
 * If: >3 consecutive errors
 * → Trigger reconnect
 */
async function monitorBinanceHealth(db, metrics) {
  try {
    const {
      binance_errors = 0,
      binance_latency_ms = 0,
      binance_connected = true
    } = metrics || {};

    if (!binance_connected || binance_errors > 0) {
      binanceErrorCount++;

      if (binanceErrorCount >= BINANCE_ERROR_THRESHOLD) {
        logStructured('BINANCE_RECONNECT', {
          reason: 'consecutive_errors',
          error_count: binanceErrorCount,
          latency_ms: binance_latency_ms,
          severity: 'high',
          action: 'reconnect_client',
          timestamp: new Date()
        });

        // Try to reconnect
        try {
          // This would be called from binanceFuturesExecutor
          // For now, just log the intention
          console.log('[HealthMonitor] Binance reconnect triggered - client should reinitialize');
        } catch (err) {
          console.error('[HealthMonitor] Error triggering reconnect:', err.message);
        }

        binanceErrorCount = 0;
      }
    } else if (binance_connected) {
      binanceErrorCount = 0;
    }
  } catch (err) {
    console.error('[HealthMonitor] Error monitoring Binance:', err.message);
  }
}

/**
 * Run all health checks in a cycle
 */
async function runHealthCheck(db, cycleMetrics) {
  try {
    logStructured('SYSTEM_HEALTH_CHECK', {
      timestamp: new Date(),
      metrics_provided: !!cycleMetrics,
      inactivity_count: inactiveCycleCount,
      binance_error_count: binanceErrorCount,
      execution_block_count: executionBlockCount
    });

    if (!cycleMetrics) return;

    // Run all checks
    await checkSystemInactivity(db, cycleMetrics);
    await validateExecutionFlow(db, cycleMetrics);
    await monitorBinanceHealth(db, cycleMetrics);

    previousCycleMetrics = cycleMetrics;
  } catch (err) {
    console.error('[HealthMonitor] Error running health check:', err.message);
  }
}

/**
 * Get current health status
 */
function getCurrentHealthStatus() {
  return {
    inactive_cycles: inactiveCycleCount,
    binance_errors: binanceErrorCount,
    execution_blocks: executionBlockCount,
    is_healthy: inactiveCycleCount === 0 && binanceErrorCount === 0,
    timestamp: new Date()
  };
}

module.exports = {
  runHealthCheck,
  getCurrentHealthStatus,
  checkSystemInactivity,
  performAutoDiagnostic,
  validateExecutionFlow,
  monitorBinanceHealth,
  logStructured,
  INACTIVITY_THRESHOLD,
  BINANCE_ERROR_THRESHOLD,
  EXECUTION_BLOCK_THRESHOLD
};
