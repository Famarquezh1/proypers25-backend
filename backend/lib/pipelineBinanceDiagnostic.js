const { getBinanceBotConfig } = require('./binanceBotConfig');
const { resolveTradeCostConfig } = require('../services/execution/tradeCostModel');

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

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

function toMillis(value) {
  const date = parseDateLike(value);
  return date ? date.getTime() : 0;
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function increment(bucket, key, amount = 1) {
  const normalized = String(key || 'unknown');
  bucket[normalized] = (bucket[normalized] || 0) + amount;
}

function topEntries(map = {}, limit = 10) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function normalizeSourceProfile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high_conviction') return 'high_conviction';
  if (normalized === 'event_emitted') return 'event_emitted';
  if (normalized === 'manual_prealert') return 'manual_prealert';
  if (normalized === 'none') return 'none';
  return normalized || 'unknown';
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(1, Number(options.hours || 24));
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

async function loadCurrentOpenRows(db, maxDocs) {
  const snapshot = await db.collection('binance_open_positions').where('status', '==', 'open').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function loadCooldownStates(db, maxDocs) {
  const snapshot = await db.collection('velas_symbol_runtime_state').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolvePredictionTimestamp(row = {}) {
  return (
    parseDateLike(row.timestamp) ||
    parseDateLike(row.created_at) ||
    parseDateLike(row.signal_created_at) ||
    parseDateLike(row.signal_emitted_at) ||
    parseDateLike(row.ahora)
  );
}

function resolvePredictionSymbol(row = {}) {
  return String(row.simbolo || row.symbol || row.simbolo_normalizado || '').toUpperCase() || null;
}

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function resolvePositionOpenedAt(row = {}) {
  return parseDateLike(row.opened_at) || parseDateLike(row.created_at);
}

function resolvePositionClosedAt(row = {}) {
  return parseDateLike(row.closed_at) || parseDateLike(row.updated_at);
}

function matchesSymbol(symbolFilter, ...candidates) {
  if (!symbolFilter) return true;
  return candidates
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .some((value) => value === symbolFilter);
}

function normalizeIntentReason(row = {}) {
  return String(
    row.reason ||
      row.validation?.reason ||
      row.execution_discipline?.reason ||
      row.error_message ||
      ''
  ).trim() || 'unknown';
}

function buildFeesBlockAnalysis(intents = [], options = {}) {
  const includeDetails = options.includeDetails === true;
  const feeConfig = resolveTradeCostConfig();
  const feeRoundtripPct = Number(feeConfig.roundtrip_fee_pct || 0);
  const explicitFeeReasons = new Set(['net_edge_rejected']);
  const evaluatedIntents = intents.filter((row) => row.intent || row.symbol || row.prediction_id);
  const blockedCandidates = evaluatedIntents.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    return status !== 'executed' && status !== 'closed';
  });

  const analyzed = blockedCandidates.map((row) => {
    const reason = normalizeIntentReason(row);
    const expectedMove = toNumber(row.intent?.expected_move_percent, null);
    const differencePct = expectedMove == null ? null : expectedMove - feeRoundtripPct;
    const explicitFeeBlocked =
      reason.includes('fee') ||
      reason.includes('net_edge') ||
      explicitFeeReasons.has(reason);
    const inferredFeeBlocked =
      expectedMove != null &&
      differencePct != null &&
      differencePct <= 0 &&
      (
        reason === 'pre_validation_failed' ||
        reason === 'expected_move_low' ||
        explicitFeeBlocked
      );

    let classification = 'unknown';
    if (expectedMove != null) {
      if (expectedMove < feeRoundtripPct * 0.8) classification = 'claramente_no_rentable';
      else if (expectedMove >= feeRoundtripPct * 0.8 && expectedMove <= feeRoundtripPct * 1.2) classification = 'borderline';
      else if (expectedMove > feeRoundtripPct) classification = 'potencialmente_rentable';
    }

    return {
      id: row.id,
      status: row.status || null,
      source_profile: row.source_profile || null,
      symbol: row.intent?.symbol || row.symbol || null,
      reason,
      expected_move_pct: expectedMove,
      fee_roundtrip_pct: feeRoundtripPct,
      delta_vs_fee_pct: differencePct == null ? null : round(differencePct, 4),
      explicit_fee_blocked: explicitFeeBlocked,
      inferred_fee_blocked: inferredFeeBlocked,
      classification
    };
  });

  const feeRelatedBlocked = analyzed.filter((row) => row.explicit_fee_blocked || row.inferred_fee_blocked);
  const borderline = feeRelatedBlocked.filter((row) => row.classification === 'borderline');
  const clearlyNotProfitable = feeRelatedBlocked.filter((row) => row.classification === 'claramente_no_rentable');
  const potentiallyProfitable = feeRelatedBlocked.filter((row) => row.classification === 'potencialmente_rentable');
  const explicitCount = feeRelatedBlocked.filter((row) => row.explicit_fee_blocked).length;
  const inferredOnlyCount = feeRelatedBlocked.filter((row) => !row.explicit_fee_blocked && row.inferred_fee_blocked).length;

  const opportunityLossPct = feeRelatedBlocked.length
    ? round((potentiallyProfitable.length / feeRelatedBlocked.length) * 100, 2)
    : 0;
  const feeBlockedPctOverTotal = evaluatedIntents.length
    ? round((feeRelatedBlocked.length / evaluatedIntents.length) * 100, 2)
    : 0;

  const automaticDiagnosis = potentiallyProfitable.length > clearlyNotProfitable.length
    ? 'Las comisiones estan eliminando edge'
    : 'Las comisiones estan eliminando ruido';

  return {
    total_intents_evaluados: evaluatedIntents.length,
    intents_bloqueados_por_fees: feeRelatedBlocked.length,
    intents_bloqueados_por_fees_pct: feeBlockedPctOverTotal,
    explicit_fee_related_blocked: explicitCount,
    inferred_fee_related_blocked: inferredOnlyCount,
    fee_roundtrip_aplicado_pct: round(feeRoundtripPct, 4),
    clasificacion: {
      borderline: borderline.length,
      claramente_no_rentable: clearlyNotProfitable.length,
      potencialmente_rentable: potentiallyProfitable.length
    },
    FEES_IMPACT: {
      pct_intents_bloqueados_por_fees: feeBlockedPctOverTotal,
      pct_de_esos_potencialmente_rentables: feeRelatedBlocked.length
        ? round((potentiallyProfitable.length / feeRelatedBlocked.length) * 100, 2)
        : 0,
      perdida_de_oportunidad_estimada: {
        intents: potentiallyProfitable.length,
        pct_sobre_bloqueados_por_fees: opportunityLossPct
      },
      diagnostico_automatico: automaticDiagnosis
    },
    details: includeDetails
      ? {
          fee_related_samples: feeRelatedBlocked.slice(0, 30),
          top_fee_related_reasons: topEntries(
            feeRelatedBlocked.reduce((acc, row) => {
              increment(acc, row.reason);
              return acc;
            }, {}),
            10
          )
        }
      : undefined
  };
}

function classifyPreValidationSubchecks(row = {}) {
  const checks = [];
  const reason = normalizeIntentReason(row);
  const errorMessage = String(row.error_message || '').toLowerCase();
  const intent = row.intent || {};
  const config = row.config_snapshot || {};

  if (errorMessage.includes('requires an index') || errorMessage.includes('failed_precondition')) {
    checks.push('firestore_index_missing');
  }
  if (errorMessage.includes('timeout')) {
    checks.push('pre_validation_timeout');
  }
  if (reason.includes('missing_api_credentials')) {
    checks.push('api_credentials_check_failed');
  }
  if (toNumber(intent.confidence, null) != null && intent.confidence < Number(config.min_confidence ?? 0)) {
    checks.push('confidence_check_failed');
  }
  if (toNumber(intent.timing, null) != null && intent.timing < Number(config.min_timing ?? 0)) {
    checks.push('timing_check_failed');
  }
  if (toNumber(intent.quantum, null) != null && intent.quantum < Number(config.min_quantum ?? 0)) {
    checks.push('volatility_check_failed');
  }

  const minContextQuality = Number(config.min_context_quality ?? 0);
  const hasContextQuality = toNumber(intent.context_quality, null) != null;
  if (minContextQuality > 0 && hasContextQuality && Number(intent.context_quality) < minContextQuality) {
    checks.push('liquidity_check_failed');
  } else if (
    !hasContextQuality &&
    toNumber(intent.context_score, null) != null &&
    Number(intent.context_score) < Number(config.min_context_score ?? 0)
  ) {
    checks.push('liquidity_check_failed');
  }

  if (toNumber(intent.risk_reward_ratio, null) != null && intent.risk_reward_ratio < Number(config.min_risk_reward ?? 0)) {
    checks.push('spread_check_failed');
  }
  if (
    toNumber(intent.expected_move_percent, null) != null &&
    intent.expected_move_percent < Number(config.min_expected_move_pct ?? 0)
  ) {
    checks.push('expected_move_check_failed');
  }
  if (reason.includes('net_edge') || reason.includes('fee')) {
    checks.push('fee_edge_check_failed');
  }
  if (reason.includes('symbol_not_allowed')) {
    checks.push('symbol_allowlist_check_failed');
  }
  if (reason.includes('max_concurrent')) {
    checks.push('duplicate_position_check_failed');
  }
  if (!checks.length) {
    checks.push('unknown_pre_validation_check_failed');
  }
  return Array.from(new Set(checks));
}

function buildPreValidationBreakdown(intents = [], options = {}) {
  const includeDetails = options.includeDetails === true;
  const preValidationFailed = intents.filter((row) => normalizeIntentReason(row) === 'pre_validation_failed');
  const total = preValidationFailed.length;
  const counts = {};
  const signalCounts = {};
  const intentCounts = {};

  for (const row of preValidationFailed) {
    const checks = classifyPreValidationSubchecks(row);
    for (const check of checks) {
      increment(counts, check);
      if (!signalCounts[check]) signalCounts[check] = new Set();
      signalCounts[check].add(String(row.prediction_id || row.id || 'unknown'));
      increment(intentCounts, check);
    }
  }

  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([check, count]) => ({
      check,
      total: count,
      pct_over_total_pre_validation_failed: total ? round((count / total) * 100, 2) : 0,
      original_signals_triggering: signalCounts[check] ? signalCounts[check].size : 0,
      intents_inheriting: intentCounts[check] || 0
    }));

  const topBlockers = breakdown.slice(0, 3).map((item) => ({
    check: item.check,
    pct: item.pct_over_total_pre_validation_failed
  }));
  const dominant = breakdown[0] || null;

  return {
    total_pre_validation_failed: total,
    breakdown,
    TOP_BLOCKERS: topBlockers,
    PRE_VALIDATION_DIAGNOSTIC: dominant
      ? {
          diagnostico: `El sistema esta sobre-filtrando en ${dominant.check}`,
          intents_mueren_en_esta_etapa_pct: dominant.pct_over_total_pre_validation_failed,
          nota: 'Esto ocurre antes de cualquier interaccion con Binance'
        }
      : {
          diagnostico: 'No se detectaron intents con pre_validation_failed',
          intents_mueren_en_esta_etapa_pct: 0,
          nota: 'No aplica'
        },
    details: includeDetails
      ? {
          samples: preValidationFailed.slice(0, 25).map((row) => ({
            id: row.id,
            prediction_id: row.prediction_id || null,
            source_profile: row.source_profile || null,
            symbol: row.intent?.symbol || row.symbol || null,
            error_message: row.error_message || null,
            subchecks: classifyPreValidationSubchecks(row)
          }))
        }
      : undefined
  };
}

function buildSignalsSummary(predictions = [], highConvictionSignals = [], cooldownStates = [], config = {}, options = {}) {
  const suppressionReasons = {};
  const gateReasons = {};
  let emittedTotal = 0;
  let suppressedTotal = 0;
  let eventEmittedSignals = 0;
  let highConvictionFromPredictions = 0;
  let qualityGateSuppressed = 0;
  let lowConfidenceSuppressed = 0;

  for (const row of predictions) {
    if (row.signal_emitted === true) emittedTotal += 1;
    if (row.signal_emitted === false) suppressedTotal += 1;
    const suppressionReason = row.suppression_reason || row.decision_post_learning?.suppression_reason || null;
    const gateReason = row.decision_post_learning?.gate_reason || null;
    const sourceProfile = normalizeSourceProfile(
      row.binance_execution?.source_profile ||
      row.binance_source_profile ||
      row.early_execution_source_profile ||
      row.source_profile
    );
    if (sourceProfile === 'event_emitted') {
      eventEmittedSignals += row.signal_emitted === true ? 1 : 0;
    }
    if (sourceProfile === 'high_conviction') {
      highConvictionFromPredictions += row.signal_emitted === true ? 1 : 0;
    }
    if (suppressionReason) {
      increment(suppressionReasons, suppressionReason);
      if (suppressionReason === 'quality_gate') qualityGateSuppressed += 1;
      if (suppressionReason === 'low_confidence') lowConfidenceSuppressed += 1;
    }
    if (gateReason) {
      increment(gateReasons, gateReason);
    }
  }

  const nowMs = Date.now();
  const activeCooldownStates = cooldownStates.filter((row) => toMillis(row.cooldown_until) > nowMs);
  const qualityGateActive =
    predictions.some((row) => row?.decision_post_learning?.quality_gate_passed === false || row?.suppression_reason === 'quality_gate') ||
    predictions.some((row) => row?.decision_post_learning?.gate_reason);

  const includeDetails = options.includeDetails === true;
  return {
    high_conviction_signals: highConvictionSignals.length,
    event_emitted_signals: eventEmittedSignals,
    emitted_total: emittedTotal,
    suppressed_total: suppressedTotal,
    emitted_vs_suppressed: {
      emitted: emittedTotal,
      suppressed: suppressedTotal
    },
    suppression_reasons_top: topEntries(suppressionReasons),
    gate_reasons_top: topEntries(gateReasons),
    suppression_breakdown: {
      quality_gate: qualityGateSuppressed,
      low_confidence: lowConfidenceSuppressed
    },
    cooldown: {
      active: activeCooldownStates.length > 0,
      active_symbols: activeCooldownStates.length,
      active_symbols_sample: activeCooldownStates.slice(0, 10).map((row) => ({
        symbol: row.id,
        cooldown_until: row.cooldown_until || null,
        last_failure_reason: row.last_failure_reason || null
      }))
    },
    quality_gate: {
      active: qualityGateActive,
      inferred_from_recent_predictions: qualityGateActive
    },
    config_snapshot: {
      execution_enabled: Boolean(config.execution_enabled),
      mode: config.mode || 'off',
      symbol_cooldown_minutes: Number(config.symbol_cooldown_minutes || 0),
      min_expected_move_pct: Number(config.min_expected_move_pct || 0),
      min_confidence: Number(config.min_confidence || 0),
      min_quantum: Number(config.min_quantum || 0),
      min_timing: Number(config.min_timing || 0)
    },
    details: includeDetails
      ? {
          recent_prediction_samples: predictions.slice(0, 20).map((row) => ({
            id: row.id,
            symbol: resolvePredictionSymbol(row),
            timestamp: resolvePredictionTimestamp(row)?.toISOString() || null,
            signal_emitted: row.signal_emitted === true,
            suppression_reason: row.suppression_reason || row.decision_post_learning?.suppression_reason || null,
            gate_reason: row.decision_post_learning?.gate_reason || null,
            binance_reason: row.binance_execution?.reason || null,
            source_profile:
              row.binance_execution?.source_profile ||
              row.binance_source_profile ||
              row.early_execution_source_profile ||
              row.source_profile ||
              null
          }))
        }
      : undefined
  };
}

function buildIntentsSummary(intents = [], options = {}) {
  const statusCounts = {
    total_binance_execution_intents: intents.length,
    executed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    closed: 0
  };
  const rawStatusCounts = {};
  const reasons = {};
  const requestedReasonCounts = {
    slippage_blocked: 0,
    min_notional: 0,
    duplicate_position: 0,
    stale_no_followthrough: 0,
    fee_blocked: 0,
    no_ignition: 0,
    risk_blocked: 0
  };

  for (const row of intents) {
    const status = String(row.status || 'unknown').toLowerCase();
    increment(rawStatusCounts, status);
    if (status === 'executed') statusCounts.executed += 1;
    else if (status === 'blocked') statusCounts.blocked += 1;
    else if (status === 'failed') statusCounts.failed += 1;
    else if (status === 'skipped') statusCounts.skipped += 1;
    else if (status === 'closed') statusCounts.closed += 1;
    else statusCounts.pending += 1;

    const reason = normalizeIntentReason(row);
    increment(reasons, reason);
    if (reason.includes('slippage')) requestedReasonCounts.slippage_blocked += 1;
    if (reason.includes('min_notional') || reason.includes('notional')) requestedReasonCounts.min_notional += 1;
    if (reason.includes('duplicate_position') || reason.includes('max_concurrent') || reason.includes('already_open')) {
      requestedReasonCounts.duplicate_position += 1;
    }
    if (reason.includes('stale_no_followthrough')) requestedReasonCounts.stale_no_followthrough += 1;
    if (reason.includes('fee') || reason.includes('net_edge')) requestedReasonCounts.fee_blocked += 1;
    if (reason.includes('no_ignition')) requestedReasonCounts.no_ignition += 1;
    if (reason.includes('risk')) requestedReasonCounts.risk_blocked += 1;
  }

  const includeDetails = options.includeDetails === true;
  return {
    ...statusCounts,
    raw_status_counts: rawStatusCounts,
    reasons_top: topEntries(reasons, 20),
    reason_buckets: requestedReasonCounts,
    details: includeDetails
      ? {
          recent_intent_samples: intents.slice(0, 25).map((row) => ({
            id: row.id,
            created_at: resolveIntentTimestamp(row)?.toISOString() || null,
            source_profile: row.source_profile || null,
            status: row.status || null,
            reason: normalizeIntentReason(row),
            symbol: row.intent?.symbol || row.symbol || null,
            prediction_id: row.prediction_id || null,
            linked_position_id: row.linked_position_id || null
          }))
        }
      : undefined
  };
}

function buildOpenPositionsSummary(currentOpenPositions = [], windowPositions = [], options = {}) {
  const nowMs = Date.now();
  const agesSeconds = [];
  let nearMaxHold = 0;
  let exceededMaxHold = 0;
  let unprotected = 0;

  for (const row of currentOpenPositions) {
    const openedAt = resolvePositionOpenedAt(row);
    const maxHoldSeconds = toNumber(row.position_max_hold_seconds, null);
    const ageSeconds = openedAt ? (nowMs - openedAt.getTime()) / 1000 : null;
    if (ageSeconds != null) agesSeconds.push(ageSeconds);
    if (ageSeconds != null && maxHoldSeconds != null && maxHoldSeconds > 0) {
      if (ageSeconds >= maxHoldSeconds) exceededMaxHold += 1;
      else if (ageSeconds >= maxHoldSeconds * 0.8) nearMaxHold += 1;
    }
    const hasSomeProtection =
      Boolean(row.tp_order_id) ||
      Boolean(row.sl_order_id) ||
      Boolean(row.protective_stop_available) ||
      Boolean(row.protective_order_status);
    if (!hasSomeProtection && row.enable_tp_sl !== false) {
      unprotected += 1;
    }
  }

  const includeDetails = options.includeDetails === true;
  return {
    total_binance_open_positions_window: windowPositions.length,
    total_current_open_positions: currentOpenPositions.length,
    posiciones_aun_abiertas: currentOpenPositions.length,
    edad_promedio_posiciones_abiertas_horas: round(average(agesSeconds.map((value) => value / 3600))),
    posiciones_con_max_hold_cercano: nearMaxHold,
    posiciones_con_max_hold_excedido: exceededMaxHold,
    posiciones_sin_proteccion_detectada: unprotected,
    posiciones_cerradas_esperadas_pero_no_encontradas: exceededMaxHold,
    details: includeDetails
      ? {
          open_positions_sample: currentOpenPositions.slice(0, 20).map((row) => {
            const openedAt = resolvePositionOpenedAt(row);
            const ageSeconds = openedAt ? (nowMs - openedAt.getTime()) / 1000 : null;
            const maxHoldSeconds = toNumber(row.position_max_hold_seconds, null);
            return {
              id: row.id,
              symbol: row.symbol || null,
              source_profile: row.source_profile || null,
              opened_at: openedAt?.toISOString() || null,
              age_hours: ageSeconds == null ? null : round(ageSeconds / 3600),
              max_hold_hours: maxHoldSeconds == null ? null : round(maxHoldSeconds / 3600),
              exceeded_max_hold: ageSeconds != null && maxHoldSeconds != null ? ageSeconds >= maxHoldSeconds : false,
              tp_order_id: row.tp_order_id || null,
              sl_order_id: row.sl_order_id || null,
              protective_order_status: row.protective_order_status || null
            };
          })
        }
      : undefined
  };
}

function buildClosedPositionsSummary(closedPositions = [], intentCloseEvidence = [], options = {}) {
  const includeDetails = options.includeDetails === true;
  return {
    total_closed_positions_encontradas: closedPositions.length,
    total_intent_close_evidence: intentCloseEvidence.length,
    collection_exacta_usada_para_cierres: 'binance_open_positions',
    supporting_collections_checked: ['binance_execution_intents'],
    details: includeDetails
      ? {
          closed_positions_sample: closedPositions.slice(0, 20).map((row) => ({
            id: row.id,
            symbol: row.symbol || null,
            source_profile: row.source_profile || null,
            opened_at: resolvePositionOpenedAt(row)?.toISOString() || null,
            closed_at: resolvePositionClosedAt(row)?.toISOString() || null,
            close_reason: row.close_reason || null,
            close_pnl_pct: toNumber(row.close_pnl_pct, null)
          })),
          intent_close_evidence_sample: intentCloseEvidence.slice(0, 20).map((row) => ({
            id: row.id,
            source_profile: row.source_profile || null,
            status: row.status || null,
            closed_at: parseDateLike(row.closed_at || row.execution_audit?.closed_at)?.toISOString() || null,
            close_pnl_pct: toNumber(row.close_pnl_pct ?? row.execution_audit?.close_pnl_pct, null),
            reason: normalizeIntentReason(row)
          }))
        }
      : undefined
  };
}

function deriveBottleneck(context = {}) {
  const emittedSignals = Number(context.signals?.emitted_total || 0);
  const suppressedSignals = Number(context.signals?.suppressed_total || 0);
  const highConvictionSignals = Number(context.signals?.high_conviction_signals || 0);
  const intentsTotal = Number(context.intents?.total_binance_execution_intents || 0);
  const intentsExecuted = Number(context.intents?.executed || 0);
  const openPositions = Number(context.open?.total_current_open_positions || 0);
  const closedPositions = Number(context.closed?.total_closed_positions_encontradas || 0);
  const intentCloseEvidence = Number(context.closed?.total_intent_close_evidence || 0);

  if (closedPositions === 0 && intentCloseEvidence > 0) {
    return {
      stage: 'collection_mismatch',
      dominant_state: 'Hubo cierre pero no se esta leyendo la coleccion primaria correcta.',
      probable_bottleneck: 'Los cierres aparecen en intents, pero no en binance_open_positions.',
      evidence: `intent_close_evidence=${intentCloseEvidence}, closed_positions=${closedPositions}`,
      recommended_action: 'Verificar sincronizacion entre cierre de posicion e insercion/actualizacion en binance_open_positions.',
      risk: 'El diagnostico neto puede estar subreportando cierres reales.'
    };
  }

  if (emittedSignals === 0 && highConvictionSignals === 0 && suppressedSignals === 0) {
    return {
      stage: 'no_signals',
      dominant_state: 'No hubo señales en la ventana.',
      probable_bottleneck: 'El sistema no detecto oportunidades o no produjo predicciones utiles.',
      evidence: `emitted=${emittedSignals}, suppressed=${suppressedSignals}, high_conviction=${highConvictionSignals}`,
      recommended_action: 'Revisar si el ciclo de prediccion estuvo corriendo y si hubo datos de mercado suficientes.',
      risk: 'Se esta operando sin flujo de oportunidades.'
    };
  }

  if (emittedSignals === 0 && suppressedSignals > 0) {
    return {
      stage: 'signal_suppression',
      dominant_state: 'Hubo predicciones, pero quedaron suprimidas antes de Binance.',
      probable_bottleneck: 'Quality gate o filtros previos estan bloqueando correctamente la emision.',
      evidence: `suppressed=${suppressedSignals}, top_reason=${context.signals?.suppression_reasons_top?.[0]?.key || 'unknown'}`,
      recommended_action: 'Auditar razones de supresion y validar si corresponden a calidad de señal o a un falso negativo del gate.',
      risk: 'Puedes concluir que no hay edge cuando en realidad no se esta dejando pasar ninguna señal.'
    };
  }

  if (emittedSignals > 0 && intentsTotal === 0) {
    return {
      stage: 'signals_without_intents',
      dominant_state: 'Hubo señales emitidas, pero no se generaron intents.',
      probable_bottleneck: 'La etapa entre emision de señal y creacion de intent no esta corriendo o no persiste.',
      evidence: `emitted=${emittedSignals}, intents=${intentsTotal}`,
      recommended_action: 'Verificar el puente signal -> binance_execution_intents y el estado del scheduler asociado.',
      risk: 'Oportunidades detectadas no llegan a Binance.'
    };
  }

  if (intentsTotal > 0 && intentsExecuted === 0) {
    return {
      stage: 'intents_without_execution',
      dominant_state: 'Hubo intents, pero ninguno llego a ejecucion.',
      probable_bottleneck: 'Binance executor o validaciones pre-trade estan bloqueando la operacion.',
      evidence: `intents=${intentsTotal}, blocked=${context.intents?.blocked || 0}, failed=${context.intents?.failed || 0}, skipped=${context.intents?.skipped || 0}`,
      recommended_action: 'Revisar reasons top de intents para confirmar si el bloqueo es esperado o si hay timeout/falla operativa.',
      risk: 'El sistema parece vivo, pero no convierte oportunidades en posiciones.'
    };
  }

  if (intentsExecuted > 0 && closedPositions === 0) {
    return {
      stage: 'executed_without_close',
      dominant_state: 'Hubo ejecucion, pero no aparecen cierres en la ventana.',
      probable_bottleneck: openPositions > 0
        ? 'Las posiciones siguen abiertas o excedieron max_hold sin cierre registrado.'
        : 'El cierre no se registro donde se espera.',
      evidence: `executed=${intentsExecuted}, open_positions=${openPositions}, closed_positions=${closedPositions}`,
      recommended_action: openPositions > 0
        ? 'Revisar posiciones abiertas envejecidas, max_hold y protecciones pendientes.'
        : 'Validar escritura de closed_at/close_pnl_pct en binance_open_positions.',
      risk: 'El PnL real queda invisible y el sistema puede acumular riesgo abierto.'
    };
  }

  return {
    stage: 'closed_positions_present',
    dominant_state: 'Se detectaron cierres en la ventana.',
    probable_bottleneck: 'No hay ausencia de cierres; el problema puede estar en el consumo aguas abajo.',
    evidence: `closed_positions=${closedPositions}`,
    recommended_action: 'Comparar este resultado contra el endpoint de diagnostico neto y verificar filtros de ventana o symbol.',
    risk: 'Puedes diagnosticar una ausencia inexistente si lees otra ventana o coleccion.'
  };
}

async function getPipelineBinanceDiagnostic(db, options = {}) {
  const includeDetails = String(options.includeDetails || '').toLowerCase() === 'true';
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const symbolFilter = String(options.symbol || '').trim().toUpperCase() || null;
  const { since, until } = getWindow(options);
  const config = await getBinanceBotConfig(db);

  const [predictionRows, hcSignalRows, intentRows, positionRows, currentOpenRows, cooldownStates] = await Promise.all([
    loadRecentRows(db, 'velas_predicciones', 'timestamp', maxDocs),
    loadRecentRows(db, 'high_conviction_signals', 'created_at', maxDocs),
    loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs),
    loadRecentRows(db, 'binance_open_positions', 'created_at', maxDocs),
    loadCurrentOpenRows(db, maxDocs),
    loadCooldownStates(db, 1000)
  ]);

  const predictions = predictionRows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts &&
      ts >= since &&
      ts <= until &&
      matchesSymbol(symbolFilter, resolvePredictionSymbol(row));
  });

  const highConvictionSignals = hcSignalRows.filter((row) => {
    const ts = parseDateLike(row.created_at) || parseDateLike(row.timestamp);
    return ts &&
      ts >= since &&
      ts <= until &&
      matchesSymbol(symbolFilter, row.symbol, row.simbolo);
  });

  const intents = intentRows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    const symbol = row.intent?.symbol || row.symbol || null;
    return ts &&
      ts >= since &&
      ts <= until &&
      matchesSymbol(symbolFilter, symbol);
  });

  const windowPositions = positionRows.filter((row) => {
    const openedAt = resolvePositionOpenedAt(row);
    const closedAt = resolvePositionClosedAt(row);
    const overlapsWindow =
      (openedAt && openedAt <= until) &&
      ((!closedAt && String(row.status || '').toLowerCase() === 'open') || (closedAt && closedAt >= since));
    return overlapsWindow && matchesSymbol(symbolFilter, row.symbol);
  });

  const currentOpenPositions = currentOpenRows.filter((row) => matchesSymbol(symbolFilter, row.symbol));

  const closedPositions = windowPositions.filter((row) => {
    const closedAt = resolvePositionClosedAt(row);
    return String(row.status || '').toLowerCase() === 'closed' && closedAt && closedAt >= since && closedAt <= until;
  });

  const intentCloseEvidence = intents.filter((row) => {
    const closedAt = parseDateLike(row.closed_at || row.execution_audit?.closed_at);
    const hasClosePnl = toNumber(row.close_pnl_pct ?? row.execution_audit?.close_pnl_pct, null) !== null;
    return closedAt || hasClosePnl;
  });

  const relevantCooldownStates = cooldownStates.filter((row) => matchesSymbol(symbolFilter, row.id));

  const signalsSummary = buildSignalsSummary(predictions, highConvictionSignals, relevantCooldownStates, config, {
    includeDetails
  });
  const intentsSummary = buildIntentsSummary(intents, { includeDetails });
  const feesBlockAnalysis = buildFeesBlockAnalysis(intents, { includeDetails });
  const preValidationBreakdown = buildPreValidationBreakdown(intents, { includeDetails });
  const openPositionsSummary = buildOpenPositionsSummary(currentOpenPositions, windowPositions, { includeDetails });
  const closedPositionsSummary = buildClosedPositionsSummary(closedPositions, intentCloseEvidence, { includeDetails });
  const bottleneck = deriveBottleneck({
    signals: signalsSummary,
    intents: intentsSummary,
    open: openPositionsSummary,
    closed: closedPositionsSummary
  });

  const interpretation = {
    DIAGNOSTICO_PIPELINE: {
      'Estado dominante': bottleneck.dominant_state,
      'Cuello de botella probable': bottleneck.probable_bottleneck,
      Evidencia: bottleneck.evidence,
      'Accion recomendada': bottleneck.recommended_action,
      'Riesgo actual': bottleneck.risk
    },
    FEES_IMPACT: feesBlockAnalysis.FEES_IMPACT,
    PRE_VALIDATION_DIAGNOSTIC: preValidationBreakdown.PRE_VALIDATION_DIAGNOSTIC
  };

  const report = {
    generated_at: new Date().toISOString(),
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      hours: round((until.getTime() - since.getTime()) / (60 * 60 * 1000), 2),
      symbol: symbolFilter || null
    },
    signals_summary: signalsSummary,
    intents_summary: intentsSummary,
    fees_block_analysis: feesBlockAnalysis,
    pre_validation_breakdown: preValidationBreakdown,
    open_positions_summary: openPositionsSummary,
    closed_positions_summary: closedPositionsSummary,
    bottleneck,
    interpretation,
    recommended_next_action: bottleneck.recommended_action
  };

  console.log('[PIPELINE_BINANCE_DIAGNOSTIC]', JSON.stringify({
    generated_at: report.generated_at,
    window: report.window,
    emitted_signals: report.signals_summary.emitted_total,
    suppressed_signals: report.signals_summary.suppressed_total,
    intents: report.intents_summary.total_binance_execution_intents,
    fee_related_blocked: report.fees_block_analysis.intents_bloqueados_por_fees,
    pre_validation_failed: report.pre_validation_breakdown.total_pre_validation_failed,
    top_pre_validation_blocker: report.pre_validation_breakdown.TOP_BLOCKERS[0]?.check || null,
    intents_executed: report.intents_summary.executed,
    open_positions: report.open_positions_summary.total_current_open_positions,
    closed_positions: report.closed_positions_summary.total_closed_positions_encontradas,
    bottleneck_stage: report.bottleneck.stage
  }));

  return report;
}

module.exports = {
  getPipelineBinanceDiagnostic
};
