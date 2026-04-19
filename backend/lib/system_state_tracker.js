/**
 * SYSTEM STATE TRACKER
 *
 * Phases 5, 9: Production Hardening
 *
 * ✔ Tracks empty cycles (Fase 5)
 * ✔ Anti-stall mechanism (temporarily relax thresholds)
 * ✔ Real operational state validation (Fase 9)
 * ✔ State machine: healthy → degraded → stalled → paused
 *
 * Never trap system in silent failure.
 */

const admin = require('firebase-admin');

// Cycle tracking
let emptyCycleCount = 0;
let consecutiveFailedExecutions = 0;
let lastSignalTime = null;
let lastExecutionTime = null;
let lastClosureTime = null;

const EMPTY_CYCLE_THRESHOLD = 5; // Trigger anti-stall after 5 empty cycles
const ANTI_STALL_THRESHOLD_REDUCTION = 0.05; // Reduce thresholds by 5%

/**
 * Fase 5: Detect and log empty cycles
 */
function trackEmptyCycle(cycleMetrics) {
  try {
    const {
      signals_emitted = 0,
      intents_created = 0,
      executions = 0,
      closures = 0
    } = cycleMetrics || {};

    // Empty cycle: nothing generated or executed
    if (signals_emitted === 0 && intents_created === 0 && executions === 0) {
      emptyCycleCount++;

      if (emptyCycleCount >= EMPTY_CYCLE_THRESHOLD) {
        triggerAntiStall(cycleMetrics);
        emptyCycleCount = 0; // Reset after triggering
      }
    } else {
      // Reset counter if cycle had activity
      emptyCycleCount = 0;
    }

    // Track last activity times
    if (signals_emitted > 0) lastSignalTime = new Date();
    if (executions > 0) lastExecutionTime = new Date();
    if (closures > 0) lastClosureTime = new Date();

  } catch (err) {
    console.error('[StateTracker] Error tracking empty cycles:', err.message);
  }
}

/**
 * Fase 5: Anti-stall mechanism
 *
 * If >= 5 empty cycles:
 * - Temporarily reduce thresholds by 5% (NOT persistent)
 * - Allow more aggressive signal generation
 * - Prevent system from "thinking without operating"
 */
async function triggerAntiStall(db, cycleMetrics) {
  try {
    console.log('⚡ [StateTracker] ANTI_STALL_TRIGGERED');
    console.log('   Reason: Too many empty cycles without activity');
    console.log('   Action: Temporarily relaxing thresholds...');

    // Get current global config
    const globalConfig = await db.collection('system_runtime_config')
      .doc('trading_params_live')
      .get();

    if (!globalConfig.exists) {
      console.warn('[StateTracker] Global config not found for anti-stall');
      return;
    }

    const current = globalConfig.data();

    // Create temporary relaxed config
    const tempConfig = {
      confidence_min: Math.max(0.60, current.confidence_min - ANTI_STALL_THRESHOLD_REDUCTION),
      quantum_min: Math.max(0.55, current.quantum_min - ANTI_STALL_THRESHOLD_REDUCTION),
      timing_min: Math.max(0.50, current.timing_min - ANTI_STALL_THRESHOLD_REDUCTION),
      // Keep other params unchanged
      rr_min: current.rr_min,
      min_expected_move_pct: current.min_expected_move_pct,
      execution_score_min: current.execution_score_min,

      // Mark as anti-stall
      anti_stall_active: true,
      anti_stall_until: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      anti_stall_previous_values: {
        confidence_min: current.confidence_min,
        quantum_min: current.quantum_min,
        timing_min: current.timing_min
      }
    };

    // Log the anti-stall event
    const event = {
      timestamp: new Date(),
      event_type: 'ANTI_STALL_TRIGGERED',
      empty_cycle_count: emptyCycleCount,
      severity: 'high',
      previous_config: {
        confidence_min: current.confidence_min,
        quantum_min: current.quantum_min,
        timing_min: current.timing_min
      },
      temporary_config: tempConfig,
      duration_minutes: 15
    };

    console.log('[StateTracker] Event:', JSON.stringify(event, null, 2));

    // Save to Firestore
    try {
      await db.collection('anti_stall_events').add(event);
    } catch (err) {
      console.error('[StateTracker] Error logging anti-stall:', err.message);
    }

  } catch (err) {
    console.error('[StateTracker] Error triggering anti-stall:', err.message);
  }
}

/**
 * Check if anti-stall is still active
 */
async function isAntiStallActive(db) {
  try {
    const config = await db.collection('system_runtime_config')
      .doc('trading_params_live')
      .get();

    if (!config.exists) return false;

    const data = config.data();
    if (!data.anti_stall_active) return false;

    // Check if expired
    if (data.anti_stall_until && new Date() > data.anti_stall_until) {
      // Restore original values
      await restoreFromAntiStall(db, data);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[StateTracker] Error checking anti-stall status:', err.message);
    return false;
  }
}

/**
 * Restore original thresholds after anti-stall expires
 */
async function restoreFromAntiStall(db, config) {
  try {
    if (config.anti_stall_previous_values) {
      const restored = {
        confidence_min: config.anti_stall_previous_values.confidence_min,
        quantum_min: config.anti_stall_previous_values.quantum_min,
        timing_min: config.anti_stall_previous_values.timing_min,
        anti_stall_active: false
      };

      await db.collection('system_runtime_config')
        .doc('trading_params_live')
        .update(restored);

      console.log('✅ [StateTracker] Anti-stall expired, thresholds restored');

      // Log restoration
      await db.collection('anti_stall_events').add({
        timestamp: new Date(),
        event_type: 'ANTI_STALL_EXPIRED',
        action: 'thresholds_restored',
        restored_values: restored
      });
    }
  } catch (err) {
    console.error('[StateTracker] Error restoring from anti-stall:', err.message);
  }
}

/**
 * Fase 9: Real operational state validation
 *
 * State machine:
 * - healthy: signals present, executions real, closures real
 * - degraded: signals present but no execution
 * - stalled: no signals, no intents
 * - paused: pause_execution = true
 */
function determineOperationalState(cycleMetrics, pauseStatus) {
  try {
    const {
      signals_emitted = 0,
      intents_created = 0,
      executions = 0,
      closures = 0,
      last_signal_age_ms = Infinity,
      last_execution_age_ms = Infinity
    } = cycleMetrics || {};

    // Check pause status
    if (pauseStatus?.pause_execution) {
      return {
        state: 'paused',
        reason: 'pause_execution_flag_set',
        severity: 'medium',
        timestamp: new Date()
      };
    }

    // Healthy: signals → intents → executions → closures
    if (signals_emitted > 0 && intents_created > 0 && executions > 0 && closures > 0) {
      return {
        state: 'healthy',
        reason: 'full_pipeline_operating',
        severity: 'low',
        signals: signals_emitted,
        intents: intents_created,
        executions,
        closures,
        timestamp: new Date()
      };
    }

    // Degraded: signals but no execution
    if (signals_emitted > 0 && (executions === 0 || intents_created === 0)) {
      return {
        state: 'degraded',
        reason: 'signals_blocked_at_execution',
        severity: 'high',
        signals: signals_emitted,
        intents: intents_created,
        executions,
        timestamp: new Date()
      };
    }

    // Stalled: no signals, no intents
    if (signals_emitted === 0 && intents_created === 0) {
      return {
        state: 'stalled',
        reason: 'no_signals_no_intents',
        severity: 'critical',
        last_signal_age_ms,
        last_execution_age_ms,
        timestamp: new Date()
      };
    }

    // Default: unknown
    return {
      state: 'unknown',
      reason: 'unexpected_state',
      severity: 'high',
      timestamp: new Date()
    };

  } catch (err) {
    console.error('[StateTracker] Error determining state:', err.message);
    return {
      state: 'unknown',
      reason: 'error_determining_state',
      severity: 'high',
      error: err.message,
      timestamp: new Date()
    };
  }
}

/**
 * Track operational metrics over time
 */
function trackOperationalMetrics(cycleMetrics) {
  try {
    return {
      timestamp: new Date(),
      empty_cycles: emptyCycleCount,
      failed_executions: consecutiveFailedExecutions,
      last_signal_time: lastSignalTime,
      last_execution_time: lastExecutionTime,
      last_closure_time: lastClosureTime,
      time_since_last_signal_ms: lastSignalTime ? Date.now() - lastSignalTime.getTime() : null,
      time_since_last_execution_ms: lastExecutionTime ? Date.now() - lastExecutionTime.getTime() : null,
      time_since_last_closure_ms: lastClosureTime ? Date.now() - lastClosureTime.getTime() : null
    };
  } catch (err) {
    console.error('[StateTracker] Error tracking metrics:', err.message);
    return null;
  }
}

/**
 * Reset all trackers (for testing or manual reset)
 */
function reset() {
  emptyCycleCount = 0;
  consecutiveFailedExecutions = 0;
  lastSignalTime = null;
  lastExecutionTime = null;
  lastClosureTime = null;
  console.log('✅ [StateTracker] All state trackers reset');
}

module.exports = {
  trackEmptyCycle,
  triggerAntiStall,
  isAntiStallActive,
  restoreFromAntiStall,
  determineOperationalState,
  trackOperationalMetrics,
  reset,
  EMPTY_CYCLE_THRESHOLD,
  ANTI_STALL_THRESHOLD_REDUCTION
};
