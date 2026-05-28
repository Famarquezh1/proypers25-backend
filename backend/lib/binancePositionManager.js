const { FieldValue } = require('firebase-admin/firestore');
const { getBinanceBotConfig } = require('./binanceBotConfig');
const {
  getMarkPrice,
  getPositionRisk,
  closePositionMarket
} = require('./binanceFuturesExecutor');
const {
  evaluatePositionDiscipline,
  logExecutionDiscipline
} = require('./execution_discipline_engine');
const {
  ensureSymbolObservation,
  releaseSymbolObservation,
  getMarketSnapshot,
  syncOperationalMarketObservation
} = require('../services/market/marketStreamWorker');
const { normalizeToBinance } = require('../services/utils/symbolNormalizer');
const {
  updateImpulseLifecycle
} = require('../services/execution/impulseLifecycleEngine');
const {
  evaluateAdaptiveExit,
  resolveAdaptiveExitConfig
} = require('../services/execution/adaptiveExitEngine');
const {
  resolveTradeCostConfig,
  estimateNetPnlPct,
  resolveNetOutcome
} = require('../services/execution/tradeCostModel');
const { syncPredictionClosedTradeState } = require('../services/execution/predictionExecutionSync');

const BINANCE_POSITION_MANAGER_ENABLED = true;
const BINANCE_POSITION_MANAGER_MAX_OPEN = Math.max(1, Number(process.env.BINANCE_POSITION_MANAGER_MAX_OPEN || 20));
const BINANCE_POSITION_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
const BINANCE_EARLY_EXIT_MIN_PROFIT_PCT = Number(process.env.BINANCE_EARLY_EXIT_MIN_PROFIT_PCT || 0.1);
const BINANCE_POSITION_STALE_EXIT_ENABLED =
  String(process.env.BINANCE_POSITION_STALE_EXIT_ENABLED || 'true').toLowerCase() !== 'false';
const BINANCE_POSITION_STALE_EXIT_RATIO = Math.max(
  0.5,
  Number(process.env.BINANCE_POSITION_STALE_EXIT_RATIO || 0.6)
);
const BINANCE_POSITION_STALE_EXIT_MAX_PNL_PCT = Number(
  process.env.BINANCE_POSITION_STALE_EXIT_MAX_PNL_PCT || -0.08
);
const BINANCE_POSITION_HC_STALE_EXIT_ENABLED =
  String(process.env.BINANCE_POSITION_HC_STALE_EXIT_ENABLED || 'false').toLowerCase() === 'true';
const BINANCE_POSITION_HC_STALE_EXIT_RATIO = Math.max(
  BINANCE_POSITION_STALE_EXIT_RATIO,
  Number(process.env.BINANCE_POSITION_HC_STALE_EXIT_RATIO || 0.85)
);
const BINANCE_POSITION_HC_STALE_EXIT_MAX_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HC_STALE_EXIT_MAX_PNL_PCT || -0.03
);
const BINANCE_POSITION_HC_MAX_HOLD_GRACE_PCT = Number(
  process.env.BINANCE_POSITION_HC_MAX_HOLD_GRACE_PCT || 0.05
);
const BINANCE_POSITION_HC_MAX_HOLD_EXTENSION_RATIO = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_HC_MAX_HOLD_EXTENSION_RATIO || 1.35)
);
const BINANCE_POSITION_STALE_GRACE_RATIO = Math.max(
  0.2,
  Math.min(0.8, Number(process.env.BINANCE_POSITION_STALE_GRACE_RATIO || 0.35))
);
const BINANCE_POSITION_STALE_CONFIRM_CYCLES = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_STALE_CONFIRM_CYCLES || 2)
);
const BINANCE_POSITION_MICRO_DRAWDOWN_TOLERANCE_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_MICRO_DRAWDOWN_TOLERANCE_PCT || 0.05)
);
const BINANCE_POSITION_NEGATIVE_CONFIRM_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_NEGATIVE_CONFIRM_PCT || 0.12)
);
const BINANCE_EVENT_STALE_GRACE_MS = Math.max(
  15000,
  Math.min(25000, Number(process.env.BINANCE_EVENT_STALE_GRACE_MS || 20000))
);
const BINANCE_EVENT_STALE_NEAR_TP_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_EVENT_STALE_NEAR_TP_PCT || 0.1)
);
const BINANCE_EVENT_STALE_MOMENTUM_MIN_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_EVENT_STALE_MOMENTUM_MIN_PCT || 0.04)
);
const BINANCE_EVENT_STALE_VOLATILITY_MIN_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_EVENT_STALE_VOLATILITY_MIN_PCT || 0.08)
);
const BINANCE_EVENT_STALE_CONFIRM_CYCLES = Math.max(
  BINANCE_POSITION_STALE_CONFIRM_CYCLES,
  Number(process.env.BINANCE_EVENT_STALE_CONFIRM_CYCLES || 3)
);
const BINANCE_POSITION_MAX_HOLD_MOMENTUM_PCT = Math.max(
  0.04,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_MOMENTUM_PCT || 0.15)
);
const BINANCE_POSITION_MAX_HOLD_POSITIVE_FLOOR_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_POSITIVE_FLOOR_PCT || 0.04)
);
const BINANCE_POSITION_PARTIAL_EXIT_RATIO = Math.min(
  0.8,
  Math.max(0.2, Number(process.env.BINANCE_POSITION_PARTIAL_EXIT_RATIO || 0.5))
);
const BINANCE_POSITION_PARTIAL_EXIT_MAX_COUNT = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_PARTIAL_EXIT_MAX_COUNT || 1)
);
const BINANCE_POSITION_TRAILING_TRIGGER_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_TRAILING_TRIGGER_PCT || 0.3)
);
const BINANCE_POSITION_TRAILING_RETRACE_RATIO = Math.min(
  0.9,
  Math.max(0.2, Number(process.env.BINANCE_POSITION_TRAILING_RETRACE_RATIO || 0.55))
);
const BINANCE_POSITION_TRAILING_MIN_LOCK_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_TRAILING_MIN_LOCK_PCT || 0.04)
);
const BINANCE_POSITION_PRE_MAX_HOLD_CAPTURE_RATIO = Math.min(
  0.98,
  Math.max(0.6, Number(process.env.BINANCE_POSITION_PRE_MAX_HOLD_CAPTURE_RATIO || 0.8))
);
const BINANCE_POSITION_PRE_MAX_HOLD_MIN_PROFIT_PCT = Math.max(
  resolveTradeCostConfig().minimum_gross_profit_pct,
  Number(process.env.BINANCE_POSITION_PRE_MAX_HOLD_MIN_PROFIT_PCT || 0.02)
);
const BINANCE_POSITION_PRE_MAX_HOLD_MIN_MFE_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_POSITION_PRE_MAX_HOLD_MIN_MFE_PCT || 0.05)
);
const BINANCE_POSITION_PROFIT_LOCK_MIN_MFE_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_POSITION_PROFIT_LOCK_MIN_MFE_PCT || 0.05)
);
const BINANCE_POSITION_PROFIT_LOCK_MIN_SECONDS = Math.max(
  60,
  Number(process.env.BINANCE_POSITION_PROFIT_LOCK_MIN_SECONDS || 90)
);
const BINANCE_POSITION_PROFIT_LOCK_RETRACE_RATIO = Math.min(
  0.9,
  Math.max(0.2, Number(process.env.BINANCE_POSITION_PROFIT_LOCK_RETRACE_RATIO || 0.35))
);
const BINANCE_POSITION_PROFIT_LOCK_MIN_FLOOR_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_PROFIT_LOCK_MIN_FLOOR_PCT || 0.025)
);
const BINANCE_POSITION_PROFIT_CAPTURE_MIN_ACTIVATION_PCT = Math.max(
  BINANCE_POSITION_PROFIT_LOCK_MIN_MFE_PCT,
  resolveTradeCostConfig().minimum_gross_profit_pct,
  Number(process.env.BINANCE_POSITION_PROFIT_CAPTURE_MIN_ACTIVATION_PCT || 0.13)
);
const BINANCE_POSITION_PROFIT_CAPTURE_NET_BUFFER_PCT = Math.max(
  resolveTradeCostConfig().minimum_gross_profit_pct,
  Number(process.env.BINANCE_POSITION_PROFIT_CAPTURE_NET_BUFFER_PCT || 0.02)
);
const BINANCE_POSITION_PROFIT_CAPTURE_MIN_RETRACE_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_PROFIT_CAPTURE_MIN_RETRACE_PCT || 0.03)
);
const BINANCE_POSITION_PROFIT_CAPTURE_RETRACE_RATIO = Math.min(
  0.9,
  Math.max(0.2, Number(process.env.BINANCE_POSITION_PROFIT_CAPTURE_RETRACE_RATIO || 0.45))
);
const BINANCE_POSITION_MAX_HOLD_EXTENSION_MIN_MFE_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_EXTENSION_MIN_MFE_PCT || 0.06)
);
const BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_COUNT = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_COUNT || 2)
);
const BINANCE_POSITION_MAX_HOLD_EXTENSION_NEGATIVE_FLOOR_PCT = Number(
  process.env.BINANCE_POSITION_MAX_HOLD_EXTENSION_NEGATIVE_FLOOR_PCT || -0.02
);
const BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_RETRACE_RATIO = Math.min(
  0.95,
  Math.max(0.2, Number(process.env.BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_RETRACE_RATIO || 0.75))
);
const BINANCE_POSITION_HOLD_DETERIORATION_RATIO = Math.min(
  0.95,
  Math.max(0.35, Number(process.env.BINANCE_POSITION_HOLD_DETERIORATION_RATIO || 0.65))
);
const BINANCE_POSITION_HOLD_DETERIORATION_CONFIRM_CYCLES = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_HOLD_DETERIORATION_CONFIRM_CYCLES || 1)
);
const BINANCE_POSITION_HOLD_DETERIORATION_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HOLD_DETERIORATION_PNL_PCT || -0.12
);
const BINANCE_POSITION_HOLD_DETERIORATION_MAX_MFE_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_HOLD_DETERIORATION_MAX_MFE_PCT || 0.05)
);
const BINANCE_POSITION_HOLD_DETERIORATION_NEAR_TP_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_HOLD_DETERIORATION_NEAR_TP_PCT || 0.1)
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_RATIO = Math.min(
  0.98,
  Math.max(
    BINANCE_POSITION_HOLD_DETERIORATION_RATIO,
    Number(process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_RATIO || 0.82)
  )
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_CONFIRM_CYCLES = Math.max(
  BINANCE_POSITION_HOLD_DETERIORATION_CONFIRM_CYCLES,
  Number(process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_CONFIRM_CYCLES || 2)
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_PNL_PCT || -0.18
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_MAX_MFE_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_MAX_MFE_PCT || 0.03)
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_NEAR_TP_PCT = Math.max(
  BINANCE_POSITION_HOLD_DETERIORATION_NEAR_TP_PCT,
  Number(process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_NEAR_TP_PCT || 0.16)
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_EXTRA_GRACE_SECONDS = Math.max(
  30,
  Number(process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_EXTRA_GRACE_SECONDS || 90)
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_RECOVERY_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_RECOVERY_PCT || 0.06)
);
const BINANCE_POSITION_HC_HOLD_DETERIORATION_SEVERE_FLOOR_PCT = Number(
  process.env.BINANCE_POSITION_HC_HOLD_DETERIORATION_SEVERE_FLOOR_PCT || -0.28
);
const BINANCE_POSITION_LOSS_PROTECTION_ENABLED =
  String(process.env.BINANCE_POSITION_LOSS_PROTECTION_ENABLED || 'true').toLowerCase() !== 'false';
const BINANCE_POSITION_LOSS_PROTECTION_MIN_SECONDS = Math.max(
  90,
  Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_MIN_SECONDS || 120)
);
const BINANCE_POSITION_LOSS_PROTECTION_CONFIRM_CYCLES = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_CONFIRM_CYCLES || 2)
);
const BINANCE_POSITION_LOSS_PROTECTION_NEGATIVE_PNL_PCT = Number(
  process.env.BINANCE_POSITION_LOSS_PROTECTION_NEGATIVE_PNL_PCT || -0.18
);
const BINANCE_POSITION_LOSS_PROTECTION_SEVERE_PNL_PCT = Number(
  process.env.BINANCE_POSITION_LOSS_PROTECTION_SEVERE_PNL_PCT || -0.55
);
const BINANCE_POSITION_LOSS_PROTECTION_DECAY_SCORE = Math.min(
  1,
  Math.max(0.4, Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_DECAY_SCORE || 0.78))
);
const BINANCE_POSITION_LOSS_PROTECTION_NEGATIVE_SIGNALS = Math.max(
  2,
  Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_NEGATIVE_SIGNALS || 3)
);
const BINANCE_POSITION_LOSS_PROTECTION_PULLBACK_PCT = Math.max(
  0.05,
  Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_PULLBACK_PCT || 0.12)
);
const BINANCE_POSITION_LOSS_PROTECTION_STALL_MS = Math.max(
  20000,
  Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_STALL_MS || 90000)
);
const BINANCE_POSITION_LOSS_PROTECTION_NEAR_MAX_HOLD_RATIO = Math.min(
  0.95,
  Math.max(0.55, Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_NEAR_MAX_HOLD_RATIO || 0.75))
);
const BINANCE_POSITION_LOSS_PROTECTION_PRE_MAX_HOLD_PNL_PCT = Number(
  process.env.BINANCE_POSITION_LOSS_PROTECTION_PRE_MAX_HOLD_PNL_PCT || -0.14
);
const BINANCE_POSITION_LOSS_PROTECTION_MAX_SEEN_CAP_PCT = Math.max(
  resolveTradeCostConfig().minimum_gross_profit_pct,
  Number(process.env.BINANCE_POSITION_LOSS_PROTECTION_MAX_SEEN_CAP_PCT || 0.08)
);
const BINANCE_POSITION_HC_LOSS_PROTECTION_NEGATIVE_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HC_LOSS_PROTECTION_NEGATIVE_PNL_PCT || -0.22
);
const BINANCE_POSITION_HC_LOSS_PROTECTION_SEVERE_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HC_LOSS_PROTECTION_SEVERE_PNL_PCT || -0.65
);
const BINANCE_POSITION_HC_LOSS_PROTECTION_CONFIRM_CYCLES = Math.max(
  BINANCE_POSITION_LOSS_PROTECTION_CONFIRM_CYCLES,
  Number(process.env.BINANCE_POSITION_HC_LOSS_PROTECTION_CONFIRM_CYCLES || 2)
);
const BINANCE_POSITION_HC_LOSS_PROTECTION_PRE_MAX_HOLD_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HC_LOSS_PROTECTION_PRE_MAX_HOLD_PNL_PCT || -0.18
);
const BINANCE_POSITION_HC_LOSS_PROTECTION_MAX_SEEN_CAP_PCT = Math.max(
  resolveTradeCostConfig().minimum_gross_profit_pct,
  Number(process.env.BINANCE_POSITION_HC_LOSS_PROTECTION_MAX_SEEN_CAP_PCT || 0.1)
);
const BINANCE_POSITION_EARLY_LOSS_WINDOW_SECONDS = Math.max(
  45,
  Number(process.env.BINANCE_POSITION_EARLY_LOSS_WINDOW_SECONDS || 150)
);
const BINANCE_POSITION_EARLY_LOSS_NEGATIVE_PNL_PCT = Number(
  process.env.BINANCE_POSITION_EARLY_LOSS_NEGATIVE_PNL_PCT || -0.18
);
const BINANCE_POSITION_HC_EARLY_LOSS_NEGATIVE_PNL_PCT = Number(
  process.env.BINANCE_POSITION_HC_EARLY_LOSS_NEGATIVE_PNL_PCT || -0.22
);
const BINANCE_POSITION_EARLY_LOSS_NEGATIVE_VELOCITY_BPS_PER_SEC = Number(
  process.env.BINANCE_POSITION_EARLY_LOSS_NEGATIVE_VELOCITY_BPS_PER_SEC || -0.6
);
const BINANCE_POSITION_EARLY_LOSS_NO_NEW_EXTREME_MS = Math.max(
  15000,
  Number(process.env.BINANCE_POSITION_EARLY_LOSS_NO_NEW_EXTREME_MS || 45000)
);
const BINANCE_POSITION_EARLY_LOSS_CONFIRM_CYCLES = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_EARLY_LOSS_CONFIRM_CYCLES || 2)
);
const BINANCE_POSITION_REVERSAL_PROTECTION_MIN_MFE_PCT = Math.max(
  resolveTradeCostConfig().minimum_gross_profit_pct,
  Number(process.env.BINANCE_POSITION_REVERSAL_PROTECTION_MIN_MFE_PCT || 0.12)
);
const BINANCE_POSITION_REVERSAL_PROTECTION_RETRACE_RATIO = Math.min(
  0.9,
  Math.max(0.35, Number(process.env.BINANCE_POSITION_REVERSAL_PROTECTION_RETRACE_RATIO || 0.5))
);
const BINANCE_POSITION_REVERSAL_PROTECTION_CONFIRM_CYCLES = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_REVERSAL_PROTECTION_CONFIRM_CYCLES || 1)
);
const BINANCE_POSITION_PROFIT_REVERSAL_RATIO = Math.min(
  0.9,
  Math.max(0.35, Number(process.env.BINANCE_POSITION_PROFIT_REVERSAL_RATIO || 0.55))
);
const BINANCE_POSITION_PROFIT_REVERSAL_MIN_MFE_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_PROFIT_REVERSAL_MIN_MFE_PCT || 0.08)
);
const BINANCE_POSITION_PROFIT_REVERSAL_RETRACE_RATIO = Math.min(
  0.95,
  Math.max(0.2, Number(process.env.BINANCE_POSITION_PROFIT_REVERSAL_RETRACE_RATIO || 0.65))
);
const BINANCE_POSITION_PROFIT_REVERSAL_FLOOR_PCT = Number(
  process.env.BINANCE_POSITION_PROFIT_REVERSAL_FLOOR_PCT || resolveTradeCostConfig().minimum_gross_profit_pct
);
const BINANCE_POSITION_MAX_HOLD_RECOVERY_MIN_MFE_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_RECOVERY_MIN_MFE_PCT || 0.05)
);
const BINANCE_POSITION_MAX_HOLD_RECOVERY_NEGATIVE_FLOOR_PCT = Number(
  process.env.BINANCE_POSITION_MAX_HOLD_RECOVERY_NEGATIVE_FLOOR_PCT || -0.03
);
const BINANCE_POSITION_MAX_HOLD_RECOVERY_NEAR_TP_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_RECOVERY_NEAR_TP_PCT || 0.12)
);
const BINANCE_POSITION_MAX_HOLD_RECOVERY_MAX_RETRACE_RATIO = Math.min(
  0.95,
  Math.max(0.35, Number(process.env.BINANCE_POSITION_MAX_HOLD_RECOVERY_MAX_RETRACE_RATIO || 0.85))
);
const BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_MIN_MFE_PCT = Math.max(
  0.02,
  Number(process.env.BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_MIN_MFE_PCT || 0.03)
);
const BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_NEGATIVE_FLOOR_PCT = Number(
  process.env.BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_NEGATIVE_FLOOR_PCT || -0.06
);
const BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_NEAR_TP_PCT = Math.max(
  BINANCE_POSITION_MAX_HOLD_RECOVERY_NEAR_TP_PCT,
  Number(process.env.BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_NEAR_TP_PCT || 0.18)
);
const BINANCE_POSITION_HC_MAX_HOLD_PARTIAL_FLOOR_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_POSITION_HC_MAX_HOLD_PARTIAL_FLOOR_PCT || 0.02)
);
const BINANCE_POSITION_HC_MAX_HOLD_PARTIAL_MFE_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_HC_MAX_HOLD_PARTIAL_MFE_PCT || 0.08)
);
const BINANCE_POSITION_HC_MAX_HOLD_SOFT_RECOVERY_NEGATIVE_FLOOR_PCT = Number(
  process.env.BINANCE_POSITION_HC_MAX_HOLD_SOFT_RECOVERY_NEGATIVE_FLOOR_PCT || -0.12
);
const BINANCE_POSITION_HC_MAX_HOLD_SOFT_RECOVERY_DISTANCE_TO_STOP_PCT = Math.max(
  0.03,
  Number(process.env.BINANCE_POSITION_HC_MAX_HOLD_SOFT_RECOVERY_DISTANCE_TO_STOP_PCT || 0.18)
);
const BINANCE_EVENT_MAX_LOSS_CAP_PCT = Number(
  process.env.BINANCE_EVENT_MAX_LOSS_CAP_PCT || -0.45
);
const BINANCE_EVENT_MAX_LOSS_CAP_NO_SL_PCT = Number(
  process.env.BINANCE_EVENT_MAX_LOSS_CAP_NO_SL_PCT || -0.32
);
const BINANCE_EVENT_MAX_LOSS_CAP_MIN_SECONDS = Math.max(
  45,
  Number(process.env.BINANCE_EVENT_MAX_LOSS_CAP_MIN_SECONDS || 75)
);
const BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO = Math.min(
  0.95,
  Math.max(0.5, Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO || 0.8))
);
const BINANCE_EVENT_PRE_MAX_HOLD_NEGATIVE_PNL_PCT = Number(
  process.env.BINANCE_EVENT_PRE_MAX_HOLD_NEGATIVE_PNL_PCT || -0.03
);
const BINANCE_EVENT_PRE_MAX_HOLD_MAX_MFE_PCT = Math.max(
  0.01,
  Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_MAX_MFE_PCT || 0.03)
);
const BINANCE_EVENT_PRE_MAX_HOLD_DISTANCE_TO_TP_PCT = Math.max(
  0.2,
  Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_DISTANCE_TO_TP_PCT || 0.8)
);

function resolveSourceProfile(position) {
  return String(position?.source_profile || position?.source || 'event_emitted').toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function logSymbolFlow({ symbol = null, source = null, stage = null, predictionId = null } = {}) {
  console.info('[SYMBOL_FLOW]', {
    symbol: symbol || null,
    source: source || null,
    stage: stage || null,
    prediction_id: predictionId || null
  });
}

function logSymbolError(context = {}) {
  console.error('[SYMBOL_ERROR]', context);
}

function resolveManagedPositionSymbol(position = {}) {
  return normalizeToBinance(
    position?.symbol ||
      position?.intent?.symbol ||
      position?.signal_symbol ||
      position?.simbolo ||
      position?.simbolo_normalizado
  );
}

function pnlPctFor(side, entry, mark) {
  if (!entry || !mark) return 0;
  if (side === 'BUY') return ((mark - entry) / entry) * 100;
  if (side === 'SELL') return ((entry - mark) / entry) * 100;
  return 0;
}

function getOpenMinutes(openedAt) {
  const openedMs = new Date(openedAt || 0).getTime();
  if (!Number.isFinite(openedMs) || openedMs <= 0) return 0;
  return (Date.now() - openedMs) / 60000;
}

function getOpenSeconds(openedAt) {
  const openedMs = new Date(openedAt || 0).getTime();
  if (!Number.isFinite(openedMs) || openedMs <= 0) return 0;
  return Math.max(0, (Date.now() - openedMs) / 1000);
}

function resolveExchangeOutcome(pnlPct) {
  const pnl = Number(pnlPct || 0);
  if (!Number.isFinite(pnl)) return 'UNKNOWN';
  if (pnl > 0) return 'WIN';
  if (pnl < 0) return 'LOSS';
  return 'BREAKEVEN';
}

function resolvePositionMaxHoldSeconds(position) {
  const positionSpecific = Number(position?.position_max_hold_seconds || 0);
  if (Number.isFinite(positionSpecific) && positionSpecific > 0) {
    return positionSpecific;
  }

  const expectedMax = Number(position?.expected_duration_max_seconds || 0);
  if (Number.isFinite(expectedMax) && expectedMax > 0) {
    return Math.max(expectedMax, 60);
  }

  const adaptive = Number(position?.adaptive_horizon_seconds || 0);
  if (Number.isFinite(adaptive) && adaptive > 0) {
    return adaptive;
  }

  return BINANCE_POSITION_MAX_HOLD_MINUTES * 60;
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildAdaptiveShadowKey(decision = {}) {
  return [
    String(decision.exit_reason || 'hold'),
    Number(decision.exit_priority || 0),
    Number(toNumber(decision.shadow_exit_pnl_pct, 0).toFixed(4)),
    Number(toNumber(decision.shadow_exit_price, 0).toFixed(6))
  ].join('|');
}

function buildAdaptiveShadowSummary(position, decision, actualDecision, lifecycle, closed = false) {
  const previous = position?.adaptive_exit_shadow || {};
  const shouldExit = Boolean(decision?.should_exit);
  const decisionKey = buildAdaptiveShadowKey(decision);
  const currentReason = actualDecision?.reason || 'hold';
  const currentWouldClose = Boolean(actualDecision?.close);
  const decisionAtIso = nowIso();
  const conflict =
    shouldExit &&
    (currentReason !== decision?.exit_reason || !currentWouldClose);
  const lifecyclePhase = decision?.lifecycle_phase || lifecycle?.lifecycle_phase || lifecycle?.impulse_state || null;
  const lifecycleLegacyState = lifecycle?.impulse_state_legacy || null;
  const evaluatedReasons = Array.isArray(decision?.evaluated_reasons) ? decision.evaluated_reasons : [];
  const discardedReasons = Array.isArray(decision?.discarded_reasons) ? decision.discarded_reasons : [];
  const decisionFlow = decision?.decision_flow || null;

  return {
    mode: decision?.scope?.mode || previous.mode || 'off',
    enabled: Boolean(decision?.scope?.enabled),
    should_exit: shouldExit,
    exit_reason: decision?.exit_reason || 'hold',
    exit_priority: Number(decision?.exit_priority || 0),
    exit_confidence: Number(decision?.exit_confidence || 0),
    shadow_exit_price: toNumber(decision?.shadow_exit_price),
    shadow_exit_pnl_pct: toNumber(decision?.shadow_exit_pnl_pct),
    latest_decision_at: decisionAtIso,
    latest_decision_key: decisionKey,
    latest_competing_current_reason: currentReason,
    latest_competing_current_close: currentWouldClose,
    decision_count: Number(previous.decision_count || 0) + (shouldExit ? 1 : 0),
    conflicts_count: Number(previous.conflicts_count || 0) + (conflict ? 1 : 0),
    first_shadow_exit_at:
      previous.first_shadow_exit_at || (shouldExit ? decisionAtIso : null),
    first_shadow_exit_reason:
      previous.first_shadow_exit_reason || (shouldExit ? decision?.exit_reason || null : null),
    first_shadow_exit_pnl_pct:
      previous.first_shadow_exit_pnl_pct != null
        ? previous.first_shadow_exit_pnl_pct
        : (shouldExit ? toNumber(decision?.shadow_exit_pnl_pct) : null),
    first_shadow_exit_price:
      previous.first_shadow_exit_price != null
        ? previous.first_shadow_exit_price
        : (shouldExit ? toNumber(decision?.shadow_exit_price) : null),
    first_shadow_exit_priority:
      previous.first_shadow_exit_priority != null
        ? previous.first_shadow_exit_priority
        : (shouldExit ? Number(decision?.exit_priority || 0) : null),
    first_shadow_exit_decision_flow:
      previous.first_shadow_exit_decision_flow || (shouldExit ? decisionFlow : null),
    first_shadow_exit_lifecycle_phase:
      previous.first_shadow_exit_lifecycle_phase || (shouldExit ? lifecyclePhase : null),
    first_shadow_exit_lifecycle_legacy_state:
      previous.first_shadow_exit_lifecycle_legacy_state || (shouldExit ? lifecycleLegacyState : null),
    shadow_observe_only: decision?.scope?.mode !== 'enforce',
    impulse_state_at_decision: lifecyclePhase,
    impulse_state_reason_at_decision: lifecycle?.impulse_state_reason || null,
    impulse_state_legacy_at_decision: lifecycleLegacyState,
    lifecycle_phase_at_decision: lifecyclePhase,
    confirmation_window: decision?.confirmation_window || previous.confirmation_window || null,
    evaluated_reasons: evaluatedReasons,
    discarded_reasons: discardedReasons,
    decision_flow: decisionFlow,
    closed: Boolean(closed)
  };
}

function logAdaptiveExitEvents(position, lifecycle, shadowDecision) {
  const events = Array.isArray(shadowDecision?.log_events) ? shadowDecision.log_events : [];
  for (const event of events) {
    const tag = String(event?.tag || '').trim();
    if (!tag) continue;
    console.info(`[${tag}]`, {
      symbol: position?.symbol || 'UNKNOWN',
      source_profile: resolveSourceProfile(position),
      lifecycle_state: shadowDecision?.lifecycle_phase || lifecycle?.lifecycle_phase || lifecycle?.impulse_state || null,
      lifecycle_reason: shadowDecision?.lifecycle_state_reason || lifecycle?.impulse_state_reason || null,
      ...(event?.payload || {})
    });
  }
}

function buildAdaptiveExitComparison(position, shadowSummary, realClose) {
  const shadowAvailable = Boolean(shadowSummary?.first_shadow_exit_at);
  const shadowPnl = toNumber(shadowSummary?.first_shadow_exit_pnl_pct);
  const realPnl = toNumber(realClose?.real_close_pnl_pct);
  const shadowNetPnl = shadowAvailable && shadowPnl != null ? estimateNetPnlPct(shadowPnl) : null;
  const realNetPnl =
    realClose?.real_close_net_pnl_pct != null
      ? toNumber(realClose.real_close_net_pnl_pct)
      : (realPnl != null ? estimateNetPnlPct(realPnl) : null);
  const delta = shadowAvailable && shadowPnl != null && realPnl != null
    ? shadowPnl - realPnl
    : null;
  const netDelta = shadowAvailable && shadowNetPnl != null && realNetPnl != null
    ? shadowNetPnl - realNetPnl
    : null;
  const shadowExitAt = shadowSummary?.first_shadow_exit_at ? new Date(shadowSummary.first_shadow_exit_at) : null;
  const realClosedAt = realClose?.real_close_at ? new Date(realClose.real_close_at) : null;
  const timeDeltaMs =
    shadowExitAt && realClosedAt && Number.isFinite(shadowExitAt.getTime()) && Number.isFinite(realClosedAt.getTime())
      ? realClosedAt.getTime() - shadowExitAt.getTime()
      : null;

  return {
    shadow_available: shadowAvailable,
    shadow_exit_at: shadowSummary?.first_shadow_exit_at || null,
    shadow_exit_reason: shadowSummary?.first_shadow_exit_reason || null,
    shadow_exit_priority: toNumber(shadowSummary?.first_shadow_exit_priority),
    shadow_exit_price: toNumber(shadowSummary?.first_shadow_exit_price),
    shadow_exit_pnl_pct: shadowPnl,
    shadow_decision_flow: shadowSummary?.first_shadow_exit_decision_flow || shadowSummary?.decision_flow || null,
    shadow_lifecycle_phase: shadowSummary?.first_shadow_exit_lifecycle_phase || shadowSummary?.lifecycle_phase_at_decision || null,
    shadow_lifecycle_legacy_state:
      shadowSummary?.first_shadow_exit_lifecycle_legacy_state || shadowSummary?.impulse_state_legacy_at_decision || null,
    real_close_at: realClose?.real_close_at || null,
    real_close_reason: realClose?.real_close_reason || null,
    real_close_price: toNumber(realClose?.real_close_price),
    real_close_pnl_pct: realPnl,
    shadow_exit_net_pnl_pct: shadowNetPnl,
    real_close_net_pnl_pct: realNetPnl,
    pnl_delta_pct: delta != null ? Number(delta.toFixed(4)) : null,
    net_pnl_delta_pct: netDelta != null ? Number(netDelta.toFixed(4)) : null,
    time_delta_ms: timeDeltaMs,
    improved: delta != null ? delta > 0.0001 : false,
    worsened: delta != null ? delta < -0.0001 : false,
    no_difference: delta != null ? Math.abs(delta) <= 0.0001 : false
  };
}

async function logAdaptiveShadowDecision(db, docRef, position, lifecycle, shadowDecision, actualDecision) {
  if (!shadowDecision?.should_exit) return;
  const previous = position?.adaptive_exit_shadow || {};
  const nextKey = buildAdaptiveShadowKey(shadowDecision);
  if (previous.latest_decision_key === nextKey) return;

  await db.collection('adaptive_exit_shadow_decisions').add({
    position_id: docRef.id,
    prediction_id: position?.prediction_id || null,
    symbol: position?.symbol || 'UNKNOWN',
    source_profile: resolveSourceProfile(position),
    impulse_state: lifecycle?.impulse_state || null,
    lifecycle_phase: shadowDecision?.lifecycle_phase || lifecycle?.lifecycle_phase || lifecycle?.impulse_state || null,
    impulse_state_reason: lifecycle?.impulse_state_reason || null,
    impulse_state_legacy: lifecycle?.impulse_state_legacy || null,
    evaluated_reasons: Array.isArray(shadowDecision?.evaluated_reasons) ? shadowDecision.evaluated_reasons : [],
    discarded_reasons: Array.isArray(shadowDecision?.discarded_reasons) ? shadowDecision.discarded_reasons : [],
    decision_flow: shadowDecision?.decision_flow || null,
    priority_selected: Number(shadowDecision?.exit_priority || 0),
    shadow_decision: shadowDecision,
    current_decision: {
      close: Boolean(actualDecision?.close),
      reason: actualDecision?.reason || 'hold',
      pnl_pct: toNumber(actualDecision?.pnl_pct)
    },
    created_at: FieldValue.serverTimestamp(),
    created_at_iso: nowIso()
  });
}

function resolveMaxSeenPct(position, pnlPct = null) {
  const stored = Number(position?.profit_capture_max_seen_pct ?? position?.max_seen_pnl_pct ?? 0);
  const current = Number(pnlPct ?? 0);
  if (!Number.isFinite(stored) && !Number.isFinite(current)) return 0;
  return Math.max(Number.isFinite(stored) ? stored : 0, Number.isFinite(current) ? current : 0);
}

function resolveMinSeenPct(position, pnlPct = null) {
  const stored = Number(position?.min_seen_pct ?? 0);
  const current = Number(pnlPct ?? 0);
  if (!Number.isFinite(stored) && !Number.isFinite(current)) return 0;
  if (!Number.isFinite(stored)) return current;
  if (!Number.isFinite(current)) return stored;
  return Math.min(stored, current);
}

function resolveStaleConfig(sourceProfile) {
  const isHighConviction = sourceProfile === 'high_conviction';
  return {
    negativeConfirmPct: isHighConviction
      ? Math.max(0.03, BINANCE_POSITION_NEGATIVE_CONFIRM_PCT * 0.5)
      : BINANCE_POSITION_NEGATIVE_CONFIRM_PCT,
    microDrawdownTolerancePct: isHighConviction
      ? Math.max(0.01, BINANCE_POSITION_MICRO_DRAWDOWN_TOLERANCE_PCT * 0.8)
      : BINANCE_POSITION_MICRO_DRAWDOWN_TOLERANCE_PCT
  };
}

function resolveHoldDeteriorationConfig(sourceProfile) {
  const isHighConviction = sourceProfile === 'high_conviction';
  return {
    windowRatio: isHighConviction
      ? BINANCE_POSITION_HC_HOLD_DETERIORATION_RATIO
      : BINANCE_POSITION_HOLD_DETERIORATION_RATIO,
    confirmCycles: isHighConviction
      ? BINANCE_POSITION_HC_HOLD_DETERIORATION_CONFIRM_CYCLES
      : BINANCE_POSITION_HOLD_DETERIORATION_CONFIRM_CYCLES,
    pnlPct: isHighConviction
      ? BINANCE_POSITION_HC_HOLD_DETERIORATION_PNL_PCT
      : BINANCE_POSITION_HOLD_DETERIORATION_PNL_PCT,
    maxMfePct: isHighConviction
      ? BINANCE_POSITION_HC_HOLD_DETERIORATION_MAX_MFE_PCT
      : BINANCE_POSITION_HOLD_DETERIORATION_MAX_MFE_PCT,
    nearTpPct: isHighConviction
      ? BINANCE_POSITION_HC_HOLD_DETERIORATION_NEAR_TP_PCT
      : BINANCE_POSITION_HOLD_DETERIORATION_NEAR_TP_PCT
  };
}

function resolveMaxHoldPartialThresholds(sourceProfile) {
  if (sourceProfile === 'high_conviction') {
    return {
      pnlFloorPct: Math.min(
        BINANCE_POSITION_MAX_HOLD_POSITIVE_FLOOR_PCT,
        BINANCE_POSITION_HC_MAX_HOLD_PARTIAL_FLOOR_PCT
      ),
      mfeFloorPct: Math.min(
        BINANCE_POSITION_MAX_HOLD_MOMENTUM_PCT,
        BINANCE_POSITION_HC_MAX_HOLD_PARTIAL_MFE_PCT
      )
    };
  }

  return {
    pnlFloorPct: BINANCE_POSITION_MAX_HOLD_POSITIVE_FLOOR_PCT,
    mfeFloorPct: BINANCE_POSITION_MAX_HOLD_MOMENTUM_PCT
  };
}

function maybeCapEventLoss(position, pnlPct, openedSeconds, positionMaxHoldSeconds, openedMinutes) {
  const sourceProfile = resolveSourceProfile(position);
  if (sourceProfile !== 'event_emitted') return null;
  if (!Number.isFinite(pnlPct) || openedSeconds < BINANCE_EVENT_MAX_LOSS_CAP_MIN_SECONDS) return null;

  const hasExchangeStop = Boolean(position?.sl_order_id);
  const lossCapPct = hasExchangeStop
    ? BINANCE_EVENT_MAX_LOSS_CAP_PCT
    : Math.max(BINANCE_EVENT_MAX_LOSS_CAP_NO_SL_PCT, BINANCE_EVENT_MAX_LOSS_CAP_PCT);

  if (pnlPct > lossCapPct) return null;

  return {
    close: true,
    reason: 'event_loss_cap_exit',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    loss_cap_pct: lossCapPct,
    sl_order_present: hasExchangeStop
  };
}

function maybeExitWeakEventBeforeMaxHold(position, pnlPct, openedSeconds, positionMaxHoldSeconds, maxSeenPct, openedMinutes, entryPrice, markPrice) {
  const sourceProfile = resolveSourceProfile(position);
  if (sourceProfile !== 'event_emitted') return null;

  const timeoutSeconds = Math.max(
    60,
    Math.round(positionMaxHoldSeconds * BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO)
  );
  if (openedSeconds < timeoutSeconds) return null;

  const distanceToTpPct = resolveDistanceToTpPct(position, entryPrice, markPrice);
  const weakProgress =
    maxSeenPct <= BINANCE_EVENT_PRE_MAX_HOLD_MAX_MFE_PCT &&
    pnlPct <= BINANCE_EVENT_PRE_MAX_HOLD_NEGATIVE_PNL_PCT;
  const farFromTarget =
    !Number.isFinite(distanceToTpPct) || distanceToTpPct >= BINANCE_EVENT_PRE_MAX_HOLD_DISTANCE_TO_TP_PCT;

  if (!weakProgress || !farFromTarget) return null;

  return {
    close: true,
    reason: 'event_timeout_exit',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
    max_seen_pct: maxSeenPct
  };
}

function resolveDistanceToTpPct(position, entryPrice, markPrice) {
  const tp = Number(position?.take_profit || 0);
  if (!Number.isFinite(tp) || tp <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
    return null;
  }
  const side = String(position?.side || '').toUpperCase();
  if (side === 'BUY') {
    return Math.max(0, ((tp - markPrice) / entryPrice) * 100);
  }
  if (side === 'SELL') {
    return Math.max(0, ((markPrice - tp) / entryPrice) * 100);
  }
  return null;
}

function resolveDistanceToStopPct(position, entryPrice, markPrice) {
  const stopLoss = Number(position?.stop_loss || 0);
  if (
    !Number.isFinite(stopLoss) ||
    stopLoss <= 0 ||
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0
  ) {
    return null;
  }
  const side = String(position?.side || '').toUpperCase();
  if (side === 'BUY') {
    return ((markPrice - stopLoss) / entryPrice) * 100;
  }
  if (side === 'SELL') {
    return ((stopLoss - markPrice) / entryPrice) * 100;
  }
  return null;
}

function buildEventStaleEvaluation({
  position,
  entryPrice,
  markPrice,
  pnlPct,
  openedSeconds,
  staleExitThresholdSeconds,
  maxSeenPct,
  minSeenPct,
  staleWarningCount
}) {
  const timeInTradeMs = Math.max(0, Math.round(openedSeconds * 1000));
  const distanceToTpPct = resolveDistanceToTpPct(position, entryPrice, markPrice);
  const volatilityRangePct = Math.abs(maxSeenPct - minSeenPct);
  const retracePct = Math.max(0, maxSeenPct - pnlPct);
  const retraceRatio = maxSeenPct > 0 ? retracePct / Math.max(maxSeenPct, 0.0001) : 1;
  const graceApplied = timeInTradeMs < ((Math.max(0, staleExitThresholdSeconds) * 1000) + BINANCE_EVENT_STALE_GRACE_MS);
  const nearTp = Number.isFinite(distanceToTpPct) && distanceToTpPct <= BINANCE_EVENT_STALE_NEAR_TP_PCT;
  const lightPositiveMomentum =
    maxSeenPct >= BINANCE_EVENT_STALE_MOMENTUM_MIN_PCT ||
    (pnlPct > -BINANCE_POSITION_MICRO_DRAWDOWN_TOLERANCE_PCT && retraceRatio < 0.8);
  const sufficientVolatility = volatilityRangePct >= BINANCE_EVENT_STALE_VOLATILITY_MIN_PCT;
  const momentumScore = Number(
    Math.max(
      0,
      Math.min(
        1,
        (nearTp ? 0.4 : 0) +
          (lightPositiveMomentum ? 0.35 : 0) +
          (sufficientVolatility ? 0.25 : 0)
      )
    ).toFixed(4)
  );

  let finalDecision = 'close';
  if (graceApplied) finalDecision = 'continue_monitoring';
  else if (nearTp || lightPositiveMomentum || sufficientVolatility) finalDecision = 'extend_monitoring';

  return {
    grace_applied: graceApplied,
    time_in_trade_ms: timeInTradeMs,
    distance_to_tp: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
    momentum_score: momentumScore,
    volatility_range_pct: Number(volatilityRangePct.toFixed(4)),
    stale_warning_count: staleWarningCount + 1,
    final_decision: finalDecision
  };
}

function maybeExtendHoldWithMomentum(position, pnlPct, positionMaxHoldSeconds, maxSeenPct) {
  const sourceProfile = resolveSourceProfile(position);
  const extensionCount = Number(position?.hold_extension_count || 0);
  if (extensionCount >= BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_COUNT) return null;

  const retracePct = Math.max(0, maxSeenPct - pnlPct);
  const maxAllowedRetrace = Math.max(0.03, maxSeenPct * BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_RETRACE_RATIO);

  if (
    !Number.isFinite(pnlPct) ||
    pnlPct < BINANCE_POSITION_MAX_HOLD_EXTENSION_NEGATIVE_FLOOR_PCT ||
    maxSeenPct < Math.max(BINANCE_POSITION_MAX_HOLD_EXTENSION_MIN_MFE_PCT, BINANCE_POSITION_MAX_HOLD_POSITIVE_FLOOR_PCT) ||
    retracePct > maxAllowedRetrace
  ) {
    return null;
  }

  const adaptiveHorizon = Number(position?.adaptive_horizon_seconds || 0);
  const extensionRatio =
    sourceProfile === 'high_conviction'
      ? BINANCE_POSITION_HC_MAX_HOLD_EXTENSION_RATIO
      : Math.max(1.1, BINANCE_POSITION_HC_MAX_HOLD_EXTENSION_RATIO - 0.15);
  const extendedBase = Math.round(positionMaxHoldSeconds * extensionRatio);
  const extendedMax = adaptiveHorizon > 0
    ? Math.max(extendedBase, Math.round(adaptiveHorizon * 0.75))
    : extendedBase;

  if (extendedMax <= positionMaxHoldSeconds) return null;

  return {
    extended_hold_seconds: extendedMax,
    extension_count: extensionCount + 1
  };
}

function maybeExtendHoldForRecovery(position, pnlPct, positionMaxHoldSeconds, maxSeenPct, entryPrice, markPrice) {
  const sourceProfile = resolveSourceProfile(position);
  const extensionCount = Number(position?.hold_extension_count || 0);
  if (extensionCount >= BINANCE_POSITION_MAX_HOLD_EXTENSION_MAX_COUNT) return null;

  const isHighConviction = sourceProfile === 'high_conviction';
  const minMfePct = isHighConviction
    ? BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_MIN_MFE_PCT
    : BINANCE_POSITION_MAX_HOLD_RECOVERY_MIN_MFE_PCT;
  const negativeFloorPct = isHighConviction
    ? BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_NEGATIVE_FLOOR_PCT
    : BINANCE_POSITION_MAX_HOLD_RECOVERY_NEGATIVE_FLOOR_PCT;
  const nearTpPct = isHighConviction
    ? BINANCE_POSITION_HC_MAX_HOLD_RECOVERY_NEAR_TP_PCT
    : BINANCE_POSITION_MAX_HOLD_RECOVERY_NEAR_TP_PCT;
  const distanceToTpPct = resolveDistanceToTpPct(position, entryPrice, markPrice);
  const distanceToStopPct = resolveDistanceToStopPct(position, entryPrice, markPrice);
  const retracePct = Math.max(0, maxSeenPct - pnlPct);
  const retraceRatio = maxSeenPct > 0 ? retracePct / Math.max(maxSeenPct, 0.0001) : 1;
  const nearTp = Number.isFinite(distanceToTpPct) && distanceToTpPct <= nearTpPct;
  const positiveRecovery = pnlPct >= 0;
  const mildDrawdown = pnlPct >= negativeFloorPct;
  const hasRecoveryPotential =
    maxSeenPct >= minMfePct &&
    mildDrawdown &&
    (nearTp || positiveRecovery || retraceRatio <= BINANCE_POSITION_MAX_HOLD_RECOVERY_MAX_RETRACE_RATIO);
  const hasSoftRecoveryPotential =
    isHighConviction &&
    maxSeenPct < minMfePct &&
    pnlPct >= BINANCE_POSITION_HC_MAX_HOLD_SOFT_RECOVERY_NEGATIVE_FLOOR_PCT &&
    Number.isFinite(distanceToStopPct) &&
    distanceToStopPct >= BINANCE_POSITION_HC_MAX_HOLD_SOFT_RECOVERY_DISTANCE_TO_STOP_PCT;

  if (!hasRecoveryPotential && !hasSoftRecoveryPotential) return null;

  const adaptiveHorizon = Number(position?.adaptive_horizon_seconds || 0);
  const extensionRatio = isHighConviction
    ? Math.max(BINANCE_POSITION_HC_MAX_HOLD_EXTENSION_RATIO, 1.45)
    : Math.max(1.15, BINANCE_POSITION_HC_MAX_HOLD_EXTENSION_RATIO - 0.1);
  const extendedBase = Math.round(positionMaxHoldSeconds * extensionRatio);
  const extendedMax = adaptiveHorizon > 0
    ? Math.max(extendedBase, Math.round(adaptiveHorizon * (isHighConviction ? 0.9 : 0.75)))
    : extendedBase;

  if (extendedMax <= positionMaxHoldSeconds) return null;

  return {
    extended_hold_seconds: extendedMax,
    extension_count: extensionCount + 1,
    distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
    distance_to_stop_pct: Number.isFinite(distanceToStopPct) ? Number(distanceToStopPct.toFixed(4)) : null,
    retrace_ratio: Number(retraceRatio.toFixed(4)),
    soft_recovery_extension: hasSoftRecoveryPotential && !hasRecoveryPotential
  };
}

function evaluateProfitCaptureGate(pnlPct, maxSeenPct, floorCandidatePct) {
  const tradeCost = resolveTradeCostConfig();
  const activationThresholdPct = Math.max(
    BINANCE_POSITION_PROFIT_CAPTURE_MIN_ACTIVATION_PCT,
    BINANCE_POSITION_PROFIT_LOCK_MIN_MFE_PCT,
    tradeCost.minimum_gross_profit_pct
  );
  const effectiveFloorPct = Math.max(
    Number.isFinite(floorCandidatePct) ? floorCandidatePct : 0,
    BINANCE_POSITION_PROFIT_CAPTURE_NET_BUFFER_PCT,
    tradeCost.minimum_gross_profit_pct
  );
  const retracePct = Math.max(0, maxSeenPct - pnlPct);
  const retraceThresholdPct = Math.max(
    BINANCE_POSITION_PROFIT_CAPTURE_MIN_RETRACE_PCT,
    maxSeenPct * BINANCE_POSITION_PROFIT_CAPTURE_RETRACE_RATIO
  );

  return {
    activationThresholdPct,
    effectiveFloorPct,
    retracePct,
    retraceThresholdPct,
    estimatedRoundtripCostPct: tradeCost.cost_floor_pct,
    minimumNetProfitPct: tradeCost.minimum_net_profit_pct,
    minimumGrossProfitPct: tradeCost.minimum_gross_profit_pct,
    netBufferPct: Math.max(BINANCE_POSITION_PROFIT_CAPTURE_NET_BUFFER_PCT, tradeCost.minimum_gross_profit_pct),
    allow:
      Number.isFinite(pnlPct) &&
      Number.isFinite(maxSeenPct) &&
      maxSeenPct >= activationThresholdPct &&
      pnlPct >= Math.max(BINANCE_POSITION_PROFIT_CAPTURE_NET_BUFFER_PCT, tradeCost.minimum_gross_profit_pct) &&
      pnlPct <= effectiveFloorPct &&
      retracePct >= retraceThresholdPct
  };
}

function maybeProtectAccumulatedProfit(position, pnlPct, openedSeconds, positionMaxHoldSeconds, maxSeenPct, openedMinutes, sourceProfile) {
  if (!Number.isFinite(pnlPct) || !Number.isFinite(maxSeenPct)) return null;

  const activationSeconds = Math.max(
    BINANCE_POSITION_PROFIT_LOCK_MIN_SECONDS,
    Math.round(positionMaxHoldSeconds * 0.45)
  );
  if (openedSeconds < activationSeconds) return null;
  if (maxSeenPct < BINANCE_POSITION_PROFIT_LOCK_MIN_MFE_PCT) return null;

  const dynamicFloorPct = Math.max(
    BINANCE_POSITION_PROFIT_LOCK_MIN_FLOOR_PCT,
    maxSeenPct * BINANCE_POSITION_PROFIT_LOCK_RETRACE_RATIO
  );
  const profitCaptureGate = evaluateProfitCaptureGate(pnlPct, maxSeenPct, dynamicFloorPct);

  if (!profitCaptureGate.allow) return null;

  return {
    close: true,
    reason: 'profit_capture_enforced',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    profit_lock_floor_pct: profitCaptureGate.effectiveFloorPct,
    max_seen_pct: maxSeenPct,
    profit_capture_activation_pct: profitCaptureGate.activationThresholdPct,
    profit_capture_net_buffer_pct: profitCaptureGate.netBufferPct,
    estimated_roundtrip_cost_pct: profitCaptureGate.estimatedRoundtripCostPct,
    minimum_net_profit_pct: profitCaptureGate.minimumNetProfitPct,
    minimum_gross_profit_pct: profitCaptureGate.minimumGrossProfitPct,
    profit_capture_retrace_pct: profitCaptureGate.retracePct,
    profit_capture_retrace_threshold_pct: profitCaptureGate.retraceThresholdPct
  };
}

function maybePlanProgressiveCapture(position, pnlPct, openedSeconds, positionMaxHoldSeconds, maxSeenPct, partialExitCount, openedMinutes, sourceProfile) {
  const captureWindowSeconds = Math.max(
    60,
    Math.round(positionMaxHoldSeconds * BINANCE_POSITION_PRE_MAX_HOLD_CAPTURE_RATIO)
  );

  if (openedSeconds < captureWindowSeconds) return null;
  if (partialExitCount >= BINANCE_POSITION_PARTIAL_EXIT_MAX_COUNT) return null;
  if (!Number.isFinite(pnlPct) || pnlPct < BINANCE_POSITION_PRE_MAX_HOLD_MIN_PROFIT_PCT) return null;
  if (!Number.isFinite(maxSeenPct) || maxSeenPct < BINANCE_POSITION_PRE_MAX_HOLD_MIN_MFE_PCT) return null;

  return {
    close: false,
    partial_close: true,
    reason: 'pre_max_hold_partial_take_profit',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    partial_close_ratio: BINANCE_POSITION_PARTIAL_EXIT_RATIO,
    partial_exit_count: partialExitCount + 1
  };
}

function resolveLossProtectionConfig(sourceProfile = 'unknown') {
  const isHighConviction = sourceProfile === 'high_conviction';
  return {
    enabled: BINANCE_POSITION_LOSS_PROTECTION_ENABLED,
    minSeconds: BINANCE_POSITION_LOSS_PROTECTION_MIN_SECONDS,
    confirmCycles: isHighConviction
      ? BINANCE_POSITION_HC_LOSS_PROTECTION_CONFIRM_CYCLES
      : BINANCE_POSITION_LOSS_PROTECTION_CONFIRM_CYCLES,
    negativePnlPct: isHighConviction
      ? BINANCE_POSITION_HC_LOSS_PROTECTION_NEGATIVE_PNL_PCT
      : BINANCE_POSITION_LOSS_PROTECTION_NEGATIVE_PNL_PCT,
    severePnlPct: isHighConviction
      ? BINANCE_POSITION_HC_LOSS_PROTECTION_SEVERE_PNL_PCT
      : BINANCE_POSITION_LOSS_PROTECTION_SEVERE_PNL_PCT,
    decayScore: BINANCE_POSITION_LOSS_PROTECTION_DECAY_SCORE,
    negativeSignals: BINANCE_POSITION_LOSS_PROTECTION_NEGATIVE_SIGNALS,
    pullbackPct: BINANCE_POSITION_LOSS_PROTECTION_PULLBACK_PCT,
    stallMs: BINANCE_POSITION_LOSS_PROTECTION_STALL_MS,
    nearMaxHoldRatio: BINANCE_POSITION_LOSS_PROTECTION_NEAR_MAX_HOLD_RATIO,
    preMaxHoldPnlPct: isHighConviction
      ? BINANCE_POSITION_HC_LOSS_PROTECTION_PRE_MAX_HOLD_PNL_PCT
      : BINANCE_POSITION_LOSS_PROTECTION_PRE_MAX_HOLD_PNL_PCT,
    maxSeenCapPct: isHighConviction
      ? BINANCE_POSITION_HC_LOSS_PROTECTION_MAX_SEEN_CAP_PCT
      : BINANCE_POSITION_LOSS_PROTECTION_MAX_SEEN_CAP_PCT
  };
}

function resolveLifecycleNumber(lifecycle, position, field, fallback = 0) {
  const value = Number(lifecycle?.[field] ?? position?.impulse_lifecycle?.[field] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function resolveLifecycleString(lifecycle, position, field, fallback = '') {
  return String(lifecycle?.[field] ?? position?.impulse_lifecycle?.[field] ?? fallback).toLowerCase();
}

function resolveObservationMetric(lifecycle, position, field, fallback = 0) {
  const value = Number(
    lifecycle?.observation_snapshot?.[field] ??
      position?.impulse_lifecycle?.observation_snapshot?.[field] ??
      position?.last_microstructure_snapshot?.[field] ??
      fallback
  );
  return Number.isFinite(value) ? value : fallback;
}

function resolveLifecycleLatestExtremeAgeMs(lifecycle, position) {
  const raw =
    lifecycle?.latest_new_extreme_at ??
    position?.impulse_lifecycle?.latest_new_extreme_at ??
    null;
  if (!raw) return Number.POSITIVE_INFINITY;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - ms);
}

function logLossProtection(tag, payload = {}) {
  console.info(`[${tag}]`, payload);
}

function maybeProtectRealLoss(
  position,
  lifecycle,
  pnlPct,
  openedSeconds,
  positionMaxHoldSeconds,
  maxSeenPct,
  minSeenPct,
  openedMinutes,
  sourceProfile,
  mfeDrawdownPct
) {
  const config = resolveLossProtectionConfig(sourceProfile);
  if (!config.enabled) return null;

  const lifecyclePhase = resolveLifecycleString(lifecycle, position, 'lifecycle_phase');
  const impulseReason = resolveLifecycleString(lifecycle, position, 'impulse_state_reason');
  const negativeSignalCount = resolveLifecycleNumber(lifecycle, position, 'negative_signal_count', 0);
  const positiveSignalCount = resolveLifecycleNumber(lifecycle, position, 'positive_signal_count', 0);
  const decayScore = resolveLifecycleNumber(lifecycle, position, 'momentum_decay_score', 0);
  const pullbackFromPeakPct = resolveLifecycleNumber(lifecycle, position, 'pullback_from_peak_pct', 0);
  const stallDurationMs = resolveLifecycleNumber(lifecycle, position, 'stall_duration_ms', 0);
  const velocity = resolveObservationMetric(lifecycle, position, 'price_velocity_bps_per_sec', 0);
  const imbalance = resolveObservationMetric(lifecycle, position, 'trade_flow_imbalance', 0);
  const latestNewExtremeAgeMs = resolveLifecycleLatestExtremeAgeMs(lifecycle, position);
  const isHighConviction = sourceProfile === 'high_conviction';
  const earlyLossNegativePnlPct = isHighConviction
    ? BINANCE_POSITION_HC_EARLY_LOSS_NEGATIVE_PNL_PCT
    : BINANCE_POSITION_EARLY_LOSS_NEGATIVE_PNL_PCT;
  const reversalMinMfePct = Math.max(
    BINANCE_POSITION_REVERSAL_PROTECTION_MIN_MFE_PCT,
    resolveTradeCostConfig().minimum_gross_profit_pct
  );
  const weakProgress =
    !Number.isFinite(maxSeenPct) ||
    maxSeenPct <= config.maxSeenCapPct ||
    mfeDrawdownPct >= Math.max(config.pullbackPct, Number(maxSeenPct || 0) * 0.9);

  const earlyLossDetected =
    Number.isFinite(pnlPct) &&
    pnlPct <= earlyLossNegativePnlPct &&
    openedSeconds <= BINANCE_POSITION_EARLY_LOSS_WINDOW_SECONDS &&
    velocity <= BINANCE_POSITION_EARLY_LOSS_NEGATIVE_VELOCITY_BPS_PER_SEC &&
    latestNewExtremeAgeMs >= BINANCE_POSITION_EARLY_LOSS_NO_NEW_EXTREME_MS &&
    positiveSignalCount < negativeSignalCount;

  const reversalRetracePct = Number.isFinite(maxSeenPct) ? Math.max(0, maxSeenPct - pnlPct) : 0;
  const reversalDetected =
    Number.isFinite(maxSeenPct) &&
    maxSeenPct >= reversalMinMfePct &&
    reversalRetracePct >= maxSeenPct * BINANCE_POSITION_REVERSAL_PROTECTION_RETRACE_RATIO &&
    latestNewExtremeAgeMs >= BINANCE_POSITION_EARLY_LOSS_NO_NEW_EXTREME_MS &&
    (velocity <= 0 || imbalance < 0);

  const deteriorationConfirmed =
    Number.isFinite(pnlPct) &&
    pnlPct <= config.negativePnlPct &&
    lifecyclePhase === 'deterioration' &&
    negativeSignalCount >= config.negativeSignals &&
    decayScore >= config.decayScore &&
    (pullbackFromPeakPct >= config.pullbackPct ||
      stallDurationMs >= config.stallMs ||
      impulseReason === 'stall_confirmed' ||
      impulseReason === 'strong_deterioration');

  const nearMaxHoldLoss =
    Number.isFinite(pnlPct) &&
    openedSeconds >= Math.max(config.minSeconds, Math.round(positionMaxHoldSeconds * config.nearMaxHoldRatio)) &&
    pnlPct <= config.preMaxHoldPnlPct &&
    weakProgress &&
    positiveSignalCount <= negativeSignalCount;

  const severeLoss = Number.isFinite(pnlPct) && pnlPct <= config.severePnlPct;

  let trigger = null;
  if (reversalDetected) {
    trigger = {
      closeReason: 'reversal_protection_exit',
      logTag: 'REVERSAL_PROTECTION',
      confirmCycles: BINANCE_POSITION_REVERSAL_PROTECTION_CONFIRM_CYCLES,
      payload: {
        symbol: position?.symbol || 'UNKNOWN',
        source_profile: sourceProfile,
        pnl_pct: Number(pnlPct.toFixed(4)),
        max_seen_pct: Number(Number(maxSeenPct || 0).toFixed(4)),
        retrace_pct: Number(reversalRetracePct.toFixed(4)),
        retrace_ratio: Number(BINANCE_POSITION_REVERSAL_PROTECTION_RETRACE_RATIO.toFixed(4)),
        lifecycle_phase: lifecyclePhase,
        velocity_bps_per_sec: Number(velocity.toFixed(4)),
        imbalance: Number(imbalance.toFixed(4))
      }
    };
  } else if (earlyLossDetected) {
    trigger = {
      closeReason: 'early_loss_exit',
      logTag: 'EARLY_LOSS_EXIT',
      confirmCycles: BINANCE_POSITION_EARLY_LOSS_CONFIRM_CYCLES,
      payload: {
        symbol: position?.symbol || 'UNKNOWN',
        source_profile: sourceProfile,
        pnl_pct: Number(pnlPct.toFixed(4)),
        opened_seconds: Number(openedSeconds.toFixed(1)),
        velocity_bps_per_sec: Number(velocity.toFixed(4)),
        latest_new_extreme_age_ms: latestNewExtremeAgeMs,
        negative_signal_count: negativeSignalCount,
        positive_signal_count: positiveSignalCount
      }
    };
  } else if (severeLoss || deteriorationConfirmed || nearMaxHoldLoss) {
    trigger = {
      closeReason: nearMaxHoldLoss ? 'pre_max_hold_loss_protection' : 'loss_protection_exit',
      logTag: 'EARLY_LOSS_EXIT',
      confirmCycles: severeLoss ? 1 : config.confirmCycles,
      payload: {
        symbol: position?.symbol || 'UNKNOWN',
        source_profile: sourceProfile,
        pnl_pct: Number(pnlPct.toFixed(4)),
        lifecycle_phase: lifecyclePhase,
        momentum_decay_score: Number(decayScore.toFixed(4)),
        pullback_from_peak_pct: Number(pullbackFromPeakPct.toFixed(4)),
        stall_duration_ms: Math.round(stallDurationMs),
        near_max_hold_loss: Boolean(nearMaxHoldLoss),
        severe_loss: Boolean(severeLoss)
      }
    };
  }

  if (!trigger) return null;

  const nextWarningCount = Number(position?.loss_protection_warning_count || 0) + 1;
  if (nextWarningCount < trigger.confirmCycles) {
    return {
      close: false,
      reason: 'loss_protection_watch',
      pnl_pct: pnlPct,
      opened_minutes: openedMinutes,
      opened_seconds: openedSeconds,
      max_hold_seconds: positionMaxHoldSeconds,
      source_profile: sourceProfile,
      loss_protection_warning_count: nextWarningCount,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct,
      max_seen_pct: maxSeenPct,
      lifecycle_phase: lifecyclePhase,
      momentum_decay_score: decayScore,
      pullback_from_peak_pct: pullbackFromPeakPct,
      stall_duration_ms: stallDurationMs,
      planned_close_reason: trigger.closeReason
    };
  }

  logLossProtection(trigger.logTag, trigger.payload);
  return {
    close: true,
    reason: trigger.closeReason,
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    loss_protection_warning_count: nextWarningCount,
    min_seen_pct: minSeenPct,
    mfe_drawdown_pct: mfeDrawdownPct,
    max_seen_pct: maxSeenPct,
    lifecycle_phase: lifecyclePhase,
    momentum_decay_score: decayScore,
    pullback_from_peak_pct: pullbackFromPeakPct,
    stall_duration_ms: stallDurationMs,
    severe_loss: severeLoss,
    near_max_hold_loss: nearMaxHoldLoss
  };
}


function maybeExitOnHoldDeterioration(
  position,
  pnlPct,
  openedSeconds,
  positionMaxHoldSeconds,
  maxSeenPct,
  minSeenPct,
  openedMinutes,
  sourceProfile,
  mfeDrawdownPct,
  entryPrice,
  markPrice
) {
  const isHighConviction = sourceProfile === 'high_conviction';
  const deteriorationConfig = resolveHoldDeteriorationConfig(sourceProfile);
  const deteriorationWindowSeconds = Math.max(
    60,
    Math.round(positionMaxHoldSeconds * deteriorationConfig.windowRatio)
  );
  if (openedSeconds < deteriorationWindowSeconds) return null;

  const distanceToTpPct = resolveDistanceToTpPct(position, entryPrice, markPrice);
  const nearTp =
    Number.isFinite(distanceToTpPct) && distanceToTpPct <= deteriorationConfig.nearTpPct;
  const deteriorationWarningCount = Number(position?.hold_deterioration_warning_count || 0);
  const recoveryFromLowPct =
    Number.isFinite(minSeenPct) && Number.isFinite(pnlPct) ? Math.max(0, pnlPct - minSeenPct) : 0;
  const lowProgressDeterioration =
    maxSeenPct <= deteriorationConfig.maxMfePct &&
    pnlPct <= deteriorationConfig.pnlPct;

  if (lowProgressDeterioration) {
    const nextWarningCount = deteriorationWarningCount + 1;
    const hcStillRecoverable =
      isHighConviction &&
      (nearTp || recoveryFromLowPct >= BINANCE_POSITION_HC_HOLD_DETERIORATION_RECOVERY_PCT);
    const hcNeedsExtraMaturation =
      isHighConviction &&
      openedSeconds < deteriorationWindowSeconds + BINANCE_POSITION_HC_HOLD_DETERIORATION_EXTRA_GRACE_SECONDS;
    const requiredConfirmCycles = isHighConviction
      ? deteriorationConfig.confirmCycles + 1
      : deteriorationConfig.confirmCycles;

    if (
      nearTp ||
      nextWarningCount < requiredConfirmCycles ||
      hcStillRecoverable ||
      hcNeedsExtraMaturation
    ) {
      return {
        close: false,
        reason: 'hold_deterioration_watch',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        hold_deterioration_warning_count: nextWarningCount,
        distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct
      };
    }
    if (isHighConviction && pnlPct > BINANCE_POSITION_HC_HOLD_DETERIORATION_SEVERE_FLOOR_PCT) {
      return {
        close: false,
        reason: 'hold_deterioration_watch',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        hold_deterioration_warning_count: nextWarningCount,
        distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct,
        recovery_retrace_ratio: Number.isFinite(maxSeenPct) && maxSeenPct > 0
          ? Number((Math.max(0, maxSeenPct - pnlPct) / maxSeenPct).toFixed(4))
          : null
      };
    }
    return {
      close: true,
      reason: 'hold_deterioration_exit',
      pnl_pct: pnlPct,
      opened_minutes: openedMinutes,
      opened_seconds: openedSeconds,
      max_hold_seconds: positionMaxHoldSeconds,
      source_profile: sourceProfile,
      hold_deterioration_warning_count: nextWarningCount,
      distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct
    };
  }

  const profitReversalWindowSeconds = Math.max(
    60,
    Math.round(positionMaxHoldSeconds * BINANCE_POSITION_PROFIT_REVERSAL_RATIO)
  );
  const retracePct = Math.max(0, maxSeenPct - pnlPct);
  const retraceThresholdPct = Math.max(
    0.04,
    maxSeenPct * BINANCE_POSITION_PROFIT_REVERSAL_RETRACE_RATIO
  );
  const meaningfulReversal =
    openedSeconds >= profitReversalWindowSeconds &&
    maxSeenPct >= BINANCE_POSITION_PROFIT_REVERSAL_MIN_MFE_PCT &&
    pnlPct <= BINANCE_POSITION_PROFIT_REVERSAL_FLOOR_PCT &&
    retracePct >= retraceThresholdPct;

  if (!meaningfulReversal) return null;

  return {
    close: true,
    reason: 'profit_reversal_exit',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    min_seen_pct: minSeenPct,
    mfe_drawdown_pct: mfeDrawdownPct,
    max_seen_pct: maxSeenPct
  };
}

async function updateExecutionIntentOutcome(db, position, payload) {
  const predictionId = position?.prediction_id;
  const sourceProfile = String(position?.source_profile || position?.source || 'high_conviction');
  if (!predictionId) return;

  const snap = await db
    .collection('binance_execution_intents')
    .where('prediction_id', '==', predictionId)
    .where('source_profile', '==', sourceProfile)
    .where('status', '==', 'executed')
    .limit(1)
    .get();

  if (snap.empty) return;
  const ref = snap.docs[0].ref;
  await ref.set(
    {
      win_exchange: payload?.win_exchange || 'UNKNOWN',
      win_exchange_net: payload?.win_exchange_net || null,
      closed_at: payload?.closed_at || nowIso(),
      close_reason: payload?.close_reason || null,
      close_pnl_pct: Number(payload?.close_pnl_pct || 0),
      net_close_pnl_pct: Number(payload?.net_close_pnl_pct || 0),
      execution_audit: {
        win_exchange: payload?.win_exchange || 'UNKNOWN',
        win_exchange_net: payload?.win_exchange_net || null,
        closed_at: payload?.closed_at || nowIso(),
        close_reason: payload?.close_reason || null,
        close_pnl_pct: Number(payload?.close_pnl_pct || 0),
        net_close_pnl_pct: Number(payload?.net_close_pnl_pct || 0),
        estimated_roundtrip_cost_pct: Number(payload?.estimated_roundtrip_cost_pct || 0),
        trade_cost_model: payload?.trade_cost_model || null,
        close_price: Number(payload?.close_price || 0) || null,
        mark_price_at_close: Number(payload?.mark_price || 0) || null
      },
      updated_at: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

function shouldEarlyExit(position, config, markPrice, lifecycle = null) {
  const sourceProfile = resolveSourceProfile(position);
  const side = position?.side;
  const entry = Number(position?.entry_price || 0);
  const pnlPct = pnlPctFor(side, entry, markPrice);
  const maxSeenPct = resolveMaxSeenPct(position, pnlPct);
  const minSeenPct = resolveMinSeenPct(position, pnlPct);
  const openedMinutes = getOpenMinutes(position?.opened_at);
  const openedSeconds = getOpenSeconds(position?.opened_at);
  const drawdown = Number(position?.early_exit_drawdown_pct ?? config?.early_exit_drawdown_pct ?? 0.25);
  const positionMaxHoldSeconds = resolvePositionMaxHoldSeconds(position);
  const staleExitEnabled =
    sourceProfile === 'high_conviction'
      ? BINANCE_POSITION_HC_STALE_EXIT_ENABLED
      : BINANCE_POSITION_STALE_EXIT_ENABLED;
  const staleExitRatio =
    sourceProfile === 'high_conviction'
      ? BINANCE_POSITION_HC_STALE_EXIT_RATIO
      : BINANCE_POSITION_STALE_EXIT_RATIO;
  const staleExitMaxPnlPct =
    sourceProfile === 'high_conviction'
      ? BINANCE_POSITION_HC_STALE_EXIT_MAX_PNL_PCT
      : BINANCE_POSITION_STALE_EXIT_MAX_PNL_PCT;
  const staleExitThresholdSeconds = Math.max(
    60,
    Math.round(positionMaxHoldSeconds * staleExitRatio)
  );
  const staleGraceSeconds = Math.max(
    60,
    Math.min(staleExitThresholdSeconds, Math.round(positionMaxHoldSeconds * BINANCE_POSITION_STALE_GRACE_RATIO))
  );
  const staleWarningCount = Number(position?.stale_warning_count || 0);
  const partialExitCount = Number(position?.partial_exit_count || 0);
  const staleConfig = resolveStaleConfig(sourceProfile);
  const distanceToTpPct = resolveDistanceToTpPct(position, entry, markPrice);
  const hasPositiveProgress = maxSeenPct >= BINANCE_POSITION_TRAILING_TRIGGER_PCT;
  const mfeDrawdownPct = Math.max(0, maxSeenPct - pnlPct);
  const negativeConfirmation =
    pnlPct <= -staleConfig.negativeConfirmPct ||
    (pnlPct <= -staleConfig.microDrawdownTolerancePct && !hasPositiveProgress);

  if (position?.early_exit_enabled || config?.early_exit_enabled) {
    if (pnlPct <= -Math.abs(drawdown)) {
      return {
        close: true,
        reason: 'early_exit_drawdown',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds
      };
    }
    if (openedMinutes >= 2 && pnlPct >= BINANCE_EARLY_EXIT_MIN_PROFIT_PCT) {
      return {
        close: true,
        reason: 'early_exit_lock_profit',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds
      };
    }
  }

  const eventLossCapDecision = maybeCapEventLoss(
    position,
    pnlPct,
    openedSeconds,
    positionMaxHoldSeconds,
    openedMinutes
  );
  if (eventLossCapDecision) {
    return {
      ...eventLossCapDecision,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct
    };
  }

  const realLossProtectionDecision = maybeProtectRealLoss(
    position,
    lifecycle,
    pnlPct,
    openedSeconds,
    positionMaxHoldSeconds,
    maxSeenPct,
    minSeenPct,
    openedMinutes,
    sourceProfile,
    mfeDrawdownPct
  );
  if (realLossProtectionDecision) {
    return realLossProtectionDecision;
  }

  if (
    staleExitEnabled &&
    openedSeconds >= staleGraceSeconds &&
    openedSeconds >= staleExitThresholdSeconds &&
    pnlPct <= staleExitMaxPnlPct &&
    negativeConfirmation
  ) {
    const staleEvaluation =
      sourceProfile === 'event_emitted'
        ? buildEventStaleEvaluation({
            position,
            entryPrice: entry,
            markPrice,
            pnlPct,
            openedSeconds,
            staleExitThresholdSeconds,
            maxSeenPct,
            minSeenPct,
            staleWarningCount
          })
        : null;

    if (sourceProfile === 'event_emitted' && staleEvaluation?.grace_applied) {
      return {
        close: false,
        reason: 'event_stale_grace',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        stale_warning_count: staleWarningCount,
        stale_evaluation: staleEvaluation,
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct
      };
    }

    if (sourceProfile === 'event_emitted' && staleEvaluation?.final_decision === 'extend_monitoring') {
      return {
        close: false,
        reason: 'event_stale_watch',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        stale_warning_count: staleWarningCount + 1,
        stale_evaluation: staleEvaluation,
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct
      };
    }

    const requiredConfirmCycles =
      sourceProfile === 'event_emitted'
        ? BINANCE_EVENT_STALE_CONFIRM_CYCLES
        : BINANCE_POSITION_STALE_CONFIRM_CYCLES;
    if (staleWarningCount + 1 < requiredConfirmCycles) {
      return {
        close: false,
        reason: 'stale_watch',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        stale_warning_count: staleWarningCount + 1,
        stale_evaluation: staleEvaluation
      };
    }
    return {
      close: true,
      reason: 'stale_no_followthrough',
      pnl_pct: pnlPct,
      opened_minutes: openedMinutes,
      opened_seconds: openedSeconds,
      max_hold_seconds: positionMaxHoldSeconds,
      source_profile: sourceProfile,
      stale_warning_count: staleWarningCount + 1,
      stale_evaluation: staleEvaluation
    };
  }

  const profitProtectionDecision = maybeProtectAccumulatedProfit(
    position,
    pnlPct,
    openedSeconds,
    positionMaxHoldSeconds,
    maxSeenPct,
    openedMinutes,
    sourceProfile
  );
  if (profitProtectionDecision) {
    return {
      ...profitProtectionDecision,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct
    };
  }

  const progressiveCaptureDecision = maybePlanProgressiveCapture(
    position,
    pnlPct,
    openedSeconds,
    positionMaxHoldSeconds,
    maxSeenPct,
    partialExitCount,
    openedMinutes,
    sourceProfile
  );
  if (progressiveCaptureDecision) {
    return {
      ...progressiveCaptureDecision,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct
    };
  }

  const holdDeteriorationDecision = maybeExitOnHoldDeterioration(
    position,
    pnlPct,
    openedSeconds,
    positionMaxHoldSeconds,
    maxSeenPct,
    minSeenPct,
    openedMinutes,
    sourceProfile,
    mfeDrawdownPct,
    entry,
    markPrice
  );
  if (holdDeteriorationDecision) {
    return holdDeteriorationDecision;
  }

  const weakEventTimeoutDecision = maybeExitWeakEventBeforeMaxHold(
    position,
    pnlPct,
    openedSeconds,
    positionMaxHoldSeconds,
    maxSeenPct,
    openedMinutes,
    entry,
    markPrice
  );
  if (weakEventTimeoutDecision) {
    return {
      ...weakEventTimeoutDecision,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct
    };
  }

  if (openedSeconds >= positionMaxHoldSeconds) {
    const partialThresholds = resolveMaxHoldPartialThresholds(sourceProfile);
    const canPartialExit =
      partialExitCount < BINANCE_POSITION_PARTIAL_EXIT_MAX_COUNT &&
      pnlPct >= partialThresholds.pnlFloorPct &&
      maxSeenPct >= partialThresholds.mfeFloorPct;
    if (canPartialExit) {
      return {
        close: false,
        partial_close: true,
        reason: 'max_hold_partial_take_profit',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        partial_close_ratio: BINANCE_POSITION_PARTIAL_EXIT_RATIO,
        partial_exit_count: partialExitCount + 1,
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct
      };
    }

    const holdExtension = maybeExtendHoldWithMomentum(position, pnlPct, positionMaxHoldSeconds, maxSeenPct);
    if (holdExtension) {
      return {
        close: false,
        reason: 'extend_momentum_hold',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: holdExtension.extended_hold_seconds,
        source_profile: sourceProfile,
        hold_extension_count: holdExtension.extension_count,
        distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct
      };
    }

    const recoveryExtension = maybeExtendHoldForRecovery(
      position,
      pnlPct,
      positionMaxHoldSeconds,
      maxSeenPct,
      entry,
      markPrice
    );
    if (recoveryExtension) {
      return {
        close: false,
        reason: 'extend_recovery_hold',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: recoveryExtension.extended_hold_seconds,
        source_profile: sourceProfile,
        hold_extension_count: recoveryExtension.extension_count,
        distance_to_tp_pct: recoveryExtension.distance_to_tp_pct,
        distance_to_stop_pct: recoveryExtension.distance_to_stop_pct,
        recovery_retrace_ratio: recoveryExtension.retrace_ratio,
        soft_recovery_extension: Boolean(recoveryExtension.soft_recovery_extension),
        min_seen_pct: minSeenPct,
        mfe_drawdown_pct: mfeDrawdownPct
      };
    }

    return {
      close: true,
      reason: 'max_hold_reached',
      pnl_pct: pnlPct,
      opened_minutes: openedMinutes,
      opened_seconds: openedSeconds,
      max_hold_seconds: positionMaxHoldSeconds,
      source_profile: sourceProfile,
      distance_to_tp_pct: Number.isFinite(distanceToTpPct) ? Number(distanceToTpPct.toFixed(4)) : null,
      min_seen_pct: minSeenPct,
      mfe_drawdown_pct: mfeDrawdownPct
    };
  }

  return {
    close: false,
    reason: 'hold',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    stale_warning_count: 0,
    min_seen_pct: minSeenPct,
    mfe_drawdown_pct: mfeDrawdownPct
  };
}

function isFirestoreIndexMissingError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('requires an index') ||
    message.includes('failed_precondition') ||
    message.includes('create_composite')
  );
}

async function fetchClosedExecutedIntentsWithFallback(db, options = {}) {
  const safeLimit = Math.max(10, Math.min(Number(options.limit || 50), 500));
  const dayStartIso = options.dayStartIso || null;

  try {
    let query = db
      .collection('binance_execution_intents')
      .where('status', '==', 'executed')
      .where('closed_at', '!=', null)
      .orderBy('closed_at', 'desc')
      .limit(safeLimit);
    if (dayStartIso) {
      query = db
        .collection('binance_execution_intents')
        .where('status', '==', 'executed')
        .where('closed_at', '>=', dayStartIso)
        .orderBy('closed_at', 'desc')
        .limit(safeLimit);
    }
    return await query.get();
  } catch (err) {
    if (!isFirestoreIndexMissingError(err)) throw err;
    console.warn('[INTENT_CLOSED_SCAN_FALLBACK]', {
      limit: safeLimit,
      day_start_iso: dayStartIso,
      message: String(err?.message || err)
    });
    const rawSnap = await db.collection('binance_execution_intents').orderBy('created_at', 'desc').limit(1000).get();
    const filteredDocs = rawSnap.docs.filter((doc) => {
      const data = doc.data() || {};
      if (String(data.status || '').toLowerCase() !== 'executed') return false;
      const closedAt = String(data.closed_at || '');
      if (!closedAt) return false;
      if (dayStartIso && closedAt < dayStartIso) return false;
      return true;
    }).slice(0, safeLimit);
    return {
      size: filteredDocs.length,
      docs: filteredDocs
    };
  }
}

async function logDailyRealPnl(db) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();
  const snap = await fetchClosedExecutedIntentsWithFallback(db, {
    limit: 200,
    dayStartIso
  });

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const pnl = Number((data.close_pnl_pct ?? data.execution_audit?.close_pnl_pct) || 0);
    if (!Number.isFinite(pnl)) return;
    totalPnl += pnl;
    if (pnl > 0) wins += 1;
    if (pnl < 0) losses += 1;
  });

  console.log('[REAL_PNL]', {
    date: dayStartIso.slice(0, 10),
    trades_closed: wins + losses,
    wins,
    losses,
    win_rate_pct: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(2)) : 0,
    total_pnl_pct: Number(totalPnl.toFixed(4))
  });
}

async function runAutoAuditIfNeeded(db) {
  const allClosedSnap = await fetchClosedExecutedIntentsWithFallback(db, {
    limit: 10
  });

  if (allClosedSnap.size < 10) return;

  const totalClosedSnap = await db
    .collection('binance_execution_intents')
    .where('status', '==', 'executed')
    .where('closed_at', '!=', null)
    .count()
    .get();

  const totalClosed = Number(totalClosedSnap.data()?.count || 0);
  if (totalClosed < 10 || totalClosed % 10 !== 0) return;

  const runtimeRef = db.collection('system_runtime_config').doc('bot_execution');
  const runtimeSnap = await runtimeRef.get();
  const lastAuditCount = Number(runtimeSnap.data()?.last_auto_audit_trade_count || 0);
  if (lastAuditCount >= totalClosed) return;

  let wins = 0;
  let totalPnl = 0;
  allClosedSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const pnl = Number((data.close_pnl_pct ?? data.execution_audit?.close_pnl_pct) || 0);
    if (!Number.isFinite(pnl)) return;
    totalPnl += pnl;
    if (pnl > 0) wins += 1;
  });

  const winRate = (wins / 10) * 100;
  const avgPnl = totalPnl / 10;

  console.log('=== AUTO AUDIT ===');
  console.log(`WIN_RATE: ${winRate.toFixed(2)}%`);
  console.log(`AVG_PNL: ${avgPnl.toFixed(4)}%`);
  console.log(`TOTAL_PNL: ${totalPnl.toFixed(4)}%`);

  const runtimeUpdate = {
    last_auto_audit_trade_count: totalClosed,
    last_auto_audit_at: nowIso(),
    last_auto_audit: {
      win_rate_pct: Number(winRate.toFixed(2)),
      avg_pnl_pct: Number(avgPnl.toFixed(4)),
      total_pnl_pct: Number(totalPnl.toFixed(4))
    },
    updated_at: FieldValue.serverTimestamp()
  };

  if (totalPnl < 0) {
    runtimeUpdate.execution_enabled = false;
    runtimeUpdate.auto_trade_mode = false;
    runtimeUpdate.status = 'HALTED';
    runtimeUpdate.halted_reason = 'auto_audit_total_pnl_negative';
    runtimeUpdate.halted_at = nowIso();
    await db.collection('binance_bot_config').doc('global').set({ execution_enabled: false, updated_at: nowIso() }, { merge: true });
  }

  await runtimeRef.set(runtimeUpdate, { merge: true });
}

async function runBinancePositionManagerCycle(db) {
  console.log('[EXECUTION_STATUS]', { enabled: true, component: 'binance_position_manager' });

  const config = await getBinanceBotConfig(db);
  const adaptiveExitConfig = resolveAdaptiveExitConfig(config);
  const effectiveMode = config.mode === 'off' ? 'live' : config.mode;

  try {
    await syncOperationalMarketObservation(db, { config });
  } catch (err) {
    console.warn('[MARKET_STREAM] operational sync failed', err.message);
  }

  const openSnap = await db
    .collection('binance_open_positions')
    .where('status', '==', 'open')
    .limit(BINANCE_POSITION_MANAGER_MAX_OPEN)
    .get();

  let checked = 0;
  let closed = 0;
  let skipped = 0;
  let failed = 0;
  let shadowCandidates = 0;
  let shadowConflicts = 0;

  for (const doc of openSnap.docs) {
    checked += 1;
    const position = doc.data() || {};
    try {
      const symbol = resolveManagedPositionSymbol(position);
      const qty = Number(position.quantity || 0);
      if (!symbol || !qty) {
        logSymbolError({
          stage: 'position_manager',
          source: 'binance_open_positions',
          doc_id: doc.id,
          prediction_id: position?.prediction_id || null,
          symbol_raw:
            position?.symbol ||
            position?.intent?.symbol ||
            position?.signal_symbol ||
            position?.simbolo ||
            position?.simbolo_normalizado ||
            null,
          quantity: Number.isFinite(qty) ? qty : null
        });
        skipped += 1;
        continue;
      }
      position.symbol = symbol;
      logSymbolFlow({
        symbol,
        source: 'binance_open_positions',
        stage: 'position_manager',
        predictionId: position?.prediction_id || null
      });
      if (String(doc.data()?.symbol || '').toUpperCase() !== symbol) {
        await doc.ref.set(
          {
            symbol,
            updated_at: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }

      try {
        await ensureSymbolObservation(symbol, 'open_position', {
          db,
          config,
          key: `position:${doc.id}`,
          ttlMs: config?.market_stream?.position_ttl_ms,
          priority: 5,
          metadata: {
            source_profile: resolveSourceProfile(position),
            prediction_id: position?.prediction_id || null
          }
        });
      } catch (err) {
        console.warn('[MARKET_STREAM] ensure open position failed', err.message);
      }

      const markPrice = await getMarkPrice(symbol);
      const marketSnapshot = getMarketSnapshot(symbol);
      const lifecycle = updateImpulseLifecycle(position, marketSnapshot, {
        botConfig: config,
        markPrice
      });
      let decision = shouldEarlyExit(position, config, markPrice, lifecycle);
      const baseDecision = { ...decision };
      const disciplineDecision = evaluatePositionDiscipline(position, markPrice, {
        pnl_pct: decision.pnl_pct,
        requested_reason: decision.reason,
        lifecycle,
        market_snapshot: marketSnapshot
      });

      if (disciplineDecision.forceClose) {
        if (disciplineDecision.forceReason === 'profit_capture_enforced') {
          const disciplinePnlPct = Number.isFinite(Number(disciplineDecision.details?.pnl_pct))
            ? Number(disciplineDecision.details.pnl_pct)
            : decision.pnl_pct;
          const disciplineMaxSeenPct = resolveMaxSeenPct(position, disciplinePnlPct);
          const disciplineFloorPct = Number.isFinite(Number(disciplineDecision.details?.lock_floor_pct))
            ? Number(disciplineDecision.details.lock_floor_pct)
            : Number.isFinite(Number(disciplineDecision.details?.trailing_lock_floor_pct))
              ? Number(disciplineDecision.details.trailing_lock_floor_pct)
              : Number(position?.profit_capture_lock_pct || 0);
          const disciplineProfitCaptureGate = evaluateProfitCaptureGate(
            disciplinePnlPct,
            disciplineMaxSeenPct,
            disciplineFloorPct
          );

          if (disciplineProfitCaptureGate.allow) {
            decision = {
              ...decision,
              close: true,
              reason: disciplineDecision.forceReason,
              pnl_pct: disciplinePnlPct,
              profit_lock_floor_pct: disciplineProfitCaptureGate.effectiveFloorPct,
              max_seen_pct: disciplineMaxSeenPct,
              profit_capture_activation_pct: disciplineProfitCaptureGate.activationThresholdPct,
              profit_capture_net_buffer_pct: disciplineProfitCaptureGate.netBufferPct,
              profit_capture_retrace_pct: disciplineProfitCaptureGate.retracePct,
              profit_capture_retrace_threshold_pct: disciplineProfitCaptureGate.retraceThresholdPct
            };
          } else {
            decision = baseDecision;
          }
        } else {
          decision = {
            ...decision,
            close: true,
            reason: disciplineDecision.forceReason,
            pnl_pct: Number.isFinite(Number(disciplineDecision.details?.pnl_pct))
              ? Number(disciplineDecision.details.pnl_pct)
              : decision.pnl_pct
          };
        }
      } else if (disciplineDecision.blockExit) {
        decision = {
          ...decision,
          close: false,
          reason: disciplineDecision.blockReason
        };
      }

      const shadowDecision = evaluateAdaptiveExit(
        {
          ...position,
          impulse_lifecycle: lifecycle
        },
        marketSnapshot,
        lifecycle,
        {
          botConfig: config,
          markPrice
        }
      );
      logAdaptiveExitEvents(position, lifecycle, shadowDecision);
      const shadowSummary = buildAdaptiveShadowSummary(position, shadowDecision, decision, lifecycle, false);
      if (shadowDecision.should_exit) {
        shadowCandidates += 1;
      }
      if (shadowSummary.conflicts_count > Number(position?.adaptive_exit_shadow?.conflicts_count || 0)) {
        shadowConflicts += 1;
      }

      if (adaptiveExitConfig.mode === 'enforce' && shadowDecision.should_exit && !decision.close) {
        decision = {
          ...decision,
          close: true,
          reason: `adaptive_${shadowDecision.exit_reason}`,
          pnl_pct: Number(shadowDecision.shadow_exit_pnl_pct || decision.pnl_pct),
          adaptive_exit_shadow_reason: shadowDecision.exit_reason,
          adaptive_exit_shadow_priority: Number(shadowDecision.exit_priority || 0),
          adaptive_exit_shadow_confidence: Number(shadowDecision.exit_confidence || 0)
        };
      }

      if (!decision.close) {
        const latestMaxSeenPct = resolveMaxSeenPct(position, decision.pnl_pct);
        const latestMinSeenPct = resolveMinSeenPct(position, decision.pnl_pct);
        const updatePayload = {
          mark_price: markPrice,
          unrealized_pnl_pct: Number(decision.pnl_pct.toFixed(4)),
          opened_minutes: Number(decision.opened_minutes.toFixed(2)),
          opened_seconds: Number(decision.opened_seconds.toFixed(1)),
          position_max_hold_seconds: Number(decision.max_hold_seconds || 0),
          profit_capture_max_seen_pct: Number(latestMaxSeenPct.toFixed(4)),
          min_seen_pct: Number(latestMinSeenPct.toFixed(4)),
          impulse_state: lifecycle.impulse_state,
          impulse_state_reason: lifecycle.impulse_state_reason,
          lifecycle_last_updated_at: lifecycle.lifecycle_last_updated_at,
          last_micro_price: lifecycle.last_micro_price,
          last_microstructure_snapshot: marketSnapshot || null,
          impulse_lifecycle: lifecycle,
          adaptive_exit_shadow: shadowSummary,
          adaptive_exit_hierarchy: {
            current_reason: decision.reason,
            current_close: false,
            shadow_reason: shadowDecision.exit_reason,
            shadow_should_exit: Boolean(shadowDecision.should_exit),
            shadow_priority: Number(shadowDecision.exit_priority || 0),
            winner: shadowDecision.should_exit ? `shadow:${shadowDecision.exit_reason}` : `current:${decision.reason}`
          },
          manager_last_check_at: nowIso(),
          updated_at: FieldValue.serverTimestamp()
        };
        if (Number.isFinite(Number(decision.stale_warning_count))) {
          updatePayload.stale_warning_count = Number(decision.stale_warning_count);
        } else if (decision.reason === 'hold') {
          updatePayload.stale_warning_count = 0;
        }
        if (Number.isFinite(Number(decision.hold_deterioration_warning_count))) {
          updatePayload.hold_deterioration_warning_count = Number(decision.hold_deterioration_warning_count);
        } else if (
          decision.reason === 'hold' ||
          decision.reason === 'extend_momentum_hold' ||
          decision.reason === 'extend_recovery_hold' ||
          decision.reason === 'pre_max_hold_partial_take_profit' ||
          decision.reason === 'max_hold_partial_take_profit'
        ) {
          updatePayload.hold_deterioration_warning_count = 0;
        }
        if (Number.isFinite(Number(decision.loss_protection_warning_count))) {
          updatePayload.loss_protection_warning_count = Number(decision.loss_protection_warning_count);
        } else if (
          decision.reason === 'hold' ||
          decision.reason === 'extend_momentum_hold' ||
          decision.reason === 'extend_recovery_hold' ||
          decision.reason === 'pre_max_hold_partial_take_profit' ||
          decision.reason === 'max_hold_partial_take_profit' ||
          decision.reason === 'profit_capture_enforced' ||
          Number(decision.pnl_pct || 0) >= 0
        ) {
          updatePayload.loss_protection_warning_count = 0;
        }
        if (disciplineDecision.armProfitCapture) {
          updatePayload.profit_capture_armed = true;
          updatePayload.profit_capture_trigger_pct = Number(disciplineDecision.details?.capture_trigger_pct || 0) || null;
          updatePayload.profit_capture_lock_pct = Number(disciplineDecision.details?.lock_floor_pct || 0) || null;
        }
        if (Number.isFinite(Number(disciplineDecision.details?.max_seen_pct))) {
          updatePayload.profit_capture_max_seen_pct = Number(disciplineDecision.details.max_seen_pct);
        }
        if (Number.isFinite(Number(decision.profit_lock_floor_pct))) {
          updatePayload.profit_capture_lock_pct = Number(decision.profit_lock_floor_pct);
        }
        if (Number.isFinite(Number(decision.profit_capture_activation_pct))) {
          updatePayload.profit_capture_activation_pct = Number(decision.profit_capture_activation_pct);
        }
        if (Number.isFinite(Number(decision.profit_capture_net_buffer_pct))) {
          updatePayload.profit_capture_net_buffer_pct = Number(decision.profit_capture_net_buffer_pct);
        }
        if (Number.isFinite(Number(decision.profit_capture_retrace_pct))) {
          updatePayload.profit_capture_retrace_pct = Number(decision.profit_capture_retrace_pct);
        }
        if (Number.isFinite(Number(decision.profit_capture_retrace_threshold_pct))) {
          updatePayload.profit_capture_retrace_threshold_pct = Number(decision.profit_capture_retrace_threshold_pct);
        }
        if (Number.isFinite(Number(decision.distance_to_tp_pct))) {
          updatePayload.distance_to_tp_pct = Number(decision.distance_to_tp_pct);
        }
        if (Number.isFinite(Number(decision.recovery_retrace_ratio))) {
          updatePayload.recovery_retrace_ratio = Number(decision.recovery_retrace_ratio);
        }
        if (Number.isFinite(Number(decision.distance_to_stop_pct))) {
          updatePayload.distance_to_stop_pct = Number(decision.distance_to_stop_pct);
        }
        if (decision.stale_evaluation) {
          updatePayload.stale_evaluation = decision.stale_evaluation;
        }
        if (Number.isFinite(Number(decision.hold_extension_count))) {
          updatePayload.hold_extension_count = Number(decision.hold_extension_count);
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            extended_hold_seconds: Number(decision.max_hold_seconds || 0),
            distance_to_tp_pct: Number(decision.distance_to_tp_pct || 0) || null,
            distance_to_stop_pct: Number(decision.distance_to_stop_pct || 0) || null,
            recovery_retrace_ratio: Number(decision.recovery_retrace_ratio || 0) || null,
            soft_recovery_extension: Boolean(decision.soft_recovery_extension)
          };
        } else if (disciplineDecision.blockExit || disciplineDecision.armProfitCapture) {
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            discipline: disciplineDecision.details
          };
        } else if (decision.reason === 'hold_deterioration_watch') {
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            hold_deterioration_warning_count: Number(decision.hold_deterioration_warning_count || 0),
            distance_to_tp_pct: Number(decision.distance_to_tp_pct || 0) || null
          };
        } else if (decision.reason === 'loss_protection_watch') {
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            loss_protection_warning_count: Number(decision.loss_protection_warning_count || 0),
            momentum_decay_score: Number(decision.momentum_decay_score || 0) || null,
            pullback_from_peak_pct: Number(decision.pullback_from_peak_pct || 0) || null
          };
        } else if (decision.reason === 'pre_max_hold_partial_take_profit') {
          updatePayload.manager_decision = {
            close: false,
            partial_close: true,
            reason: decision.reason,
            profit_lock_floor_pct: Number(decision.profit_lock_floor_pct || 0) || null
          };
        } else if (shadowDecision.should_exit) {
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            shadow_candidate: {
              exit_reason: shadowDecision.exit_reason,
              exit_priority: Number(shadowDecision.exit_priority || 0),
              exit_confidence: Number(shadowDecision.exit_confidence || 0),
              shadow_exit_pnl_pct: Number(shadowDecision.shadow_exit_pnl_pct || 0) || null
            }
          };
        }
        if (decision.partial_close) {
          const partialQtyRaw = qty * Number(decision.partial_close_ratio || BINANCE_POSITION_PARTIAL_EXIT_RATIO);
          const partialQty = partialQtyRaw;
          if (partialQty > 0 && partialQty < qty) {
            let partialCloseOrder = null;
            let executedPartialQty = partialQty;
            if (config.mode !== 'dry-run') {
              partialCloseOrder = await closePositionMarket({
                symbol,
                side: position.side,
                quantity: partialQty,
                _quantity_precision: position.quantity_precision,
                _quantity_step: position.quantity_step
              });
              executedPartialQty = Number(partialCloseOrder?.executedQty || partialQty);
            }
            const remainingQty = Math.max(0, Number((qty - executedPartialQty).toFixed(6)));
            updatePayload.quantity = config.mode === 'dry-run'
              ? qty
              : (remainingQty > 0 ? remainingQty : qty);
            updatePayload.partial_exit_count = Number(decision.partial_exit_count || 1);
            updatePayload.partial_exit_last_at = nowIso();
            updatePayload.partial_exit_last_reason = decision.reason;
            updatePayload.partial_exit_last_qty = config.mode === 'dry-run' ? 0 : executedPartialQty;
            updatePayload.partial_exit_last_pnl_pct = Number(decision.pnl_pct.toFixed(4));
            updatePayload.profit_capture_armed = true;
            updatePayload.profit_capture_trigger_pct =
              Number(disciplineDecision.details?.capture_trigger_pct || 0) ||
              Number(position?.profit_capture_trigger_pct || 0) ||
              null;
            updatePayload.profit_capture_lock_pct =
              Number(disciplineDecision.details?.lock_floor_pct || 0) ||
              Number(position?.profit_capture_lock_pct || 0) ||
              null;
            updatePayload.manager_decision = {
              close: false,
              partial_close: true,
              reason: decision.reason,
              dry_run: config.mode === 'dry-run',
              partial_close_ratio: Number(decision.partial_close_ratio || BINANCE_POSITION_PARTIAL_EXIT_RATIO),
              remaining_quantity: updatePayload.quantity
            };
            await doc.ref.update(updatePayload);
            await logAdaptiveShadowDecision(db, doc.ref, position, lifecycle, shadowDecision, decision);
            await logExecutionDiscipline(db, {
              type: 'exit_control',
              event: decision.reason,
              blocked: false,
              source_profile: resolveSourceProfile(position),
              symbol,
              prediction_id: position.prediction_id || null,
              details: {
                pnl_pct: Number(decision.pnl_pct.toFixed(4)),
                partial_close_qty: executedPartialQty,
                partial_close_ratio: Number(decision.partial_close_ratio || BINANCE_POSITION_PARTIAL_EXIT_RATIO),
                remaining_quantity: updatePayload.quantity,
                max_hold_seconds: Number(decision.max_hold_seconds || 0),
                max_seen_pct: updatePayload.profit_capture_max_seen_pct,
                min_seen_pct: updatePayload.min_seen_pct
              }
            });
            skipped += 1;
            continue;
          }
        }
        await doc.ref.update(updatePayload);
        await logAdaptiveShadowDecision(db, doc.ref, position, lifecycle, shadowDecision, decision);
        if (disciplineDecision.blockExit || disciplineDecision.armProfitCapture) {
          await logExecutionDiscipline(db, {
            type: 'exit_control',
            event: decision.reason,
            blocked: disciplineDecision.blockExit,
            source_profile: resolveSourceProfile(position),
            symbol,
            prediction_id: position.prediction_id || null,
            details: disciplineDecision.details
          });
        }
        skipped += 1;
        continue;
      }

      if (config.mode === 'dry-run') {
        await doc.ref.update({
          mark_price: markPrice,
          unrealized_pnl_pct: Number(decision.pnl_pct.toFixed(4)),
          opened_minutes: Number(decision.opened_minutes.toFixed(2)),
          opened_seconds: Number(decision.opened_seconds.toFixed(1)),
          position_max_hold_seconds: Number(decision.max_hold_seconds || 0),
          impulse_state: lifecycle.impulse_state,
          impulse_state_reason: lifecycle.impulse_state_reason,
          lifecycle_last_updated_at: lifecycle.lifecycle_last_updated_at,
          last_micro_price: lifecycle.last_micro_price,
          last_microstructure_snapshot: marketSnapshot || null,
          impulse_lifecycle: lifecycle,
          adaptive_exit_shadow: shadowSummary,
          manager_last_check_at: nowIso(),
          manager_decision: { close: true, reason: decision.reason, dry_run: true },
          updated_at: FieldValue.serverTimestamp()
        });
        await logAdaptiveShadowDecision(db, doc.ref, position, lifecycle, shadowDecision, decision);
        skipped += 1;
        continue;
      }

      const risk = await getPositionRisk(symbol);
      const positionAmt = Number(risk?.positionAmt || 0);
      const isAlreadyClosed = !positionAmt || Math.abs(positionAmt) < 0.0000001;
      let closeOrder = null;
      if (!isAlreadyClosed) {
        closeOrder = await closePositionMarket({
          symbol,
          side: position.side,
          quantity: qty,
          _quantity_precision: position.quantity_precision,
          _quantity_step: position.quantity_step
        });
      }

      const closePrice =
        Number(closeOrder?.avgPrice || 0) > 0
          ? Number(closeOrder.avgPrice)
          : Number(markPrice || 0) || null;
      const realizedPnlPct = Number(decision.pnl_pct.toFixed(4));
      const tradeCostModel = resolveTradeCostConfig();
      const netRealizedPnlPct = estimateNetPnlPct(realizedPnlPct, tradeCostModel);
      const netExchangeOutcome = resolveNetOutcome(realizedPnlPct, tradeCostModel);
      const closedAtIso = nowIso();
      const closingShadowSummary = buildAdaptiveShadowSummary(position, shadowDecision, decision, lifecycle, true);
      const adaptiveComparison = buildAdaptiveExitComparison(position, closingShadowSummary, {
        real_close_at: closedAtIso,
        real_close_reason: decision.reason,
        real_close_price: closePrice,
        real_close_pnl_pct: realizedPnlPct,
        real_close_net_pnl_pct: netRealizedPnlPct
      });

      await doc.ref.update({
        status: 'closed',
        closed_at: closedAtIso,
        close_reason: decision.reason,
        win_exchange: resolveExchangeOutcome(realizedPnlPct),
        manager_last_check_at: nowIso(),
        mark_price: markPrice,
        close_price: closePrice,
        close_pnl_pct: realizedPnlPct,
        gross_close_pnl_pct: realizedPnlPct,
        net_close_pnl_pct: netRealizedPnlPct,
        estimated_roundtrip_cost_pct: tradeCostModel.cost_floor_pct,
        estimated_fee_roundtrip_pct: tradeCostModel.roundtrip_fee_pct,
        estimated_slippage_buffer_pct: tradeCostModel.slippage_buffer_pct,
        minimum_net_profit_pct: tradeCostModel.minimum_net_profit_pct,
        minimum_gross_profit_pct: tradeCostModel.minimum_gross_profit_pct,
        trade_cost_model: tradeCostModel,
        win_exchange_net: netExchangeOutcome,
        unrealized_pnl_pct: realizedPnlPct,
        opened_minutes: Number(decision.opened_minutes.toFixed(2)),
        opened_seconds: Number(decision.opened_seconds.toFixed(1)),
        position_max_hold_seconds: Number(decision.max_hold_seconds || 0),
        stale_evaluation: decision.stale_evaluation || null,
        profit_capture_max_seen_pct: Number(resolveMaxSeenPct(position, decision.pnl_pct).toFixed(4)),
        min_seen_pct: Number(resolveMinSeenPct(position, decision.pnl_pct).toFixed(4)),
        impulse_state: lifecycle.impulse_state,
        impulse_state_reason: lifecycle.impulse_state_reason,
        lifecycle_last_updated_at: lifecycle.lifecycle_last_updated_at,
        last_micro_price: lifecycle.last_micro_price,
        last_microstructure_snapshot: marketSnapshot || null,
        impulse_lifecycle: lifecycle,
        adaptive_exit_shadow: closingShadowSummary,
        adaptive_exit_comparison: adaptiveComparison,
        adaptive_exit_hierarchy: {
          current_reason: decision.reason,
          current_close: true,
          shadow_reason: shadowDecision.exit_reason,
          shadow_should_exit: Boolean(shadowDecision.should_exit),
          shadow_priority: Number(shadowDecision.exit_priority || 0),
          winner: `current:${decision.reason}`
        },
        hold_deterioration_warning_count: Number(decision.hold_deterioration_warning_count || 0) || 0,
        loss_protection_warning_count: Number(decision.loss_protection_warning_count || 0) || 0,
        distance_to_tp_pct: Number(decision.distance_to_tp_pct || 0) || null,
        distance_to_stop_pct: Number(decision.distance_to_stop_pct || 0) || null,
        recovery_retrace_ratio: Number(decision.recovery_retrace_ratio || 0) || null,
        profit_capture_activation_pct: Number(decision.profit_capture_activation_pct || 0) || null,
        profit_capture_net_buffer_pct: Number(decision.profit_capture_net_buffer_pct || 0) || null,
        estimated_profit_cost_pct: Number(decision.estimated_roundtrip_cost_pct || tradeCostModel.cost_floor_pct || 0) || null,
        profit_capture_minimum_net_profit_pct: Number(decision.minimum_net_profit_pct || tradeCostModel.minimum_net_profit_pct || 0) || null,
        profit_capture_minimum_gross_profit_pct: Number(decision.minimum_gross_profit_pct || tradeCostModel.minimum_gross_profit_pct || 0) || null,
        profit_capture_retrace_pct: Number(decision.profit_capture_retrace_pct || 0) || null,
        profit_capture_retrace_threshold_pct: Number(decision.profit_capture_retrace_threshold_pct || 0) || null,
        close_order: closeOrder || { skipped: 'already_closed' },
        updated_at: FieldValue.serverTimestamp()
      });
      await logAdaptiveShadowDecision(db, doc.ref, position, lifecycle, shadowDecision, decision);
      if (adaptiveComparison.shadow_available) {
        await db.collection('adaptive_exit_position_comparisons').add({
          position_id: doc.id,
          prediction_id: position?.prediction_id || null,
          symbol,
          source_profile: resolveSourceProfile(position),
          comparison: adaptiveComparison,
          impulse_state: lifecycle.impulse_state,
          impulse_state_reason: lifecycle.impulse_state_reason,
          created_at: FieldValue.serverTimestamp(),
          created_at_iso: nowIso()
        });
      }

      await logExecutionDiscipline(db, {
        type: 'exit_control',
        event: decision.reason,
        blocked: false,
        source_profile: resolveSourceProfile(position),
        symbol,
        prediction_id: position.prediction_id || null,
        details: {
          pnl_pct: realizedPnlPct,
          net_pnl_pct: netRealizedPnlPct,
          estimated_roundtrip_cost_pct: tradeCostModel.cost_floor_pct,
          trade_cost_model: tradeCostModel,
          mark_price: markPrice,
          close_price: closePrice,
          max_hold_seconds: Number(decision.max_hold_seconds || 0),
          max_seen_pct: Number(resolveMaxSeenPct(position, decision.pnl_pct).toFixed(4)),
          min_seen_pct: Number(resolveMinSeenPct(position, decision.pnl_pct).toFixed(4)),
          mfe_drawdown_pct: Number(Number(decision.mfe_drawdown_pct || 0).toFixed(4)),
          hold_deterioration_warning_count: Number(decision.hold_deterioration_warning_count || 0) || 0,
          loss_protection_warning_count: Number(decision.loss_protection_warning_count || 0) || 0,
          distance_to_tp_pct: Number(decision.distance_to_tp_pct || 0) || null,
          distance_to_stop_pct: Number(decision.distance_to_stop_pct || 0) || null,
          recovery_retrace_ratio: Number(decision.recovery_retrace_ratio || 0) || null,
          profit_lock_floor_pct: Number(decision.profit_lock_floor_pct || 0) || null,
          profit_capture_activation_pct: Number(decision.profit_capture_activation_pct || 0) || null,
          profit_capture_net_buffer_pct: Number(decision.profit_capture_net_buffer_pct || 0) || null,
          profit_capture_minimum_gross_profit_pct:
            Number(decision.minimum_gross_profit_pct || tradeCostModel.minimum_gross_profit_pct || 0) || null,
          profit_capture_retrace_pct: Number(decision.profit_capture_retrace_pct || 0) || null,
          profit_capture_retrace_threshold_pct: Number(decision.profit_capture_retrace_threshold_pct || 0) || null,
          stale_evaluation: decision.stale_evaluation || null
        }
      });

      await updateExecutionIntentOutcome(db, position, {
        win_exchange: resolveExchangeOutcome(realizedPnlPct),
        win_exchange_net: netExchangeOutcome,
        closed_at: closedAtIso,
        close_reason: decision.reason,
        close_pnl_pct: realizedPnlPct,
        net_close_pnl_pct: netRealizedPnlPct,
        estimated_roundtrip_cost_pct: tradeCostModel.cost_floor_pct,
        trade_cost_model: tradeCostModel,
        close_price: closePrice,
        mark_price: markPrice
      });
      console.log('[REAL_TRADE_RESULT]', {
        symbol,
        side: position?.side || null,
        close_reason: decision.reason,
        entry_price: Number(position?.entry_price || 0),
        exit_price: Number(closePrice || 0),
        pnl_pct: Number(realizedPnlPct.toFixed(4)),
        net_pnl_pct: Number(netRealizedPnlPct.toFixed(4)),
        closed_at: closedAtIso
      });
      await logDailyRealPnl(db);
      await runAutoAuditIfNeeded(db);
      await syncPredictionClosedTradeState(db, {
        predictionId: position?.prediction_id || null,
        sourceProfile: resolveSourceProfile(position),
        symbol,
        positionId: doc.id,
        closedAt: closedAtIso,
        closeReason: decision.reason,
        closePnlPct: realizedPnlPct,
        netClosePnlPct: netRealizedPnlPct,
        winExchange: resolveExchangeOutcome(realizedPnlPct),
        winExchangeNet: netExchangeOutcome,
        orderId: position?.order_id || null,
        traceId: position?.trace_id || null
      });

      try {
        releaseSymbolObservation(symbol, 'open_position', { key: `position:${doc.id}` });
      } catch (_) {
        // noop
      }

      closed += 1;
    } catch (err) {
      failed += 1;
      await doc.ref.update({
        manager_last_check_at: nowIso(),
        manager_error: String(err?.message || err),
        updated_at: FieldValue.serverTimestamp()
      });
    }
  }

  const summary = {
    enabled: true,
    mode: effectiveMode,
    checked,
    closed,
    skipped,
    failed,
    adaptive_shadow_candidates: shadowCandidates,
    adaptive_shadow_conflicts: shadowConflicts,
    max_hold_minutes: BINANCE_POSITION_MAX_HOLD_MINUTES,
    early_exit_min_profit_pct: BINANCE_EARLY_EXIT_MIN_PROFIT_PCT,
    stale_exit_enabled: BINANCE_POSITION_STALE_EXIT_ENABLED,
    stale_exit_ratio: BINANCE_POSITION_STALE_EXIT_RATIO,
    stale_exit_max_pnl_pct: BINANCE_POSITION_STALE_EXIT_MAX_PNL_PCT,
    high_conviction_stale_exit_enabled: BINANCE_POSITION_HC_STALE_EXIT_ENABLED,
    high_conviction_stale_exit_ratio: BINANCE_POSITION_HC_STALE_EXIT_RATIO,
    high_conviction_stale_exit_max_pnl_pct: BINANCE_POSITION_HC_STALE_EXIT_MAX_PNL_PCT
  };

  await db.collection('binance_position_manager_logs').add({
    ...summary,
    created_at: FieldValue.serverTimestamp()
  });

  return summary;
}

module.exports = {
  runBinancePositionManagerCycle
};



