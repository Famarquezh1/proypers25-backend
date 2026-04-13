const { pnlPctFor } = require('./impulseLifecycleEngine');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeMode(value, fallback = 'off') {
  const raw = String(value || fallback).toLowerCase();
  if (raw === 'observe') return 'observe';
  if (raw === 'enforce') return 'enforce';
  if (raw === 'true') return 'observe';
  return 'off';
}

function normalizeSymbols(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)
    : [];
}

function resolveAdaptiveExitConfig(botConfig = {}) {
  const adaptive = botConfig?.adaptive_exit || {};
  const lifecycle = botConfig?.impulse_lifecycle || {};
  const mode = normalizeMode(adaptive.mode || adaptive.enabled, 'off');
  const incubationMs = Math.max(
    60000,
    Number(adaptive.incubation_ms ?? lifecycle.incubation_ms ?? 90000)
  );
  const evaluationMs = Math.max(
    15000,
    Number(adaptive.evaluation_ms ?? lifecycle.evaluation_ms ?? 45000)
  );
  return {
    enabled: mode !== 'off',
    mode,
    scope: String(adaptive.scope || 'all').toLowerCase(),
    symbols: normalizeSymbols(adaptive.symbols),
    min_confidence: clamp(Number(adaptive.min_confidence || 0.9), 0, 1),
    min_profit_lock_pct: Math.max(0.02, Number(adaptive.min_profit_lock_pct || 0.12)),
    profit_lock_activation_multiplier: clamp(
      Number(adaptive.profit_lock_activation_multiplier || 1.35),
      1,
      3
    ),
    profit_lock_floor_ratio: clamp(Number(adaptive.profit_lock_floor_ratio || 0.55), 0.2, 0.95),
    no_ignition_ms: Math.max(
      incubationMs + evaluationMs,
      Number(adaptive.no_ignition_ms ?? lifecycle.no_ignition_ms ?? incubationMs + evaluationMs)
    ),
    no_ignition_min_negative_signals: Math.max(
      2,
      Number(adaptive.no_ignition_min_negative_signals ?? lifecycle.no_ignition_min_negative_signals ?? 3)
    ),
    no_ignition_velocity_ceiling_bps_per_sec: Math.max(
      0.5,
      Number(
        adaptive.no_ignition_velocity_ceiling_bps_per_sec ??
          lifecycle.no_ignition_velocity_ceiling_bps_per_sec ??
          2
      )
    ),
    no_ignition_required_stall_ratio: clamp(
      Number(adaptive.no_ignition_required_stall_ratio ?? lifecycle.no_ignition_required_stall_ratio ?? 0.75),
      0.3,
      1.5
    ),
    no_ignition_imbalance_ceiling: Number(
      adaptive.no_ignition_imbalance_ceiling ?? lifecycle.no_ignition_imbalance_ceiling ?? 0.05
    ),
    stall_ms: Math.max(5000, Number(adaptive.stall_ms ?? lifecycle.stall_ms ?? 25000)),
    stall_confirmation_negative_signals: Math.max(
      2,
      Number(adaptive.stall_confirmation_negative_signals || 3)
    ),
    stall_confirmation_window_ms: Math.max(
      5000,
      Number(adaptive.stall_confirmation_window_ms || 10000)
    ),
    stall_negative_velocity_bps_per_sec: Number(
      adaptive.stall_negative_velocity_bps_per_sec || -0.6
    ),
    stall_imbalance_ceiling: Number(adaptive.stall_imbalance_ceiling || -0.08),
    stall_pullback_pct: Math.max(0.02, Number(adaptive.stall_pullback_pct || 0.04)),
    stall_recent_high_loss_ms: Math.max(
      5000,
      Number(adaptive.stall_recent_high_loss_ms || 10000)
    ),
    stall_break_even_floor_pct: Math.max(
      0,
      Number(adaptive.stall_break_even_floor_pct || 0.01)
    ),
    stall_recovery_velocity_floor_bps_per_sec: Number(
      adaptive.stall_recovery_velocity_floor_bps_per_sec || -0.05
    ),
    stall_recovery_imbalance_floor: Number(adaptive.stall_recovery_imbalance_floor || -0.02),
    decay_threshold: clamp(Number(adaptive.decay_threshold ?? lifecycle.decay_threshold ?? 0.62), 0.1, 0.95),
    strong_deterioration_score: clamp(Number(adaptive.strong_deterioration_score || 0.78), 0.2, 0.99),
    strong_deterioration_negative_velocity_bps_per_sec: Number(
      adaptive.strong_deterioration_negative_velocity_bps_per_sec || -1
    ),
    strong_deterioration_negative_acceleration_bps_per_sec2: Number(
      adaptive.strong_deterioration_negative_acceleration_bps_per_sec2 || 0
    ),
    strong_deterioration_pullback_pct: Math.max(
      0.03,
      Number(adaptive.strong_deterioration_pullback_pct || 0.08)
    ),
    strong_deterioration_imbalance_ceiling: Number(
      adaptive.strong_deterioration_imbalance_ceiling || -0.05
    ),
    strong_deterioration_min_negative_signals: Math.max(
      2,
      Number(adaptive.strong_deterioration_min_negative_signals || 3)
    ),
    strong_deterioration_confirmation_window_ms: Math.max(
      5000,
      Number(adaptive.strong_deterioration_confirmation_window_ms || 10000)
    ),
    strong_deterioration_min_deterioration_ms: Math.max(
      5000,
      Number(adaptive.strong_deterioration_min_deterioration_ms || 8000)
    ),
    strong_deterioration_expansion_exception_loss_pct: Number(
      adaptive.strong_deterioration_expansion_exception_loss_pct || -0.12
    ),
    invalidation_loss_pct: Number(adaptive.invalidation_loss_pct || -0.85),
    profit_lock_min_negative_signals: Math.max(
      1,
      Number(adaptive.profit_lock_min_negative_signals || 2)
    ),
    profit_lock_min_decay_score: clamp(Number(adaptive.profit_lock_min_decay_score || 0.55), 0.1, 0.95),
    profit_lock_min_expansion_age_ms: Math.max(
      15000,
      Number(adaptive.profit_lock_min_expansion_age_ms || evaluationMs)
    ),
    trailing_retrace_ratio: clamp(Number(adaptive.trailing_retrace_ratio || 0.55), 0.2, 0.95),
    trailing_min_mfe_pct: Math.max(0.03, Number(adaptive.trailing_min_mfe_pct || 0.14)),
    enforce_source_profiles: normalizeSymbols(adaptive.enforce_source_profiles || adaptive.source_profiles)
  };
}

function isPositionInScope(position = {}, config) {
  if (!config?.enabled) return false;
  const sourceProfile = String(position?.source_profile || position?.source || 'unknown').toLowerCase();
  const symbol = String(position?.symbol || '').toUpperCase();
  if (Array.isArray(config.symbols) && config.symbols.length > 0 && !config.symbols.includes(symbol)) {
    return false;
  }
  if (config.scope === 'all') return true;
  if (config.scope === 'high_conviction') return sourceProfile === 'high_conviction';
  if (config.scope === 'event_emitted') return sourceProfile === 'event_emitted';
  if (config.scope === 'manual_prealert') return sourceProfile === 'manual_prealert';
  return true;
}

function resolvePositionConfidence(position = {}) {
  const candidates = [
    Number(position?.confidence),
    Number(position?.execution_audit?.confidence),
    Number(position?.signal_confidence)
  ];
  return candidates.find((value) => Number.isFinite(value)) ?? 1;
}

function toFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildReasonEvaluation(reason, priority, eligible, score, details = {}) {
  return {
    reason,
    priority,
    eligible: Boolean(eligible),
    score: Number(clamp(Number(score || 0), 0, 1).toFixed(3)),
    details
  };
}

function buildExitDecision(evaluation, price, pnlPct, context = {}) {
  return {
    should_exit: true,
    exit_reason: evaluation.reason,
    exit_priority: evaluation.priority,
    exit_confidence: Number(evaluation.score.toFixed(3)),
    recommended_action: 'close_market',
    shadow_exit_price: Number(price.toFixed(8)),
    shadow_exit_pnl_pct: Number(pnlPct.toFixed(4)),
    decision_flow: context.decision_flow || null,
    evaluated_reasons: context.evaluated_reasons || [],
    discarded_reasons: context.discarded_reasons || [],
    confirmation_window: context.confirmation_window || null,
    log_events: context.log_events || [],
    lifecycle_phase: context.lifecycle_phase || null,
    lifecycle_state_reason: context.lifecycle_state_reason || null,
    details: {
      ...evaluation.details,
      source_profile: context.source_profile || 'unknown',
      symbol: context.symbol || 'UNKNOWN',
      positive_signal_count: context.positive_signal_count ?? null,
      negative_signal_count: context.negative_signal_count ?? null
    }
  };
}

function buildHoldDecision(currentPrice, pnlPct, context = {}) {
  return {
    should_exit: false,
    exit_priority: 0,
    exit_reason: 'hold',
    exit_confidence: 0,
    recommended_action: 'hold',
    shadow_exit_price: Number.isFinite(currentPrice) ? Number(currentPrice.toFixed(8)) : null,
    shadow_exit_pnl_pct: Number.isFinite(pnlPct) ? Number(pnlPct.toFixed(4)) : null,
    scope: context.scope,
    lifecycle_phase: context.lifecycle_phase || null,
    lifecycle_state_reason: context.lifecycle_state_reason || null,
    decision_flow: context.decision_flow || null,
    evaluated_reasons: context.evaluated_reasons || [],
    discarded_reasons: context.discarded_reasons || [],
    confirmation_window: context.confirmation_window || null,
    log_events: context.log_events || []
  };
}

function resolveDynamicProfitLockFloor(maxSeenPct, pullbackFromPeakPct, decayScore, config) {
  const healthFactor = clamp(1 - decayScore, 0, 1);
  const dynamicShare = 0.35 + healthFactor * 0.2;
  const softFloor = maxSeenPct * dynamicShare;
  const retraceAdjustedFloor = maxSeenPct - pullbackFromPeakPct * config.profit_lock_floor_ratio;
  return Math.max(config.min_profit_lock_pct * 0.7, softFloor, retraceAdjustedFloor);
}

function buildDecisionFlow(lifecyclePhase, selectedReason, evaluations) {
  return {
    lifecycle_phase: lifecyclePhase,
    selected_reason: selectedReason || 'hold',
    priorities: evaluations.map((item) => ({
      reason: item.reason,
      priority: item.priority,
      eligible: item.eligible,
      score: item.score
    }))
  };
}

function buildAdaptiveLogEvent(tag, payload = {}) {
  return {
    tag,
    payload
  };
}

function createConfirmationWindow(reason) {
  return {
    reason,
    active: false,
    status: 'idle',
    started_at: null,
    expires_at: null,
    confirmed_at: null,
    last_result: null
  };
}

function restoreConfirmationWindow(previous, reason) {
  if (previous && previous.reason === reason) {
    return { ...previous };
  }
  return createConfirmationWindow(reason);
}

function resolveConfirmationStartedAtMs(window) {
  if (!window?.started_at) return null;
  const startedAtMs = new Date(window.started_at).getTime();
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function buildRecoverySignal({
  positiveSignalCount,
  negativeSignalCount,
  structuralImprovement,
  newPositiveExtreme,
  velocity,
  imbalance,
  config
}) {
  return (
    newPositiveExtreme ||
    structuralImprovement ||
    positiveSignalCount >= negativeSignalCount ||
    velocity >= config.stall_recovery_velocity_floor_bps_per_sec ||
    imbalance >= config.stall_recovery_imbalance_floor
  );
}

function hasMeaningfulConfirmationWindow(window) {
  return Boolean(
    window &&
      (
        window.active ||
        window.started_at ||
        window.confirmed_at ||
        ['cancelled', 'confirmed', 'blocked_expansion'].includes(String(window.status || ''))
      )
  );
}

function evaluateExit(position = {}, lifecycle = {}, marketSnapshot = null, options = {}) {
  const config = resolveAdaptiveExitConfig(options.botConfig);
  const sourceProfile = String(position?.source_profile || position?.source || 'unknown').toLowerCase();
  const symbol = String(position?.symbol || '').toUpperCase();
  const currentPrice = Number(
    options.markPrice || marketSnapshot?.last_price || marketSnapshot?.bid || marketSnapshot?.ask || position?.mark_price || position?.entry_price
  );
  const pnlPct = pnlPctFor(position?.side, position?.entry_price, currentPrice);
  const maxSeenPct = Math.max(
    Number(position?.profit_capture_max_seen_pct || Number.NEGATIVE_INFINITY),
    Number(lifecycle?.max_pnl_pct || Number.NEGATIVE_INFINITY),
    pnlPct
  );
  const pullbackFromPeakPct = Math.max(
    Number(lifecycle?.pullback_from_peak_pct || 0),
    Math.max(0, maxSeenPct - pnlPct)
  );
  const elapsedMs = Math.max(0, Date.now() - new Date(position?.opened_at || Date.now()).getTime());
  const inScope = isPositionInScope(position, config);
  const positionConfidence = resolvePositionConfidence(position);
  const lifecyclePhase = String(lifecycle?.impulse_state || lifecycle?.lifecycle_phase || 'evaluation');
  const lifecycleReason = String(lifecycle?.impulse_state_reason || 'unknown');
  const decayScore = Number(lifecycle?.momentum_decay_score || 0);
  const stallDurationMs = Number(lifecycle?.stall_duration_ms || 0);
  const positiveSignalCount = Number(lifecycle?.positive_signal_count || 0);
  const negativeSignalCount = Number(lifecycle?.negative_signal_count || 0);
  const expansionConfirmed = Boolean(lifecycle?.expansion_confirmed);
  const structuralImprovement = Boolean(lifecycle?.structural_improvement);
  const newExtremeCount = Number(lifecycle?.new_extreme_count || 0);
  const msSinceFirstExpansion = Number(lifecycle?.ms_since_first_expansion || 0);
  const velocity = toFinite(marketSnapshot?.price_velocity_bps_per_sec, 0);
  const acceleration = toFinite(marketSnapshot?.price_acceleration_bps_per_sec2, 0);
  const imbalance = toFinite(marketSnapshot?.trade_flow_imbalance, 0);
  const latestNewExtremeAt = lifecycle?.latest_new_extreme_at
    ? new Date(lifecycle.latest_new_extreme_at)
    : null;
  const msSinceLatestNewExtreme =
    latestNewExtremeAt && Number.isFinite(latestNewExtremeAt.getTime())
      ? Math.max(0, Date.now() - latestNewExtremeAt.getTime())
      : Number.POSITIVE_INFINITY;
  const previousConfirmation = position?.adaptive_exit_shadow?.confirmation_window || null;
  const logEvents = [];

  const scope = {
    enabled: config.enabled,
    mode: config.mode,
    in_scope: inScope,
    source_profile: sourceProfile,
    symbol,
    confidence: positionConfidence
  };

  if (!config.enabled || !inScope || positionConfidence < config.min_confidence) {
    return buildHoldDecision(currentPrice, pnlPct, {
      scope,
      lifecycle_phase: lifecyclePhase,
      lifecycle_state_reason: lifecycleReason,
      confirmation_window: previousConfirmation,
      log_events: logEvents,
      decision_flow: buildDecisionFlow(lifecyclePhase, 'hold', []),
      evaluated_reasons: [],
      discarded_reasons: []
    });
  }

  const evaluated = [];

  const invalidationEligible = pnlPct <= config.invalidation_loss_pct;
  evaluated.push(
    buildReasonEvaluation(
      'invalidation',
      100,
      invalidationEligible,
      invalidationEligible ? Math.min(1, Math.abs(pnlPct / Math.abs(config.invalidation_loss_pct || -1))) : 0,
      {
        invalidation_loss_pct: config.invalidation_loss_pct,
        pnl_pct: Number(pnlPct.toFixed(4))
      }
    )
  );

  const strongDeteriorationConditions = {
    velocity_negative_sustained: velocity <= config.strong_deterioration_negative_velocity_bps_per_sec,
    acceleration_negative: acceleration <= config.strong_deterioration_negative_acceleration_bps_per_sec2,
    pullback_significant:
      pullbackFromPeakPct >= Math.max(
        config.strong_deterioration_pullback_pct,
        Number(position?.profit_capture_retrace_threshold_pct || 0)
      ),
    imbalance_deteriorated: imbalance <= config.strong_deterioration_imbalance_ceiling,
    no_recent_new_highs: msSinceLatestNewExtreme >= config.strong_deterioration_min_deterioration_ms,
    negative_signals_confirmed: negativeSignalCount >= config.strong_deterioration_min_negative_signals
  };
  const strongDeteriorationBaseCandidate = Object.values(strongDeteriorationConditions).every(Boolean);
  let confirmationWindow = restoreConfirmationWindow(previousConfirmation, 'strong_deterioration');

  if (strongDeteriorationBaseCandidate) {
    if (!confirmationWindow.active || !confirmationWindow.started_at) {
      const startedAt = new Date().toISOString();
      confirmationWindow = {
        reason: 'strong_deterioration',
        active: true,
        status: 'pending',
        started_at: startedAt,
        expires_at: new Date(Date.now() + config.strong_deterioration_confirmation_window_ms).toISOString(),
        confirmed_at: null,
        last_result: 'pending'
      };
      logEvents.push(
        buildAdaptiveLogEvent('DETERIORATION_CONFIRMATION_WINDOW', {
          status: 'started',
          lifecycle_state: lifecyclePhase,
          symbol,
          window_ms: config.strong_deterioration_confirmation_window_ms
        })
      );
    }
  } else if (confirmationWindow.active) {
    confirmationWindow = {
      ...confirmationWindow,
      active: false,
      status: 'cancelled',
      last_result: 'cancelled'
    };
    logEvents.push(
      buildAdaptiveLogEvent('DETERIORATION_CONFIRMATION_WINDOW', {
        status: 'cancelled',
        lifecycle_state: lifecyclePhase,
        symbol
      })
    );
  }

  const confirmationStartedAt = resolveConfirmationStartedAtMs(confirmationWindow);
  const confirmationElapsedMs =
    confirmationStartedAt != null ? Math.max(0, Date.now() - confirmationStartedAt) : 0;
  const confirmationSatisfied =
    strongDeteriorationBaseCandidate &&
    confirmationStartedAt != null &&
    confirmationElapsedMs >= config.strong_deterioration_confirmation_window_ms;

  if (confirmationSatisfied && confirmationWindow.status !== 'confirmed') {
    confirmationWindow = {
      ...confirmationWindow,
      active: false,
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      last_result: 'confirmed'
    };
    logEvents.push(
      buildAdaptiveLogEvent('DETERIORATION_CONFIRMATION_WINDOW', {
        status: 'confirmed',
        lifecycle_state: lifecyclePhase,
        symbol,
        elapsed_ms: confirmationElapsedMs
      })
    );
  }

  const expansionBlockedStrongDeterioration =
    lifecyclePhase === 'expansion' &&
    (pnlPct > config.strong_deterioration_expansion_exception_loss_pct || !confirmationSatisfied);
  const strongDeteriorationEligible =
    confirmationSatisfied &&
    (
      lifecyclePhase === 'deterioration' ||
      (
        lifecyclePhase === 'expansion' &&
        pnlPct <= config.strong_deterioration_expansion_exception_loss_pct
      )
    ) &&
    !expansionBlockedStrongDeterioration;

  const expansionBlockedReason =
    pnlPct > config.strong_deterioration_expansion_exception_loss_pct
      ? 'expansion_profit_protection'
      : 'confirmation_window_pending';

  if (strongDeteriorationBaseCandidate && expansionBlockedStrongDeterioration) {
    confirmationWindow = {
      ...confirmationWindow,
      active: !confirmationSatisfied,
      status: 'blocked_expansion',
      last_result: expansionBlockedReason
    };
  }

  if (
    strongDeteriorationBaseCandidate &&
    expansionBlockedStrongDeterioration &&
    (
      previousConfirmation?.status !== 'blocked_expansion' ||
      previousConfirmation?.last_result !== expansionBlockedReason
    )
  ) {
    logEvents.push(
      buildAdaptiveLogEvent('STRONG_DETERIORATION_BLOCKED', {
        lifecycle_state: lifecyclePhase,
        symbol,
        pnl_pct: Number(pnlPct.toFixed(4)),
        confirmation_satisfied: confirmationSatisfied,
        reason: expansionBlockedReason
      })
    );
  }

  if (strongDeteriorationEligible) {
    logEvents.push(
      buildAdaptiveLogEvent('STRONG_DETERIORATION_CONFIRMED', {
        lifecycle_state: lifecyclePhase,
        symbol,
        elapsed_ms: confirmationElapsedMs,
        pnl_pct: Number(pnlPct.toFixed(4))
      })
    );
  }
  evaluated.push(
    buildReasonEvaluation(
      'strong_deterioration',
      90,
      strongDeteriorationEligible,
      strongDeteriorationEligible
        ? clamp(
            Math.max(
              decayScore,
              pullbackFromPeakPct / Math.max(config.trailing_min_mfe_pct, 0.01),
              negativeSignalCount / 5
            ),
            0,
            1
          )
        : 0,
      {
        momentum_decay_score: Number(decayScore.toFixed(4)),
        pullback_from_peak_pct: Number(pullbackFromPeakPct.toFixed(4)),
        negative_signal_count: negativeSignalCount,
        confirmation_window_ms: config.strong_deterioration_confirmation_window_ms,
        confirmation_elapsed_ms: confirmationElapsedMs,
        confirmation_satisfied: confirmationSatisfied,
        velocity,
        acceleration,
        imbalance,
        ms_since_latest_new_extreme: Number.isFinite(msSinceLatestNewExtreme)
          ? msSinceLatestNewExtreme
          : null
      }
    )
  );

  let stallConfirmationWindow = restoreConfirmationWindow(previousConfirmation, 'stall');
  const stallDetected =
    stallDurationMs >= config.stall_ms &&
    negativeSignalCount >= config.stall_confirmation_negative_signals;
  const stallRecoverySignal = buildRecoverySignal({
    positiveSignalCount,
    negativeSignalCount,
    structuralImprovement,
    newPositiveExtreme: Boolean(lifecycle?.new_positive_extreme),
    velocity,
    imbalance,
    config
  });
  const stallProfitProtected = maxSeenPct <= 0 || pnlPct >= config.stall_break_even_floor_pct;
  const stallConfirmationConditions = {
    lifecycle_deterioration: lifecyclePhase === 'deterioration',
    sustained_stall: stallDetected,
    recent_highs_lost:
      msSinceLatestNewExtreme >= config.stall_recent_high_loss_ms &&
      pullbackFromPeakPct >= config.stall_pullback_pct,
    velocity_negative_sustained: velocity <= config.stall_negative_velocity_bps_per_sec,
    imbalance_deteriorated: imbalance <= config.stall_imbalance_ceiling,
    no_recovery_signal: !stallRecoverySignal,
    profit_protected: stallProfitProtected
  };
  const stallBaseCandidate = Object.values(stallConfirmationConditions).every(Boolean);

  if (lifecyclePhase === 'expansion' && stallDetected) {
    stallConfirmationWindow = {
      ...stallConfirmationWindow,
      active: false,
      status: 'blocked_expansion',
      last_result: 'expansion_phase_guard'
    };
    if (
      previousConfirmation?.reason !== 'stall' ||
      previousConfirmation?.status !== 'blocked_expansion' ||
      previousConfirmation?.last_result !== 'expansion_phase_guard'
    ) {
      logEvents.push(
        buildAdaptiveLogEvent('STALL_BLOCKED_EXPANSION', {
          lifecycle_state: lifecyclePhase,
          symbol,
          stall_duration_ms: stallDurationMs,
          negative_signal_count: negativeSignalCount
        })
      );
    }
  } else if (stallDetected) {
    if (
      previousConfirmation?.reason !== 'stall' ||
      previousConfirmation?.status !== 'pending'
    ) {
      logEvents.push(
        buildAdaptiveLogEvent('STALL_DETECTED', {
          lifecycle_state: lifecyclePhase,
          symbol,
          stall_duration_ms: stallDurationMs,
          negative_signal_count: negativeSignalCount
        })
      );
    }

    if (!stallConfirmationWindow.active || !stallConfirmationWindow.started_at) {
      const startedAt = new Date().toISOString();
      stallConfirmationWindow = {
        reason: 'stall',
        active: true,
        status: 'pending',
        started_at: startedAt,
        expires_at: new Date(Date.now() + config.stall_confirmation_window_ms).toISOString(),
        confirmed_at: null,
        last_result: 'pending'
      };
      logEvents.push(
        buildAdaptiveLogEvent('STALL_CONFIRMATION_STARTED', {
          lifecycle_state: lifecyclePhase,
          symbol,
          window_ms: config.stall_confirmation_window_ms
        })
      );
    } else if (!stallBaseCandidate) {
      const failureResult = stallRecoverySignal ? 'recovered_or_stable' : 'conditions_reverted';
      stallConfirmationWindow = {
        ...stallConfirmationWindow,
        active: false,
        status: 'cancelled',
        last_result: failureResult
      };
      logEvents.push(
        buildAdaptiveLogEvent('STALL_CONFIRMATION_FAILED', {
          lifecycle_state: lifecyclePhase,
          symbol,
          result: failureResult,
          velocity,
          imbalance,
          pnl_pct: Number(pnlPct.toFixed(4))
        })
      );
    }
  } else if (stallConfirmationWindow.active) {
    stallConfirmationWindow = {
      ...stallConfirmationWindow,
      active: false,
      status: 'cancelled',
      last_result: 'conditions_reverted'
    };
    logEvents.push(
      buildAdaptiveLogEvent('STALL_CONFIRMATION_FAILED', {
        lifecycle_state: lifecyclePhase,
        symbol,
        result: 'conditions_reverted'
      })
    );
  }

  const stallConfirmationStartedAt = resolveConfirmationStartedAtMs(stallConfirmationWindow);
  const stallConfirmationElapsedMs =
    stallConfirmationStartedAt != null ? Math.max(0, Date.now() - stallConfirmationStartedAt) : 0;
  const stallConfirmationSatisfied =
    stallBaseCandidate &&
    stallConfirmationStartedAt != null &&
    stallConfirmationElapsedMs >= config.stall_confirmation_window_ms;

  if (stallConfirmationSatisfied && stallConfirmationWindow.status !== 'confirmed') {
    stallConfirmationWindow = {
      ...stallConfirmationWindow,
      active: false,
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      last_result: 'confirmed'
    };
    logEvents.push(
      buildAdaptiveLogEvent('STALL_EXIT_CONFIRMED', {
        lifecycle_state: lifecyclePhase,
        symbol,
        elapsed_ms: stallConfirmationElapsedMs,
        pnl_pct: Number(pnlPct.toFixed(4))
      })
    );
  }

  const stallEligible =
    lifecyclePhase === 'deterioration' &&
    stallConfirmationSatisfied &&
    stallProfitProtected;
  evaluated.push(
    buildReasonEvaluation(
      'stall',
      50,
      stallEligible,
      stallEligible
        ? clamp(
            Math.max(
              stallDurationMs / Math.max(config.stall_ms, 1),
              negativeSignalCount / 5,
              pullbackFromPeakPct / Math.max(config.stall_pullback_pct, 0.01)
            ),
            0,
            1
          )
        : 0,
      {
        stall_duration_ms: stallDurationMs,
        negative_signal_count: negativeSignalCount,
        confirmation_window_ms: config.stall_confirmation_window_ms,
        confirmation_elapsed_ms: stallConfirmationElapsedMs,
        confirmation_satisfied: stallConfirmationSatisfied,
        velocity,
        imbalance,
        pullback_from_peak_pct: Number(pullbackFromPeakPct.toFixed(4)),
        ms_since_latest_new_extreme: Number.isFinite(msSinceLatestNewExtreme)
          ? msSinceLatestNewExtreme
          : null,
        profit_protected: stallProfitProtected
      }
    )
  );

  const dynamicActivationPct = Math.max(
    config.min_profit_lock_pct * config.profit_lock_activation_multiplier,
    expansionConfirmed ? config.min_profit_lock_pct * 1.4 : config.min_profit_lock_pct * 1.8,
    config.trailing_min_mfe_pct * 1.1
  );
  const dynamicProfitLockFloorPct = resolveDynamicProfitLockFloor(
    maxSeenPct,
    pullbackFromPeakPct,
    decayScore,
    config
  );
  const dynamicProfitLockEligible =
    lifecyclePhase === 'deterioration' &&
    expansionConfirmed &&
    maxSeenPct >= dynamicActivationPct &&
    pnlPct > 0 &&
    pnlPct <= dynamicProfitLockFloorPct &&
    pullbackFromPeakPct >= Math.max(0.04, maxSeenPct * 0.28) &&
    negativeSignalCount >= config.profit_lock_min_negative_signals &&
    decayScore >= config.profit_lock_min_decay_score &&
    msSinceFirstExpansion >= config.profit_lock_min_expansion_age_ms;
  evaluated.push(
    buildReasonEvaluation(
      'profit_lock',
      60,
      dynamicProfitLockEligible,
      dynamicProfitLockEligible
        ? clamp(
            Math.max(
              maxSeenPct / Math.max(dynamicActivationPct, 0.01) - 1,
              pullbackFromPeakPct / Math.max(dynamicProfitLockFloorPct, 0.01)
            ),
            0,
            1
          )
        : 0,
      {
        max_seen_pct: Number(maxSeenPct.toFixed(4)),
        activation_pct: Number(dynamicActivationPct.toFixed(4)),
        profit_lock_floor_pct: Number(dynamicProfitLockFloorPct.toFixed(4)),
        pullback_from_peak_pct: Number(pullbackFromPeakPct.toFixed(4))
      }
    )
  );

  const dynamicTrailingThreshold = Math.max(
    0.03,
    maxSeenPct * config.trailing_retrace_ratio * (decayScore >= config.decay_threshold ? 0.85 : 1)
  );
  const trailingEligible =
    ['expansion', 'deterioration'].includes(lifecyclePhase) &&
    expansionConfirmed &&
    maxSeenPct >= config.trailing_min_mfe_pct &&
    pnlPct > 0 &&
    pullbackFromPeakPct >= dynamicTrailingThreshold &&
    (
      lifecyclePhase === 'expansion'
        ? (
            msSinceFirstExpansion >= config.profit_lock_min_expansion_age_ms &&
            velocity <= 0 &&
            imbalance <= 0 &&
            negativeSignalCount >= config.profit_lock_min_negative_signals
          )
        : (
            decayScore >= config.profit_lock_min_decay_score ||
            negativeSignalCount >= config.profit_lock_min_negative_signals
          )
    );
  evaluated.push(
    buildReasonEvaluation(
      'trailing_exit',
      70,
      trailingEligible,
      trailingEligible
        ? clamp(
            Math.max(
              pullbackFromPeakPct / Math.max(dynamicTrailingThreshold, 0.01),
              maxSeenPct / Math.max(config.trailing_min_mfe_pct, 0.01) - 1
            ),
            0,
            1
          )
        : 0,
      {
        max_seen_pct: Number(maxSeenPct.toFixed(4)),
        pullback_from_peak_pct: Number(pullbackFromPeakPct.toFixed(4)),
        trailing_threshold_pct: Number(dynamicTrailingThreshold.toFixed(4))
      }
    )
  );

  const prolongedNoIgnitionEligible =
    lifecyclePhase === 'evaluation' &&
    lifecycleReason === 'no_ignition_accumulated' &&
    elapsedMs >= config.no_ignition_ms &&
    negativeSignalCount >= config.no_ignition_min_negative_signals + 1 &&
    positiveSignalCount <= 0 &&
    !structuralImprovement &&
    newExtremeCount < 1 &&
    Math.abs(velocity) <= config.no_ignition_velocity_ceiling_bps_per_sec &&
    imbalance <= config.no_ignition_imbalance_ceiling &&
    stallDurationMs >= config.stall_ms * config.no_ignition_required_stall_ratio;
  evaluated.push(
    buildReasonEvaluation(
      'no_ignition',
      20,
      prolongedNoIgnitionEligible,
      prolongedNoIgnitionEligible
        ? clamp(
            Math.max(
              negativeSignalCount / Math.max(config.no_ignition_min_negative_signals, 1),
              elapsedMs / Math.max(config.no_ignition_ms, 1)
            ),
            0,
            1
          )
        : 0,
      {
        no_ignition_ms: config.no_ignition_ms,
        elapsed_ms: elapsedMs,
        negative_signal_count: negativeSignalCount,
        structural_improvement: structuralImprovement,
        velocity,
        imbalance
      }
    )
  );

  const maxHoldSeconds = Number(position?.position_max_hold_seconds || 0);
  const fallbackMaxHoldEligible = maxHoldSeconds > 0 && elapsedMs >= maxHoldSeconds * 1000;
  evaluated.push(
    buildReasonEvaluation(
      'fallback_max_hold',
      10,
      fallbackMaxHoldEligible,
      fallbackMaxHoldEligible ? 0.5 : 0,
      {
        max_hold_seconds: maxHoldSeconds
      }
    )
  );

  const selected = evaluated
    .filter((item) => item.eligible)
    .sort((a, b) => (b.priority - a.priority) || (b.score - a.score))[0];
  const effectiveConfirmationWindow = hasMeaningfulConfirmationWindow(confirmationWindow)
    ? confirmationWindow
    : hasMeaningfulConfirmationWindow(stallConfirmationWindow)
      ? stallConfirmationWindow
      : previousConfirmation;

  const decisionFlow = buildDecisionFlow(lifecyclePhase, selected?.reason || 'hold', evaluated);
  const discardedReasons = evaluated.filter((item) => !item.eligible);

  if (!selected) {
    return buildHoldDecision(currentPrice, pnlPct, {
      scope,
      lifecycle_phase: lifecyclePhase,
      lifecycle_state_reason: lifecycleReason,
      confirmation_window: effectiveConfirmationWindow,
      log_events: logEvents,
      decision_flow: decisionFlow,
      evaluated_reasons: evaluated,
      discarded_reasons: discardedReasons
    });
  }

  if (lifecyclePhase === 'incubation' && selected.reason !== 'invalidation') {
    return buildHoldDecision(currentPrice, pnlPct, {
      scope,
      lifecycle_phase: lifecyclePhase,
      lifecycle_state_reason: lifecycleReason,
      confirmation_window: effectiveConfirmationWindow,
      log_events: logEvents,
      decision_flow: decisionFlow,
      evaluated_reasons: evaluated,
      discarded_reasons: discardedReasons
    });
  }

  if (
    lifecyclePhase === 'expansion' &&
    !['invalidation', 'profit_lock', 'trailing_exit'].includes(selected.reason)
  ) {
    return buildHoldDecision(currentPrice, pnlPct, {
      scope,
      lifecycle_phase: lifecyclePhase,
      lifecycle_state_reason: lifecycleReason,
      confirmation_window: effectiveConfirmationWindow,
      log_events: logEvents,
      decision_flow: decisionFlow,
      evaluated_reasons: evaluated,
      discarded_reasons: discardedReasons
    });
  }

  return {
    ...buildExitDecision(selected, currentPrice, pnlPct, {
      source_profile: sourceProfile,
      symbol,
      positive_signal_count: positiveSignalCount,
      negative_signal_count: negativeSignalCount,
      lifecycle_phase: lifecyclePhase,
      lifecycle_state_reason: lifecycleReason,
      confirmation_window: effectiveConfirmationWindow,
      log_events: logEvents,
      evaluated_reasons: evaluated,
      discarded_reasons: discardedReasons,
      decision_flow: decisionFlow
    }),
    scope
  };
}

function evaluateAdaptiveExit(position = {}, marketSnapshot = null, lifecycle = {}, options = {}) {
  return evaluateExit(position, lifecycle, marketSnapshot, options);
}

module.exports = {
  resolveAdaptiveExitConfig,
  evaluateExit,
  evaluateAdaptiveExit
};
