/**
 * CALIBRATION HEALTH ENDPOINT
 *
 * GET /api/system/runtime-calibration-health
 *
 * Provee status completo del sistema de auto-calibración
 */

const express = require('express');
const RuntimeConfigManager = require('../lib/runtime_config_manager');
const MetricsAggregator = require('../lib/trade_metrics_aggregator');
const AutocalibrationJob = require('../jobs/autocalibration_cycle');

function createCalibrationHealthRouter(db) {
  const router = express.Router();

  /**
   * GET /api/system/runtime-calibration-health
   */
  router.get('/system/runtime-calibration-health', async (req, res) => {
    try {
      const now = new Date();

      // Cargar configuraciones
      const globalConfig = await RuntimeConfigManager.loadGlobalConfig(db);
      const symbolConfigs = await RuntimeConfigManager.loadSymbolConfigs(db);
      const pauseStatus = await RuntimeConfigManager.getPauseStatus(db);

      // Cargar métricas
      const globalMetrics = await MetricsAggregator.getGlobalMetrics(db);
      const allSymbolMetrics = await MetricsAggregator.getAllSymbolMetrics(db);

      // Obtener logs recientes
      const recentLogs = await AutocalibrationJob.getRecentCalibrationLogs(db, 5);

      // Construir respuesta
      const health = {
        timestamp: now.toISOString(),
        system_status: 'ok',
        autocalibration: {
          enabled: globalConfig.autocalibration_enabled ?? true,
          cycle_interval_minutes: parseInt(process.env.AUTOCALIBRATION_CYCLE_MINUTES || '15', 10),
          last_cycle: recentLogs[0]?.cycle_executed_at || null
        },
        global_config: {
          confidence_min: globalConfig.confidence_min,
          quantum_min: globalConfig.quantum_min,
          timing_min: globalConfig.timing_min,
          rr_min: globalConfig.rr_min,
          min_expected_move_pct: globalConfig.min_expected_move_pct,
          execution_score_min: globalConfig.execution_score_min,
          updated_at: globalConfig.updated_at
        },
        execution_status: {
          paused: pauseStatus.execution_paused,
          pause_until: pauseStatus.pause_until,
          paused_symbols_count: pauseStatus.paused_symbols.length,
          paused_symbols: pauseStatus.paused_symbols
        },
        metrics: {
          global: globalMetrics ? {
            closed_trades: globalMetrics.closed_trades_count,
            winrate: globalMetrics.winrate,
            avg_pnl: globalMetrics.avg_pnl,
            tp_hit_ratio: globalMetrics.tp_hit_ratio,
            sl_hit_ratio: globalMetrics.sl_hit_ratio,
            avg_duration_minutes: globalMetrics.avg_duration_minutes,
            updated_at: globalMetrics.updated_at
          } : null,
          symbols: Object.entries(allSymbolMetrics).map(([symbol, metrics]) => ({
            symbol,
            closed_trades: metrics.closed_trades_count,
            winrate: metrics.winrate,
            avg_pnl: metrics.avg_pnl,
            updated_at: metrics.updated_at
          }))
        },
        symbol_configs_count: Object.keys(symbolConfigs).length,
        recent_cycles: recentLogs.slice(0, 3).map(log => ({
          executed_at: log.cycle_executed_at,
          global_updates: !!log.global_updates,
          symbols_updated: Object.keys(log.symbol_updates || {}).length,
          safety_triggered: !!log.safety_action,
          error: log.error
        }))
      };

      res.json(health);
    } catch (err) {
      console.error('[CalibrationHealth] Error:', err.message);
      res.status(500).json({
        error: 'Failed to retrieve calibration health',
        message: err.message
      });
    }
  });

  /**
   * GET /api/system/calibration-history
   */
  router.get('/system/calibration-history', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
      const history = await RuntimeConfigManager.getCalibrationHistory(db, limit);

      res.json({
        count: history.length,
        history
      });
    } catch (err) {
      console.error('[CalibrationHistory] Error:', err.message);
      res.status(500).json({
        error: 'Failed to retrieve calibration history',
        message: err.message
      });
    }
  });

  /**
   * POST /api/system/calibration/force
   * Fuerza un ciclo de calibración inmediato
   */
  router.post('/system/calibration/force', async (req, res) => {
    try {
      const AutocalibrationEngine = require('../lib/autocalibration_engine');
      const result = await AutocalibrationEngine.forceRecalibration(db);

      res.json({
        message: 'Calibration cycle forced',
        result
      });
    } catch (err) {
      console.error('[ForceCalibration] Error:', err.message);
      res.status(500).json({
        error: 'Failed to force calibration',
        message: err.message
      });
    }
  });

  /**
   * POST /api/system/calibration/reset
   * Resetea la configuración a valores por defecto
   */
  router.post('/system/calibration/reset', async (req, res) => {
    try {
      const AutocalibrationEngine = require('../lib/autocalibration_engine');
      const scope = req.body.scope || 'all';
      const result = await AutocalibrationEngine.resetToDefaults(db, scope);

      res.json(result);
    } catch (err) {
      console.error('[ResetCalibration] Error:', err.message);
      res.status(500).json({
        error: 'Failed to reset calibration',
        message: err.message
      });
    }
  });

  /**
   * GET /api/system/runtime-config/global
   */
  router.get('/system/runtime-config/global', async (req, res) => {
    try {
      const config = await RuntimeConfigManager.loadGlobalConfig(db);
      res.json({
        config,
        hard_limits: RuntimeConfigManager.HARD_LIMITS
      });
    } catch (err) {
      console.error('[GetGlobalConfig] Error:', err.message);
      res.status(500).json({
        error: 'Failed to retrieve global config',
        message: err.message
      });
    }
  });

  /**
   * GET /api/system/runtime-config/symbols
   */
  router.get('/system/runtime-config/symbols', async (req, res) => {
    try {
      const configs = await RuntimeConfigManager.loadSymbolConfigs(db);
      res.json({
        count: Object.keys(configs).length,
        configs
      });
    } catch (err) {
      console.error('[GetSymbolConfigs] Error:', err.message);
      res.status(500).json({
        error: 'Failed to retrieve symbol configs',
        message: err.message
      });
    }
  });

  /**
   * POST /api/system/runtime-config/update-global
   */
  router.post('/system/runtime-config/update-global', async (req, res) => {
    try {
      const { updates, reason } = req.body;

      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'updates must be an object'
        });
      }

      const result = await RuntimeConfigManager.updateGlobalConfig(
        db,
        updates,
        reason || 'manual_api_update'
      );

      res.json({
        message: 'Global config updated',
        result
      });
    } catch (err) {
      console.error('[UpdateGlobalConfig] Error:', err.message);
      res.status(500).json({
        error: 'Failed to update global config',
        message: err.message
      });
    }
  });

  /**
   * POST /api/system/runtime-config/update-symbol
   */
  router.post('/system/runtime-config/update-symbol', async (req, res) => {
    try {
      const { symbol, updates, reason } = req.body;

      if (!symbol || !updates || typeof updates !== 'object') {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'symbol and updates are required'
        });
      }

      const result = await RuntimeConfigManager.updateSymbolConfig(
        db,
        symbol,
        updates,
        reason || 'manual_api_update'
      );

      res.json({
        message: 'Symbol config updated',
        result
      });
    } catch (err) {
      console.error('[UpdateSymbolConfig] Error:', err.message);
      res.status(500).json({
        error: 'Failed to update symbol config',
        message: err.message
      });
    }
  });

  /**
   * POST /api/system/execution/pause
   */
  router.post('/system/execution/pause', async (req, res) => {
    try {
      const { minutes, reason } = req.body;
      await RuntimeConfigManager.pauseExecution(db, minutes || 10, reason || 'manual_pause');

      res.json({
        message: 'Execution paused'
      });
    } catch (err) {
      console.error('[PauseExecution] Error:', err.message);
      res.status(500).json({
        error: 'Failed to pause execution',
        message: err.message
      });
    }
  });

  /**
   * POST /api/system/execution/resume
   */
  router.post('/system/execution/resume', async (req, res) => {
    try {
      const { reason } = req.body;
      await RuntimeConfigManager.resumeExecution(db, reason || 'manual_resume');

      res.json({
        message: 'Execution resumed'
      });
    } catch (err) {
      console.error('[ResumeExecution] Error:', err.message);
      res.status(500).json({
        error: 'Failed to resume execution',
        message: err.message
      });
    }
  });

  return router;
}

module.exports = {
  createCalibrationHealthRouter
};
