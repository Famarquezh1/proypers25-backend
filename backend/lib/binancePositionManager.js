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

const BINANCE_POSITION_MANAGER_ENABLED = process.env.BINANCE_POSITION_MANAGER_ENABLED === 'true';
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
  Number(process.env.BINANCE_POSITION_TRAILING_TRIGGER_PCT || 0.12)
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
  0.01,
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

function resolveSourceProfile(position) {
  return String(position?.source_profile || position?.source || 'event_emitted').toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
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

  if (pnlPct > dynamicFloorPct) return null;

  return {
    close: true,
    reason: 'profit_capture_enforced',
    pnl_pct: pnlPct,
    opened_minutes: openedMinutes,
    opened_seconds: openedSeconds,
    max_hold_seconds: positionMaxHoldSeconds,
    source_profile: sourceProfile,
    profit_lock_floor_pct: dynamicFloorPct,
    max_seen_pct: maxSeenPct
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
      execution_audit: {
        win_exchange: payload?.win_exchange || 'UNKNOWN',
        closed_at: payload?.closed_at || nowIso(),
        close_reason: payload?.close_reason || null,
        close_pnl_pct: Number(payload?.close_pnl_pct || 0),
        close_price: Number(payload?.close_price || 0) || null,
        mark_price_at_close: Number(payload?.mark_price || 0) || null
      },
      updated_at: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

function shouldEarlyExit(position, config, markPrice) {
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

  if (
    staleExitEnabled &&
    openedSeconds >= staleGraceSeconds &&
    openedSeconds >= staleExitThresholdSeconds &&
    pnlPct <= staleExitMaxPnlPct &&
    negativeConfirmation
  ) {
    if (staleWarningCount + 1 < BINANCE_POSITION_STALE_CONFIRM_CYCLES) {
      return {
        close: false,
        reason: 'stale_watch',
        pnl_pct: pnlPct,
        opened_minutes: openedMinutes,
        opened_seconds: openedSeconds,
        max_hold_seconds: positionMaxHoldSeconds,
        source_profile: sourceProfile,
        stale_warning_count: staleWarningCount + 1
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
      stale_warning_count: staleWarningCount + 1
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

  if (openedSeconds >= positionMaxHoldSeconds) {
    const canPartialExit =
      partialExitCount < BINANCE_POSITION_PARTIAL_EXIT_MAX_COUNT &&
      pnlPct >= BINANCE_POSITION_MAX_HOLD_POSITIVE_FLOOR_PCT &&
      maxSeenPct >= BINANCE_POSITION_MAX_HOLD_MOMENTUM_PCT;
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

async function runBinancePositionManagerCycle(db) {
  if (!BINANCE_POSITION_MANAGER_ENABLED) {
    return { enabled: false, checked: 0, closed: 0, skipped: 0, failed: 0 };
  }

  const config = await getBinanceBotConfig(db);
  if (config.mode === 'off') {
    return { enabled: true, mode: 'off', checked: 0, closed: 0, skipped: 0, failed: 0 };
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

  for (const doc of openSnap.docs) {
    checked += 1;
    const position = doc.data() || {};
    try {
      const symbol = position.symbol;
      const qty = Number(position.quantity || 0);
      if (!symbol || !qty) {
        skipped += 1;
        continue;
      }

      const markPrice = await getMarkPrice(symbol);
      let decision = shouldEarlyExit(position, config, markPrice);
      const disciplineDecision = evaluatePositionDiscipline(position, markPrice, {
        pnl_pct: decision.pnl_pct,
        requested_reason: decision.reason
      });

      if (disciplineDecision.forceClose) {
        decision = {
          ...decision,
          close: true,
          reason: disciplineDecision.forceReason,
          pnl_pct: Number.isFinite(Number(disciplineDecision.details?.pnl_pct))
            ? Number(disciplineDecision.details.pnl_pct)
            : decision.pnl_pct
        };
      } else if (disciplineDecision.blockExit) {
        decision = {
          ...decision,
          close: false,
          reason: disciplineDecision.blockReason
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
          manager_last_check_at: nowIso(),
          updated_at: FieldValue.serverTimestamp()
        };
        if (Number.isFinite(Number(decision.stale_warning_count))) {
          updatePayload.stale_warning_count = Number(decision.stale_warning_count);
        } else if (decision.reason === 'hold') {
          updatePayload.stale_warning_count = 0;
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
        if (Number.isFinite(Number(decision.hold_extension_count))) {
          updatePayload.hold_extension_count = Number(decision.hold_extension_count);
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            extended_hold_seconds: Number(decision.max_hold_seconds || 0)
          };
        } else if (disciplineDecision.blockExit || disciplineDecision.armProfitCapture) {
          updatePayload.manager_decision = {
            close: false,
            reason: decision.reason,
            discipline: disciplineDecision.details
          };
        } else if (decision.reason === 'pre_max_hold_partial_take_profit') {
          updatePayload.manager_decision = {
            close: false,
            partial_close: true,
            reason: decision.reason,
            profit_lock_floor_pct: Number(decision.profit_lock_floor_pct || 0) || null
          };
        }
        if (decision.partial_close) {
          const partialQtyRaw = qty * Number(decision.partial_close_ratio || BINANCE_POSITION_PARTIAL_EXIT_RATIO);
          const partialQty = Number(partialQtyRaw.toFixed(6));
          if (partialQty > 0 && partialQty < qty) {
            let partialCloseOrder = null;
            let executedPartialQty = partialQty;
            if (config.mode !== 'dry-run') {
              partialCloseOrder = await closePositionMarket({
                symbol,
                side: position.side,
                quantity: partialQty
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
          manager_last_check_at: nowIso(),
          manager_decision: { close: true, reason: decision.reason, dry_run: true },
          updated_at: FieldValue.serverTimestamp()
        });
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
          quantity: qty
        });
      }

      const closePrice =
        Number(closeOrder?.avgPrice || 0) > 0
          ? Number(closeOrder.avgPrice)
          : Number(markPrice || 0) || null;
      const realizedPnlPct = Number(decision.pnl_pct.toFixed(4));

      await doc.ref.update({
        status: 'closed',
        closed_at: nowIso(),
        close_reason: decision.reason,
        win_exchange: resolveExchangeOutcome(realizedPnlPct),
        manager_last_check_at: nowIso(),
        mark_price: markPrice,
        close_price: closePrice,
        close_pnl_pct: realizedPnlPct,
        unrealized_pnl_pct: realizedPnlPct,
        opened_minutes: Number(decision.opened_minutes.toFixed(2)),
        opened_seconds: Number(decision.opened_seconds.toFixed(1)),
        position_max_hold_seconds: Number(decision.max_hold_seconds || 0),
        profit_capture_max_seen_pct: Number(resolveMaxSeenPct(position, decision.pnl_pct).toFixed(4)),
        min_seen_pct: Number(resolveMinSeenPct(position, decision.pnl_pct).toFixed(4)),
        close_order: closeOrder || { skipped: 'already_closed' },
        updated_at: FieldValue.serverTimestamp()
      });

      await logExecutionDiscipline(db, {
        type: 'exit_control',
        event: decision.reason,
        blocked: false,
        source_profile: resolveSourceProfile(position),
        symbol,
        prediction_id: position.prediction_id || null,
        details: {
          pnl_pct: realizedPnlPct,
          mark_price: markPrice,
          close_price: closePrice,
          max_hold_seconds: Number(decision.max_hold_seconds || 0),
          max_seen_pct: Number(resolveMaxSeenPct(position, decision.pnl_pct).toFixed(4)),
          min_seen_pct: Number(resolveMinSeenPct(position, decision.pnl_pct).toFixed(4)),
          mfe_drawdown_pct: Number(Number(decision.mfe_drawdown_pct || 0).toFixed(4)),
          profit_lock_floor_pct: Number(decision.profit_lock_floor_pct || 0) || null
        }
      });

      await updateExecutionIntentOutcome(db, position, {
        win_exchange: resolveExchangeOutcome(realizedPnlPct),
        closed_at: nowIso(),
        close_reason: decision.reason,
        close_pnl_pct: realizedPnlPct,
        close_price: closePrice,
        mark_price: markPrice
      });

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
    mode: config.mode,
    checked,
    closed,
    skipped,
    failed,
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



