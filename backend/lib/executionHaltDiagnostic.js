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

function round(value, decimals = 4) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function startOfUtcDay(date = new Date()) {
  const output = new Date(date);
  output.setUTCHours(0, 0, 0, 0);
  return output;
}

function endOfUtcDay(date = new Date()) {
  const output = startOfUtcDay(date);
  output.setUTCDate(output.getUTCDate() + 1);
  output.setUTCMilliseconds(output.getUTCMilliseconds() - 1);
  return output;
}

function isFirestoreIndexMissingError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('requires an index') ||
    message.includes('failed_precondition') ||
    message.includes('create_composite')
  );
}

function resolveTradeClosedAt(row = {}) {
  return parseDateLike(row.closed_at) || parseDateLike(row.execution_audit?.closed_at) || parseDateLike(row.updated_at);
}

function resolveTradeOpenedAt(row = {}, linkedPosition = null) {
  return (
    parseDateLike(linkedPosition?.opened_at) ||
    parseDateLike(row.opened_at) ||
    parseDateLike(row.execution_audit?.opened_at) ||
    parseDateLike(row.execution_audit?.executed_at) ||
    parseDateLike(row.executed_at) ||
    parseDateLike(row.execution_trace?.order_ack_at) ||
    parseDateLike(row.execution_trace?.execution_attempt_at)
  );
}

function resolveOrigin(row = {}, linkedPosition = null) {
  return (
    row.source_profile ||
    row.source ||
    row.intent?.source_profile ||
    row.execution_audit?.source_profile ||
    linkedPosition?.source_profile ||
    linkedPosition?.source ||
    null
  );
}

function resolveSide(row = {}, linkedPosition = null) {
  return row.side || row.intent?.side || linkedPosition?.side || linkedPosition?.intent?.side || null;
}

function resolvePnlBruto(row = {}) {
  return toNumber(
    row.close_pnl_pct ??
      row.gross_close_pnl_pct ??
      row.execution_audit?.close_pnl_pct ??
      row.execution_audit?.gross_close_pnl_pct,
    null
  );
}

function resolvePnlNeto(row = {}) {
  return toNumber(
    row.net_close_pnl_pct ??
      row.execution_audit?.net_close_pnl_pct ??
      row.real_close_pnl_pct ??
      resolvePnlBruto(row),
    null
  );
}

function resolveFees(row = {}) {
  const gross = resolvePnlBruto(row);
  const net = resolvePnlNeto(row);
  if (gross !== null && net !== null) {
    return round(gross - net);
  }
  return toNumber(
    row.estimated_fee_roundtrip_pct ??
      row.execution_audit?.estimated_roundtrip_cost_pct ??
      row.execution_audit?.trade_cost_model?.roundtrip_fee_pct ??
      row.fee_roundtrip_pct,
    null
  );
}

async function loadClosedExecutedIntents(db, options = {}) {
  const safeLimit = Math.max(20, Math.min(Number(options.limit || 200), 1000));
  const closedSince = parseDateLike(options.closedSince);
  try {
    let query = db
      .collection('binance_execution_intents')
      .where('status', '==', 'executed')
      .orderBy('closed_at', 'desc')
      .limit(safeLimit);
    if (closedSince) {
      query = db
        .collection('binance_execution_intents')
        .where('status', '==', 'executed')
        .where('closed_at', '>=', closedSince.toISOString())
        .orderBy('closed_at', 'desc')
        .limit(safeLimit);
    }
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  } catch (err) {
    if (!isFirestoreIndexMissingError(err)) throw err;
    const fallbackSnapshot = await db.collection('binance_execution_intents').orderBy('created_at', 'desc').limit(1000).get();
    return fallbackSnapshot.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .filter((row) => {
        if (String(row.status || '').toLowerCase() !== 'executed') return false;
        const closedAt = resolveTradeClosedAt(row);
        if (!closedAt) return false;
        if (closedSince && closedAt < closedSince) return false;
        return true;
      })
      .slice(0, safeLimit);
  }
}

async function loadLinkedPositions(db, intentRows = []) {
  const uniqueIds = [...new Set(intentRows.map((row) => row.linked_position_id).filter(Boolean))];
  const docs = await Promise.all(uniqueIds.map((id) => db.collection('binance_open_positions').doc(id).get().catch(() => null)));
  return docs.reduce((acc, doc, index) => {
    if (doc?.exists) {
      acc.set(uniqueIds[index], { id: uniqueIds[index], ...(doc.data() || {}) });
    }
    return acc;
  }, new Map());
}

function sortClosedTradesDesc(rows = []) {
  return [...rows].sort((a, b) => {
    const aMs = resolveTradeClosedAt(a)?.getTime?.() || 0;
    const bMs = resolveTradeClosedAt(b)?.getTime?.() || 0;
    return bMs - aMs;
  });
}

function filterTradesInWindow(rows = [], from, to) {
  const fromMs = from?.getTime?.() || 0;
  const toMs = to?.getTime?.() || Date.now();
  return rows.filter((row) => {
    const closedAt = resolveTradeClosedAt(row);
    const closedMs = closedAt?.getTime?.();
    return Number.isFinite(closedMs) && closedMs >= fromMs && closedMs <= toMs;
  });
}

function buildLossStreak(rows = [], options = {}) {
  const limit = Math.max(1, Number(options.limit || 3));
  const validRows = rows.filter((row) => resolvePnlBruto(row) !== null);
  const streakRows = [];
  let totalPnlPct = 0;
  let wins = 0;

  for (let index = 0; index < validRows.length; index += 1) {
    const row = validRows[index];
    const pnl = resolvePnlBruto(row);
    totalPnlPct += pnl;
    if (pnl > 0) wins += 1;
    if (index === 0 && pnl >= 0) {
      break;
    }
    if (pnl < 0 && streakRows.length === index) {
      streakRows.push(row);
      continue;
    }
    if (pnl >= 0 && streakRows.length === index) {
      break;
    }
  }

  const totalTrades = validRows.length;
  return {
    current_count: streakRows.length,
    configured_limit: limit,
    trades: streakRows,
    total_trades: totalTrades,
    total_pnl_pct: round(totalPnlPct),
    win_rate_pct: totalTrades > 0 ? round((wins / totalTrades) * 100, 2) : 0
  };
}

function resolveHaltSource(runtimeData = {}) {
  const reason = String(runtimeData.halted_reason || '').toLowerCase();
  if (!reason) return 'unknown';
  if (
    reason.includes('consecutive_losses_limit') ||
    reason.includes('daily_pnl_limit') ||
    reason.includes('win_rate_below_threshold') ||
    reason.includes('auto_audit')
  ) {
    return 'firestore_runtime_config';
  }
  if (reason.includes('risk_guard') || reason.includes('adaptive')) return 'adaptive_risk_guard';
  if (reason.includes('discipline') || reason.includes('entry_quality') || reason.includes('execution_guard')) {
    return 'execution_discipline';
  }
  if (reason.includes('manual')) return 'manual_halt';
  return 'unknown';
}

function resolveDiagnosis(context = {}) {
  if (!context.runtimeStatus || context.runtimeStatus !== 'HALTED') return 'manual_review_required';
  if (context.haltSource === 'manual_halt' || context.haltSource === 'unknown') return 'manual_review_required';
  if (!context.triggerWindowValid) return 'halt_misconfigured';
  if (context.conditionStillActive) return 'halt_valid';
  return 'halt_stale';
}

async function getExecutionHaltDiagnostic(db) {
  const runtimeDoc = await db.collection('system_runtime_config').doc('bot_execution').get();
  const runtimeData = runtimeDoc.exists ? (runtimeDoc.data() || {}) : {};
  const runtimeStatus = String(runtimeData.status || '').toUpperCase() || null;
  const haltedAt = parseDateLike(runtimeData.halted_at) || parseDateLike(runtimeData.updated_at) || null;
  const configuredLimit = Math.max(
    1,
    Number(runtimeData.hard_stops?.consecutive_losses_limit || runtimeData.halted_metrics?.consecutiveLosses || 3)
  );

  const currentWindowStart = startOfUtcDay(new Date());
  const currentWindowEnd = new Date();
  const haltWindowStart = haltedAt ? startOfUtcDay(haltedAt) : currentWindowStart;
  const haltWindowEnd = haltedAt || currentWindowEnd;

  const relevantSince = haltWindowStart < currentWindowStart ? haltWindowStart : currentWindowStart;
  const closedTrades = sortClosedTradesDesc(await loadClosedExecutedIntents(db, {
    limit: 400,
    closedSince: relevantSince
  }));
  const linkedPositions = await loadLinkedPositions(db, closedTrades.slice(0, 20));

  const haltWindowTrades = filterTradesInWindow(closedTrades, haltWindowStart, haltWindowEnd);
  const currentWindowTrades = filterTradesInWindow(closedTrades, currentWindowStart, currentWindowEnd);
  const haltStreak = buildLossStreak(haltWindowTrades, { limit: configuredLimit });
  const currentStreak = buildLossStreak(currentWindowTrades, { limit: configuredLimit });

  const streakLosses = haltStreak.trades;
  const lastLossTrade = streakLosses[0] || null;
  const symbolsInvolved = [...new Set(streakLosses.map((row) => row.symbol || row.intent?.symbol).filter(Boolean))];
  const originsInvolved = [...new Set(streakLosses.map((row) => resolveOrigin(row)).filter(Boolean))];
  const cooldownUntil = parseDateLike(runtimeData.cooldown_until) || null;
  const cooldownActive = Boolean(cooldownUntil && cooldownUntil.getTime() > Date.now());
  const haltSource = resolveHaltSource(runtimeData);
  const triggerWindowValid =
    String(runtimeData.halted_reason || '') === 'consecutive_losses_limit'
      ? haltStreak.current_count >= configuredLimit
      : Boolean(runtimeStatus === 'HALTED');
  const conditionStillActive =
    String(runtimeData.halted_reason || '') === 'consecutive_losses_limit'
      ? currentStreak.current_count >= configuredLimit
      : cooldownActive;

  const recentClosedTrades = closedTrades.slice(0, 10).map((row) => {
    const linkedPosition = linkedPositions.get(row.linked_position_id) || null;
    return {
      trade_id: row.id,
      symbol: row.symbol || row.intent?.symbol || linkedPosition?.symbol || null,
      origin: resolveOrigin(row, linkedPosition),
      side: resolveSide(row, linkedPosition),
      pnl_bruto: resolvePnlBruto(row),
      pnl_neto: resolvePnlNeto(row),
      fees: resolveFees(row),
      close_reason: row.close_reason || row.execution_audit?.close_reason || linkedPosition?.close_reason || null,
      opened_at: resolveTradeOpenedAt(row, linkedPosition)?.toISOString() || null,
      closed_at: resolveTradeClosedAt(row)?.toISOString() || null
    };
  });

  const diagnosis = resolveDiagnosis({
    runtimeStatus,
    haltSource,
    triggerWindowValid,
    conditionStillActive
  });

  return {
    runtime_status: runtimeData.status || null,
    halted_reason: runtimeData.halted_reason || null,
    execution_enabled: runtimeData.execution_enabled !== false,
    auto_trade_mode: runtimeData.auto_trade_mode !== false,
    consecutive_losses: {
      current_count: haltStreak.current_count,
      configured_limit: configuredLimit,
      window_start: haltWindowStart.toISOString(),
      window_end: haltWindowEnd.toISOString(),
      last_loss_ts: resolveTradeClosedAt(lastLossTrade)?.toISOString() || null,
      symbols_involved: symbolsInvolved,
      origins_involved: originsInvolved
    },
    last_closed_trades: recentClosedTrades,
    halt_source: haltSource,
    reset_requirements: {
      requires_manual_reset: runtimeStatus === 'HALTED',
      requires_cooldown: cooldownActive,
      cooldown_until: cooldownUntil?.toISOString() || null,
      safe_to_resume_boolean: !conditionStillActive && !cooldownActive && triggerWindowValid
    },
    diagnosis
  };
}

module.exports = {
  getExecutionHaltDiagnostic
};
