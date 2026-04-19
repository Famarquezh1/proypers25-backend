/**
 * RUNTIME CONFIG MANAGER
 *
 * Gestiona lectura dinámica de parámetros desde Firestore.
 * - Caché de 30-60s
 * - Fallback a valores seguros
 * - Orden de prioridad: symbol > global > defaults
 * - Sin redeploy requerido
 */

const DEFAULT_GLOBAL_PARAMS = {
  confidence_min: 0.65,
  quantum_min: 0.60,
  timing_min: 0.55,
  rr_min: 1.20,
  min_expected_move_pct: 0.25,
  execution_score_min: 50,
  pause_execution: false,
  pause_until: null,
  autocalibration_enabled: true
};

const HARD_LIMITS = {
  confidence_min: { min: 0.60, max: 0.85 },
  quantum_min: { min: 0.55, max: 0.85 },
  timing_min: { min: 0.50, max: 0.85 },
  rr_min: { min: 1.10, max: 2.00 },
  min_expected_move_pct: { min: 0.15, max: 1.00 },
  execution_score_min: { min: 45, max: 100 }
};

const CACHE_TTL_MS = 45 * 1000; // 45 segundos

let globalConfigCache = null;
let globalConfigCacheTime = 0;
let symbolConfigCache = null;
let symbolConfigCacheTime = 0;

/**
 * Carga configuración global desde Firestore con caché
 */
async function loadGlobalConfig(db) {
  try {
    const now = Date.now();
    if (globalConfigCache && now - globalConfigCacheTime < CACHE_TTL_MS) {
      return globalConfigCache;
    }

    const doc = await db.collection('system_runtime_config').doc('trading_params_live').get();

    if (doc.exists) {
      const data = doc.data();
      globalConfigCache = {
        ...DEFAULT_GLOBAL_PARAMS,
        ...data,
        updated_at: data.updated_at || new Date()
      };
    } else {
      globalConfigCache = { ...DEFAULT_GLOBAL_PARAMS };
    }

    globalConfigCacheTime = now;
    return globalConfigCache;
  } catch (err) {
    console.error('[RuntimeConfig] Error loading global config:', err.message);
    return globalConfigCache || { ...DEFAULT_GLOBAL_PARAMS };
  }
}

/**
 * Carga configuración por símbolo desde Firestore con caché
 */
async function loadSymbolConfigs(db) {
  try {
    const now = Date.now();
    if (symbolConfigCache && now - symbolConfigCacheTime < CACHE_TTL_MS) {
      return symbolConfigCache;
    }

    const doc = await db.collection('system_runtime_config').doc('symbol_params_live').get();

    if (doc.exists) {
      symbolConfigCache = doc.data() || {};
    } else {
      symbolConfigCache = {};
    }

    symbolConfigCacheTime = now;
    return symbolConfigCache;
  } catch (err) {
    console.error('[RuntimeConfig] Error loading symbol configs:', err.message);
    return symbolConfigCache || {};
  }
}

/**
 * Obtiene parámetros efectivos para un símbolo
 * Orden: symbol override > global > defaults
 */
async function getEffectiveParams(db, symbol) {
  try {
    const globalConfig = await loadGlobalConfig(db);
    const symbolConfigs = await loadSymbolConfigs(db);
    const symbolConfig = symbolConfigs[symbol] || {};

    return {
      confidence_min: symbolConfig.confidence_min ?? globalConfig.confidence_min ?? 0.65,
      quantum_min: symbolConfig.quantum_min ?? globalConfig.quantum_min ?? 0.60,
      timing_min: symbolConfig.timing_min ?? globalConfig.timing_min ?? 0.55,
      rr_min: symbolConfig.rr_min ?? globalConfig.rr_min ?? 1.20,
      min_expected_move_pct: symbolConfig.min_expected_move_pct ?? globalConfig.min_expected_move_pct ?? 0.25,
      execution_score_min: symbolConfig.execution_score_min ?? globalConfig.execution_score_min ?? 50,
      pause_execution: globalConfig.pause_execution ?? false,
      pause_until: globalConfig.pause_until,
      symbol_enabled: symbolConfig.enabled !== false,
      symbol_pause_until: symbolConfig.pause_until,
      autocalibration_enabled: globalConfig.autocalibration_enabled ?? true
    };
  } catch (err) {
    console.error('[RuntimeConfig] Error getting effective params:', err.message);
    return {
      confidence_min: 0.65,
      quantum_min: 0.60,
      timing_min: 0.55,
      rr_min: 1.20,
      min_expected_move_pct: 0.25,
      execution_score_min: 50,
      pause_execution: false,
      pause_until: null,
      symbol_enabled: true,
      symbol_pause_until: null,
      autocalibration_enabled: true
    };
  }
}

/**
 * Valida y aplica límites duros a los parámetros
 */
function applyHardLimits(params) {
  const limited = { ...params };

  for (const [key, limits] of Object.entries(HARD_LIMITS)) {
    if (limited[key] !== undefined && typeof limited[key] === 'number') {
      limited[key] = Math.max(limits.min, Math.min(limits.max, limited[key]));
    }
  }

  return limited;
}

/**
 * Actualiza configuración global en Firestore
 */
async function updateGlobalConfig(db, updates, reason = 'manual_update') {
  try {
    const validated = applyHardLimits(updates);

    const batch = db.batch();
    const configRef = db.collection('system_runtime_config').doc('trading_params_live');

    batch.set(configRef, {
      ...validated,
      updated_at: new Date(),
      updated_by: reason
    }, { merge: true });

    // Guardar en historial
    const historyRef = db.collection('autocalibration_history').doc();
    batch.set(historyRef, {
      scope: 'global',
      symbol: null,
      prev_values: await loadGlobalConfig(db),
      new_values: validated,
      reason,
      timestamp: new Date(),
      applied_limits: true
    });

    await batch.commit();

    // Invalidar caché
    globalConfigCacheTime = 0;

    console.log('[RuntimeConfig] Global config updated:', { updates: validated, reason });
    return validated;
  } catch (err) {
    console.error('[RuntimeConfig] Error updating global config:', err.message);
    throw err;
  }
}

/**
 * Actualiza configuración por símbolo en Firestore
 */
async function updateSymbolConfig(db, symbol, updates, reason = 'manual_update') {
  try {
    const validated = applyHardLimits(updates);

    const batch = db.batch();
    const configRef = db.collection('system_runtime_config').doc('symbol_params_live');

    const currentConfigs = await loadSymbolConfigs(db);
    const newConfigs = {
      ...currentConfigs,
      [symbol]: {
        ...currentConfigs[symbol],
        ...validated,
        updated_at: new Date()
      }
    };

    batch.set(configRef, newConfigs, { merge: true });

    // Guardar en historial
    const historyRef = db.collection('autocalibration_history').doc();
    batch.set(historyRef, {
      scope: 'symbol',
      symbol,
      prev_values: currentConfigs[symbol] || {},
      new_values: validated,
      reason,
      timestamp: new Date(),
      applied_limits: true
    });

    await batch.commit();

    // Invalidar caché
    symbolConfigCacheTime = 0;

    console.log('[RuntimeConfig] Symbol config updated:', { symbol, updates: validated, reason });
    return validated;
  } catch (err) {
    console.error('[RuntimeConfig] Error updating symbol config:', err.message);
    throw err;
  }
}

/**
 * Pausa la ejecución global
 */
async function pauseExecution(db, pauseMinutes = 10, reason = 'degradation_detected') {
  try {
    const pauseUntil = new Date(Date.now() + pauseMinutes * 60 * 1000);

    await updateGlobalConfig(db, {
      pause_execution: true,
      pause_until: pauseUntil
    }, `[PAUSE] ${reason}`);

    console.log('[RuntimeConfig] Execution paused until:', pauseUntil.toISOString());
  } catch (err) {
    console.error('[RuntimeConfig] Error pausing execution:', err.message);
  }
}

/**
 * Pausa un símbolo específico
 */
async function pauseSymbol(db, symbol, pauseMinutes = 30, reason = 'symbol_degradation') {
  try {
    const pauseUntil = new Date(Date.now() + pauseMinutes * 60 * 1000);

    await updateSymbolConfig(db, symbol, {
      enabled: false,
      pause_until: pauseUntil,
      pause_reason: reason
    }, `[SYMBOL_PAUSE] ${reason}`);

    console.log('[RuntimeConfig] Symbol paused:', { symbol, until: pauseUntil.toISOString() });
  } catch (err) {
    console.error('[RuntimeConfig] Error pausing symbol:', err.message);
  }
}

/**
 * Reanuda la ejecución global
 */
async function resumeExecution(db, reason = 'manual_resume') {
  try {
    await updateGlobalConfig(db, {
      pause_execution: false,
      pause_until: null
    }, `[RESUME] ${reason}`);

    console.log('[RuntimeConfig] Execution resumed');
  } catch (err) {
    console.error('[RuntimeConfig] Error resuming execution:', err.message);
  }
}

/**
 * Reanuda un símbolo específico
 */
async function resumeSymbol(db, symbol, reason = 'manual_resume') {
  try {
    await updateSymbolConfig(db, symbol, {
      enabled: true,
      pause_until: null,
      pause_reason: null
    }, `[SYMBOL_RESUME] ${reason}`);

    console.log('[RuntimeConfig] Symbol resumed:', symbol);
  } catch (err) {
    console.error('[RuntimeConfig] Error resuming symbol:', err.message);
  }
}

/**
 * Obtiene el estado actual de pausas
 */
async function getPauseStatus(db) {
  try {
    const globalConfig = await loadGlobalConfig(db);
    const symbolConfigs = await loadSymbolConfigs(db);

    const pausedSymbols = Object.entries(symbolConfigs)
      .filter(([_, cfg]) => cfg.enabled === false)
      .map(([sym, cfg]) => ({
        symbol: sym,
        pause_until: cfg.pause_until,
        reason: cfg.pause_reason
      }));

    const globalPaused = globalConfig.pause_execution &&
      (!globalConfig.pause_until || new Date(globalConfig.pause_until) > new Date());

    return {
      execution_paused: globalPaused,
      pause_until: globalConfig.pause_until,
      paused_symbols: pausedSymbols
    };
  } catch (err) {
    console.error('[RuntimeConfig] Error getting pause status:', err.message);
    return {
      execution_paused: false,
      pause_until: null,
      paused_symbols: []
    };
  }
}

/**
 * Obtiene historial de cambios
 */
async function getCalibrationHistory(db, limit = 100) {
  try {
    const snap = await db.collection('autocalibration_history')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(doc => doc.data());
  } catch (err) {
    console.error('[RuntimeConfig] Error getting calibration history:', err.message);
    return [];
  }
}

module.exports = {
  loadGlobalConfig,
  loadSymbolConfigs,
  getEffectiveParams,
  applyHardLimits,
  updateGlobalConfig,
  updateSymbolConfig,
  pauseExecution,
  pauseSymbol,
  resumeExecution,
  resumeSymbol,
  getPauseStatus,
  getCalibrationHistory,
  HARD_LIMITS,
  DEFAULT_GLOBAL_PARAMS,
  CACHE_TTL_MS
};
