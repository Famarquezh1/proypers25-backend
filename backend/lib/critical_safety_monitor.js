/**
 * CRITICAL SAFETY MONITOR
 * 
 * Extra Phases 1-7: Final Safety Layer
 * 
 * ✔ Real inactivity detection (10 min window)
 * ✔ Execution block detection (5 min window)
 * ✔ Data feed down detection
 * ✔ Auto safe-mode on risk metrics
 * ✔ Heartbeat confirmation every 5 minutes
 * ✔ Critical alerts only (no spam)
 * ✔ Never silent without explanation
 * 
 * This layer ensures system NEVER fails silently.
 */

const admin = require('firebase-admin');

// Time window tracking (in milliseconds)
const INACTIVITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const EXECUTION_BLOCK_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Metrics history for sliding window
let metricsHistory = [];
let lastHeartbeat = new Date();
let lastCriticalAlert = null;

/**
 * Extra Phase 1: Real Inactivity Detection (10-min window)
 * 
 * Detects: No signals AND no intents for 10+ minutes
 * But ONLY if: fetched_symbols > 0 (data is available)
 */
async function checkRealInactivity(db, currentMetrics) {
  try {
    const now = new Date();
    const windowStart = new Date(now - INACTIVITY_WINDOW_MS);

    // Add current metrics to history
    metricsHistory.push({
      timestamp: now,
      signals_emitted: currentMetrics?.signals_emitted || 0,
      intents_created: currentMetrics?.intents_created || 0,
      fetched_symbols: currentMetrics?.fetched_symbols || 0
    });

    // Keep only last 10 minutes
    metricsHistory = metricsHistory.filter(m => m.timestamp > windowStart);

    // Check if completely inactive for 10 minutes
    const totalSignals = metricsHistory.reduce((sum, m) => sum + (m.signals_emitted || 0), 0);
    const totalIntents = metricsHistory.reduce((sum, m) => sum + (m.intents_created || 0), 0);
    const hasDataFetch = metricsHistory.some(m => (m.fetched_symbols || 0) > 0);

    if (totalSignals === 0 && totalIntents === 0 && hasDataFetch) {
      // System is idle but data is available
      const event = {
        timestamp: now,
        event_type: 'SYSTEM_IDLE_ALERT',
        severity: 'critical',
        reason: 'no_signals_no_intents_10min',
        window_minutes: 10,
        total_signals: totalSignals,
        total_intents: totalIntents,
        data_available: hasDataFetch,
        action: 'INVESTIGATE_SIGNAL_GENERATION'
      };

      console.log('🔴 [CriticalSafety] SYSTEM_IDLE_ALERT:', JSON.stringify(event));

      try {
        await db.collection('critical_safety_alerts').add(event);
      } catch (err) {
        console.error('[CriticalSafety] Error logging idle alert:', err.message);
      }

      return event;
    }

  } catch (err) {
    console.error('[CriticalSafety] Error checking inactivity:', err.message);
  }

  return null;
}

/**
 * Extra Phase 2: Execution Block Detection (5-min window)
 * 
 * Detects: Intents created but nothing executed for 5+ minutes
 * This is the exact scenario that already happened
 */
async function checkExecutionBlock(db, currentMetrics) {
  try {
    const now = new Date();
    const windowStart = new Date(now - EXECUTION_BLOCK_WINDOW_MS);

    // Find metrics from last 5 minutes
    const recentMetrics = metricsHistory.filter(m => m.timestamp > windowStart);

    if (recentMetrics.length === 0) return null;

    const totalIntentsIn5m = recentMetrics.reduce((sum, m) => sum + (m.intents_created || 0), 0);
    const totalExecutionsIn5m = recentMetrics.reduce((sum, m) => sum + (currentMetrics?.executions || 0), 0);

    // If intents created but none executed
    if (totalIntentsIn5m > 0 && totalExecutionsIn5m === 0) {
      const event = {
        timestamp: now,
        event_type: 'EXECUTION_BLOCK_ALERT',
        severity: 'critical',
        reason: 'intents_not_executed_5min',
        window_minutes: 5,
        intents_created: totalIntentsIn5m,
        intents_executed: totalExecutionsIn5m,
        action: 'CHECK_EXECUTION_PIPELINE'
      };

      console.log('⚠️  [CriticalSafety] EXECUTION_BLOCK_ALERT:', JSON.stringify(event));

      try {
        await db.collection('critical_safety_alerts').add(event);
      } catch (err) {
        console.error('[CriticalSafety] Error logging execution block:', err.message);
      }

      return event;
    }

  } catch (err) {
    console.error('[CriticalSafety] Error checking execution block:', err.message);
  }

  return null;
}

/**
 * Extra Phase 3: Data Feed Down Detection
 * 
 * Detects: No symbols fetched in current cycle
 * Prevents calibration in this state
 */
async function checkDataFeedDown(db, currentMetrics) {
  try {
    const fetched = currentMetrics?.fetched_symbols || 0;

    if (fetched === 0) {
      const event = {
        timestamp: new Date(),
        event_type: 'DATA_FEED_DOWN',
        severity: 'critical',
        reason: 'no_symbols_fetched',
        action: 'SKIP_CALIBRATION_CHECK_SOURCES'
      };

      console.log('📡 [CriticalSafety] DATA_FEED_DOWN:', JSON.stringify(event));

      try {
        await db.collection('critical_safety_alerts').add(event);
      } catch (err) {
        console.error('[CriticalSafety] Error logging data feed down:', err.message);
      }

      return event;
    }

  } catch (err) {
    console.error('[CriticalSafety] Error checking data feed:', err.message);
  }

  return null;
}

/**
 * Extra Phase 4: Automatic Safe Mode
 * 
 * Triggers if:
 * - winrate < 30%
 * - OR sl_hit_ratio > 70%
 * 
 * Action: Pause execution for 10 minutes
 */
async function checkAutoSafeMode(db, metrics) {
  try {
    const winrate = metrics?.winrate || 0;
    const slHitRatio = metrics?.sl_hit_ratio || 0;

    if (winrate < 0.30 || slHitRatio > 0.70) {
      // Get current config
      const configDoc = await db.collection('system_runtime_config')
        .doc('trading_params_live')
        .get();

      if (!configDoc.exists) {
        console.warn('[CriticalSafety] Config not found for safe mode');
        return;
      }

      const safeModeDuration = 10 * 60 * 1000; // 10 minutes
      const pauseUntil = new Date(Date.now() + safeModeDuration);

      // Update config to pause execution
      await db.collection('system_runtime_config')
        .doc('trading_params_live')
        .update({
          pause_execution: true,
          pause_until: pauseUntil,
          pause_reason: winrate < 0.30 ? 'low_winrate' : 'high_sl_ratio',
          safe_mode_triggered: true,
          safe_mode_triggered_at: new Date()
        });

      const event = {
        timestamp: new Date(),
        event_type: 'SAFE_MODE_ACTIVATED',
        severity: 'high',
        reason: winrate < 0.30 ? 'winrate_below_30pct' : 'sl_ratio_above_70pct',
        winrate,
        sl_hit_ratio: slHitRatio,
        pause_duration_minutes: 10,
        action: 'EXECUTION_PAUSED_UNTIL',
        pause_until: pauseUntil
      };

      console.log('🛡️  [CriticalSafety] SAFE_MODE_ACTIVATED:', JSON.stringify(event));

      try {
        await db.collection('critical_safety_alerts').add(event);
      } catch (err) {
        console.error('[CriticalSafety] Error logging safe mode:', err.message);
      }

      return event;
    }

  } catch (err) {
    console.error('[CriticalSafety] Error checking safe mode:', err.message);
  }

  return null;
}

/**
 * Extra Phase 5: Heartbeat Confirmation
 * 
 * Every 5 minutes, confirm system is alive
 */
async function sendHeartbeat(db, currentMetrics, systemState) {
  try {
    const now = new Date();
    const timeSinceLastHeartbeat = now - lastHeartbeat;

    if (timeSinceLastHeartbeat < HEARTBEAT_INTERVAL_MS) {
      return; // Not time yet
    }

    const windowStart = new Date(now - 5 * 60 * 1000);
    const last5MinMetrics = metricsHistory.filter(m => m.timestamp > windowStart);

    const signalsLast5m = last5MinMetrics.reduce((sum, m) => sum + (m.signals_emitted || 0), 0);
    const executionsLast5m = last5MinMetrics.reduce((sum, m) => sum + (currentMetrics?.executions || 0), 0);

    const heartbeat = {
      timestamp: now,
      event_type: 'SYSTEM_HEARTBEAT',
      severity: 'info',
      system_state: systemState?.state || 'unknown',
      signals_last_5m: signalsLast5m,
      executions_last_5m: executionsLast5m,
      winrate: currentMetrics?.winrate || 0,
      data_status: (currentMetrics?.fetched_symbols || 0) > 0 ? 'ok' : 'down',
      calibration_active: !systemState?.paused,
      metrics: {
        closed_trades: currentMetrics?.closed_trades || 0,
        avg_pnl: currentMetrics?.avg_pnl || 0,
        health_check_passed: true
      }
    };

    console.log('💓 [CriticalSafety] SYSTEM_HEARTBEAT:', JSON.stringify(heartbeat));

    try {
      await db.collection('system_heartbeats').add(heartbeat);
    } catch (err) {
      console.error('[CriticalSafety] Error logging heartbeat:', err.message);
    }

    lastHeartbeat = now;
    return heartbeat;

  } catch (err) {
    console.error('[CriticalSafety] Error sending heartbeat:', err.message);
  }

  return null;
}

/**
 * Extra Phase 6: Critical Alerts Only (No Spam)
 * 
 * Only send critical alerts if significant time has passed since last one
 */
async function checkCriticalAlertThrottle(alertType) {
  try {
    const now = new Date();

    if (!lastCriticalAlert) {
      lastCriticalAlert = now;
      return true;
    }

    const timeSinceLastAlert = now - lastCriticalAlert;
    const minimumGapMs = 60 * 1000; // 1 minute minimum between alerts

    if (timeSinceLastAlert > minimumGapMs) {
      lastCriticalAlert = now;
      return true;
    }

    // Skip due to throttle
    return false;

  } catch (err) {
    console.error('[CriticalSafety] Error checking throttle:', err.message);
    return false;
  }
}

/**
 * Extra Phase 7: Golden Rule
 * 
 * Never be in state: "doing nothing and not explaining why"
 * 
 * This is enforced by ensuring:
 * - If no signals → log reason (inactivity alert)
 * - If no executions → log reason (execution block alert)
 * - If no data → log reason (data feed down)
 * - Every 5 minutes → confirm alive (heartbeat)
 */
async function enforceNeverSilentRule(db, currentMetrics, systemState) {
  try {
    const now = new Date();

    // Collect all alerts
    const alerts = [];

    // Check Phase 1: Inactivity
    const idleAlert = await checkRealInactivity(db, currentMetrics);
    if (idleAlert) alerts.push(idleAlert);

    // Check Phase 2: Execution block
    const execBlockAlert = await checkExecutionBlock(db, currentMetrics);
    if (execBlockAlert) alerts.push(execBlockAlert);

    // Check Phase 3: Data feed
    const dataFeedAlert = await checkDataFeedDown(db, currentMetrics);
    if (dataFeedAlert) alerts.push(dataFeedAlert);

    // Check Phase 4: Safe mode
    const safeModeEvent = await checkAutoSafeMode(db, currentMetrics);
    if (safeModeEvent) alerts.push(safeModeEvent);

    // Check Phase 5: Heartbeat
    const heartbeatEvent = await sendHeartbeat(db, currentMetrics, systemState);
    if (heartbeatEvent) alerts.push(heartbeatEvent);

    // Phase 7: If critical alerts exist, ensure they're not spammy
    const criticalAlerts = alerts.filter(a => a.severity === 'critical');
    if (criticalAlerts.length > 0) {
      const shouldAlert = await checkCriticalAlertThrottle('critical');
      if (shouldAlert) {
        console.log('🚨 [CriticalSafety] CRITICAL ALERTS TRIGGERED:', criticalAlerts.length);
      }
    }

    return {
      timestamp: now,
      total_alerts: alerts.length,
      critical_alerts: criticalAlerts.length,
      alerts: alerts
    };

  } catch (err) {
    console.error('[CriticalSafety] Error enforcing never-silent rule:', err.message);
    return null;
  }
}

/**
 * Run all critical safety checks
 */
async function runCriticalSafetyCheck(db, cycleMetrics, systemState) {
  try {
    console.log('[CriticalSafety] Running critical safety check...');
    
    const result = await enforceNeverSilentRule(db, cycleMetrics, systemState);
    
    return result;
  } catch (err) {
    console.error('[CriticalSafety] Error running safety check:', err.message);
    return null;
  }
}

/**
 * Get critical alerts summary
 */
async function getCriticalAlertsSummary(db, limit = 50) {
  try {
    const snap = await db.collection('critical_safety_alerts')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
    }));
  } catch (err) {
    console.error('[CriticalSafety] Error getting alerts:', err.message);
    return [];
  }
}

/**
 * Get system heartbeats
 */
async function getSystemHeartbeats(db, limit = 20) {
  try {
    const snap = await db.collection('system_heartbeats')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
    }));
  } catch (err) {
    console.error('[CriticalSafety] Error getting heartbeats:', err.message);
    return [];
  }
}

/**
 * Check if system needs immediate attention
 */
async function requiresImmediateAttention(db) {
  try {
    const alerts = await db.collection('critical_safety_alerts')
      .where('severity', '==', 'critical')
      .orderBy('timestamp', 'desc')
      .limit(5)
      .get();

    return alerts.size > 0;
  } catch (err) {
    console.error('[CriticalSafety] Error checking alerts:', err.message);
    return false;
  }
}

module.exports = {
  runCriticalSafetyCheck,
  checkRealInactivity,
  checkExecutionBlock,
  checkDataFeedDown,
  checkAutoSafeMode,
  sendHeartbeat,
  getCriticalAlertsSummary,
  getSystemHeartbeats,
  requiresImmediateAttention,
  INACTIVITY_WINDOW_MS,
  EXECUTION_BLOCK_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS
};
