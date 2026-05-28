function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date?.getTime?.()) ? date : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(0.1, Number(options.hours || 1));
  const windowMs = sinceExplicit
    ? Math.max(1, until.getTime() - sinceExplicit.getTime())
    : options.days
      ? days * 24 * 60 * 60 * 1000
      : hours * 60 * 60 * 1000;

  return {
    since: sinceExplicit || new Date(until.getTime() - windowMs),
    until
  };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function resolveSignalAt(row = {}) {
  return (
    parseDateLike(row.execution_audit?.signal_at) ||
    parseDateLike(row.execution_trace?.signal_emitted_at) ||
    parseDateLike(row.signal_at)
  );
}

function resolveIntentCreatedAt(row = {}) {
  return (
    parseDateLike(row.created_at) ||
    parseDateLike(row.execution_trace?.intent_created_at) ||
    parseDateLike(row.execution_trace?.intent_queued_at)
  );
}

function resolveExecutionAttemptAt(row = {}) {
  return (
    parseDateLike(row.execution_started_at) ||
    parseDateLike(row.execution_attempt_at) ||
    parseDateLike(row.execution_attempted_at) ||
    parseDateLike(row.execution_trace?.execution_attempt_at) ||
    parseDateLike(row.last_attempt?.attempted_at) ||
    parseDateLike(row.time_aligned_execution?.attempt_history?.slice?.(-1)?.[0]?.attempted_at) ||
    parseDateLike(row.attempt_history?.slice?.(-1)?.[0]?.attempted_at)
  );
}

function resolveUpdatedAt(row = {}) {
  return parseDateLike(row.updated_at) || parseDateLike(row.execution_trace?.intent_processed_at);
}

function resolveLastAttemptStage(row = {}) {
  const attemptHistory = row.time_aligned_execution?.attempt_history || row.attempt_history || [];
  const lastAttempt = attemptHistory[attemptHistory.length - 1] || null;
  return (
    lastAttempt?.stage ||
    lastAttempt?.validation_reason ||
    row.processing_stage ||
    row.execution_trace?.processing_stage ||
    null
  );
}

function resolveErrorMessage(row = {}) {
  return String(
    row.last_error_message ||
    row.error_message ||
    row.execution_error ||
    row.validation?.error_message ||
    row.execution_discipline?.error_message ||
    ''
  ).trim() || null;
}

function extractReasonCandidates(row = {}) {
  const attemptHistory = row.time_aligned_execution?.attempt_history || row.attempt_history || [];
  const lastAttempt = attemptHistory[attemptHistory.length - 1] || {};
  return [
    row.reason,
    row.final_reason,
    row.skip_reason,
    row.fail_reason,
    row.last_block_reason,
    row.execution_guard?.reason,
    row.final_evaluation?.reason,
    lastAttempt?.reason,
    lastAttempt?.validation_reason,
    row.last_attempt?.reason,
    row.last_attempt?.validation_reason,
    row.validation?.reason,
    row.execution_discipline?.reason,
    row.last_error_message,
    row.error_message,
    row.execution_error,
    resolveLastAttemptStage(row)
  ].filter((value) => String(value || '').trim().length > 0);
}

function mapKnownExecutionReason(value) {
  const message = String(value || '').trim().toLowerCase();
  if (!message) return 'unknown';
  if (message.includes('entry_quality')) return 'entry_quality_low';
  if (message.includes('execution_score')) return 'execution_score_low';
  if (message.includes('execution_guard') || message.includes('guard')) return 'execution_guard_blocked';
  if (message.includes('price') || message.includes('deviation')) return 'price_movement_blocked';
  if (message.includes('stop_loss_required')) return 'stop_loss_required';
  if (message.includes('take_profit_required')) return 'take_profit_required';
  if (message.includes('trade_plan_invalid')) return 'trade_plan_invalid';
  if (message.includes('side_missing')) return 'trade_plan_invalid';
  if (message.includes('entry_price_invalid')) return 'trade_plan_invalid';
  if (message.includes('intent_expired') || message.includes('expired')) return 'intent_expired';
  if (message.includes('late_entry_blocked') || message.includes('late_entry')) return 'late_entry_blocked';
  if (message.includes('risk_reward_low')) return 'risk_reward_low';
  if (message.includes('event_quality_gate')) return 'event_quality_gate';
  if (message.includes('confidence_low')) return 'confidence_low';
  if (message.includes('max_concurrent_trades_reached')) return 'max_concurrent_trades_reached';
  if (message.includes('hard_stop_consecutive_losses_limit')) return 'hard_stop_consecutive_losses_limit';
  if (message.includes('margin_leverage_not_ready') || message.includes('margin_leverage_preflight')) {
    return 'margin_leverage_not_ready';
  }
  if (message.includes('margin_leverage_setup_failed')) return 'margin_leverage_setup_failed';
  if (message.includes('min_notional_risk_blocked')) return 'min_notional_risk_blocked';
  if (message.includes('orphan_intent_blocked') || message.includes('orphan')) return 'orphan_intent_blocked';
  if (message.includes('exchange_info') && (message.includes('timeout') || message.includes('failed'))) return 'exchange_info_timeout';
  if (message.includes('order rejected') || message.includes('order_rejected') || message.includes('binance_order_rejected')) return 'binance_order_rejected';
  if (message.includes('insufficient_balance') || message.includes('insufficient margin') || message.includes('insufficient')) return 'insufficient_balance';
  if (message.includes('min_notional')) return 'min_notional_failed';
  if (message.includes('quantity_invalid') || message.includes('invalid quantity') || message.includes('precision')) return 'quantity_invalid';
  if (message.includes('symbol_rules_missing') || message.includes('rules missing')) return 'symbol_rules_missing';
  if (message.includes('timeout') || message.includes('watchdog threshold')) return 'failed_timeout';
  if (message.includes('binance') || message.includes('api') || message.includes('request')) return 'binance_api_error';
  return 'unknown';
}

function logUnknownExecutionReason(row = {}) {
  if (row.__unknown_execution_reason_logged) return;
  row.__unknown_execution_reason_logged = true;
  const attemptHistory = row.time_aligned_execution?.attempt_history || row.attempt_history || [];
  const lastAttempt = attemptHistory[attemptHistory.length - 1] || row.last_attempt || null;
  console.warn('[UNKNOWN_EXECUTION_REASON]', {
    intent_id: row.id || null,
    symbol: row.intent?.symbol || row.symbol || null,
    status: row.status || null,
    reason_fields: {
      reason: row.reason || null,
      final_reason: row.final_reason || null,
      skip_reason: row.skip_reason || null,
      fail_reason: row.fail_reason || null,
      last_block_reason: row.last_block_reason || null,
      execution_guard_reason: row.execution_guard?.reason || null,
      final_evaluation_reason: row.final_evaluation?.reason || null
    },
    last_attempt: lastAttempt || null,
    last_error_message: resolveErrorMessage(row)
  });
}

function resolveFailureKey(row = {}) {
  const candidates = extractReasonCandidates(row);
  for (const candidate of candidates) {
    const mapped = mapKnownExecutionReason(candidate);
    if (mapped !== 'unknown') {
      return mapped;
    }
  }
  logUnknownExecutionReason(row);
  return 'unknown';
}

function classifyFailure(row = {}) {
  return resolveFailureKey(row);
}

function buildTypeSummary(rows = []) {
  const latencies = [];
  const durations = [];
  let attemptsCount = 0;
  let lastAttemptStage = null;
  let lastErrorMessage = null;
  let latestMs = 0;

  for (const row of rows) {
    const signalAt = resolveSignalAt(row);
    const intentCreatedAt = resolveIntentCreatedAt(row);
    const executionAttemptAt = resolveExecutionAttemptAt(row);
    const updatedAt = resolveUpdatedAt(row);

    if (signalAt && intentCreatedAt) {
      latencies.push(intentCreatedAt.getTime() - signalAt.getTime());
    }
    if (signalAt && updatedAt) {
      durations.push(updatedAt.getTime() - signalAt.getTime());
    } else if (intentCreatedAt && updatedAt) {
      durations.push(updatedAt.getTime() - intentCreatedAt.getTime());
    }

    const history = row.time_aligned_execution?.attempt_history || row.attempt_history || [];
    attemptsCount += history.length > 0 ? history.length : 1;

    const updatedMs = updatedAt?.getTime?.() || intentCreatedAt?.getTime?.() || 0;
    if (updatedMs >= latestMs) {
      latestMs = updatedMs;
      lastAttemptStage = resolveLastAttemptStage(row);
      lastErrorMessage = resolveErrorMessage(row);
    }
  }

  return {
    avg_latency_ms: round(average(latencies), 0),
    attempts_count: attemptsCount,
    last_attempt_stage: lastAttemptStage,
    last_error_message: lastErrorMessage,
    avg_duration_total_ms: round(average(durations), 0)
  };
}

function buildIntentSample(row = {}) {
  const signalAt = resolveSignalAt(row);
  const intentCreatedAt = resolveIntentCreatedAt(row);
  const executionAttemptAt = resolveExecutionAttemptAt(row);
  const updatedAt = resolveUpdatedAt(row);
  let durationTotalMs = null;

  if (signalAt && updatedAt) {
    durationTotalMs = updatedAt.getTime() - signalAt.getTime();
  } else if (intentCreatedAt && updatedAt) {
    durationTotalMs = updatedAt.getTime() - intentCreatedAt.getTime();
  }

  return {
    id: row.id,
    symbol: row.intent?.symbol || row.symbol || null,
    status: row.status || null,
    classified_reason: classifyFailure(row),
    t_signal: signalAt?.toISOString() || null,
    t_intent_created: intentCreatedAt?.toISOString() || null,
    t_execution_attempt: executionAttemptAt?.toISOString() || null,
    duration_total_ms: durationTotalMs,
    last_attempt_stage: resolveLastAttemptStage(row),
    last_error_message: resolveErrorMessage(row)
  };
}

function buildMappedReasonsBreakdown(rows = []) {
  const breakdown = {};
  for (const row of rows) {
    const key = classifyFailure(row);
    breakdown[key] = (breakdown[key] || 0) + 1;
  }
  return Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function deriveDiagnosis(report = {}) {
  const timeoutCount = Number(report.breakdown?.failed_timeout?.count || 0);
  const confidenceCount = Number(report.breakdown?.confidence_low?.count || 0);
  const qualityCount = Number(report.breakdown?.event_quality_gate?.count || 0);
  const rrCount = Number(report.breakdown?.risk_reward_low?.count || 0);
  const lateCount = Number(report.breakdown?.late_entry_blocked?.count || 0);
  const expiredCount = Number(report.breakdown?.intent_expired?.count || 0);
  const unknownCount = Number(report.breakdown?.unknown?.count || 0);
  const marginReadinessCount = Number(report.breakdown?.margin_leverage_not_ready?.count || 0);

  if (
    timeoutCount >= confidenceCount &&
    timeoutCount >= qualityCount &&
    timeoutCount >= rrCount &&
    timeoutCount >= lateCount &&
    timeoutCount >= expiredCount &&
    timeoutCount >= unknownCount &&
    timeoutCount > 0
  ) {
    return 'timeout_issue';
  }
  if (
    confidenceCount >= timeoutCount &&
    confidenceCount >= qualityCount &&
    confidenceCount >= rrCount &&
    confidenceCount >= lateCount &&
    confidenceCount >= expiredCount &&
    confidenceCount >= unknownCount &&
    confidenceCount > 0
  ) {
    return 'final_validation_too_strict';
  }
  if (qualityCount > 0 || rrCount > 0 || lateCount > 0 || expiredCount > 0) {
    return 'final_validation_too_strict';
  }
  if (marginReadinessCount > 0) {
    return 'execution_readiness_gap';
  }
  return 'missing_error_mapping';
}

async function getExecutionFailuresDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);

  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const executed = intents.filter((row) => String(row.status || '').toLowerCase() === 'executed');
  const failedRows = intents.filter((row) => String(row.status || '').toLowerCase() !== 'executed');
  const timeoutRows = failedRows.filter((row) => classifyFailure(row) === 'failed_timeout');
  const confidenceRows = failedRows.filter((row) => classifyFailure(row) === 'confidence_low');
  const riskRewardRows = failedRows.filter((row) => classifyFailure(row) === 'risk_reward_low');
  const qualityRows = failedRows.filter((row) => classifyFailure(row) === 'event_quality_gate');
  const lateEntryRows = failedRows.filter((row) => classifyFailure(row) === 'late_entry_blocked');
  const stopLossRows = failedRows.filter((row) => classifyFailure(row) === 'stop_loss_required');
  const expiredRows = failedRows.filter((row) => classifyFailure(row) === 'intent_expired');
  const marginReadinessRows = failedRows.filter((row) => classifyFailure(row) === 'margin_leverage_not_ready');
  const unknownRows = failedRows.filter((row) => classifyFailure(row) === 'unknown');
  const mappedReasonsBreakdown = buildMappedReasonsBreakdown(failedRows);

  const report = {
    intents_total: intents.length,
    executed: executed.length,
    failed: failedRows.length,
    breakdown: {
      failed_timeout: {
        count: timeoutRows.length,
        ...buildTypeSummary(timeoutRows)
      },
      confidence_low: {
        count: confidenceRows.length,
        ...buildTypeSummary(confidenceRows)
      },
      risk_reward_low: {
        count: riskRewardRows.length,
        ...buildTypeSummary(riskRewardRows)
      },
      event_quality_gate: {
        count: qualityRows.length,
        ...buildTypeSummary(qualityRows)
      },
      late_entry_blocked: {
        count: lateEntryRows.length,
        ...buildTypeSummary(lateEntryRows)
      },
      stop_loss_required: {
        count: stopLossRows.length,
        ...buildTypeSummary(stopLossRows)
      },
      intent_expired: {
        count: expiredRows.length,
        ...buildTypeSummary(expiredRows)
      },
      margin_leverage_not_ready: {
        count: marginReadinessRows.length,
        ...buildTypeSummary(marginReadinessRows)
      },
      unknown: {
        count: unknownRows.length,
        ...buildTypeSummary(unknownRows)
      }
    },
    failed_timeout: timeoutRows.length,
    confidence_low: confidenceRows.length,
    risk_reward_low: riskRewardRows.length,
    event_quality_gate: qualityRows.length,
    late_entry_blocked: lateEntryRows.length,
    stop_loss_required: stopLossRows.length,
    intent_expired: expiredRows.length,
    margin_leverage_not_ready: marginReadinessRows.length,
    unknown: unknownRows.length,
    unknown_count: unknownRows.length,
    avg_latency_ms: round(average(
      failedRows.map((row) => {
        const signalAt = resolveSignalAt(row);
        const intentCreatedAt = resolveIntentCreatedAt(row);
        return signalAt && intentCreatedAt ? intentCreatedAt.getTime() - signalAt.getTime() : null;
      })
    ), 0),
    intents: failedRows.slice(0, 20).map(buildIntentSample),
    mapped_reasons_breakdown: mappedReasonsBreakdown,
    unknown_samples: unknownRows.slice(0, 5).map(buildIntentSample)
  };

  return {
    ...report,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getExecutionFailuresDiagnostic
};
