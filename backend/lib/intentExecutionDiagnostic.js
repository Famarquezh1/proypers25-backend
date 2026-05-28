function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value ?.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date ?.getTime ?.()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function getWindow(options = {}) {
    const until = parseDateLike(options.until) || new Date();
    const sinceExplicit = parseDateLike(options.since);
    const days = Math.max(1, Number(options.days || 0));
    const hours = Math.max(0.1, Number(options.hours || 1));
    const windowMs = sinceExplicit ?
        Math.max(1, until.getTime() - sinceExplicit.getTime()) :
        options.days ?
        days * 24 * 60 * 60 * 1000 :
        hours * 60 * 60 * 1000;

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

function extractReasonCandidates(row = {}) {
    const attemptHistory = row.attempt_history || row.time_aligned_execution ?.attempt_history || [];
    const lastAttempt = attemptHistory[attemptHistory.length - 1] || {};
    return [
        row.reason,
        row.final_reason,
        row.skip_reason,
        row.fail_reason,
        row.last_block_reason,
        row.execution_guard ?.reason,
        row.final_evaluation ?.reason,
        lastAttempt ?.reason,
        lastAttempt ?.validation_reason,
        row.validation ?.reason,
        row.execution_discipline ?.reason,
        row.last_error_message,
        row.error_message
    ].filter((value) => String(value || '').trim().length > 0);
}

function mapKnownExecutionReason(value) {
    const message = String(value || '').trim().toLowerCase();
    if (!message) return 'unknown';
    if (message.includes('net_edge_too_low')) return 'net_edge_too_low';
    if (message.includes('entry_quality')) return 'entry_quality_low';
    if (message.includes('execution_score')) return 'execution_score_low';
    if (message.includes('execution_guard') || message.includes('guard')) return 'execution_guard_blocked';
    if (message.includes('price') || message.includes('deviation')) return 'price_movement_blocked';
    if (message.includes('stop_loss_required')) return 'stop_loss_required';
    if (message.includes('take_profit_required')) return 'take_profit_required';
    if (message.includes('intent_expired') || message.includes('expired')) return 'intent_expired';
    if (message.includes('late_entry_blocked') || message.includes('late_entry')) return 'late_entry_blocked';
    if (message.includes('risk_reward_low')) return 'risk_reward_low';
    if (message.includes('event_quality_gate')) return 'event_quality_gate';
    if (message.includes('confidence_low')) return 'confidence_low';
    if (message.includes('max_concurrent_trades_reached')) return 'max_concurrent_trades_reached';
    if (message.includes('hard_stop_consecutive_losses_limit')) return 'hard_stop_consecutive_losses_limit';
    if (message.includes('orphan_intent_blocked') || message.includes('orphan')) return 'orphan_intent_blocked';
    if (message.includes('exchange_info') && message.includes('timeout')) return 'exchange_info_timeout';
    if (message.includes('order rejected') || message.includes('order_rejected') || message.includes('binance_order_rejected')) return 'binance_order_rejected';
    if (message.includes('insufficient_balance') || message.includes('insufficient margin') || message.includes('insufficient')) return 'insufficient_balance';
    if (message.includes('min_notional_risk_blocked')) return 'min_notional_risk_blocked';
    if (message.includes('min_notional')) return 'min_notional_failed';
    if (message.includes('quantity_invalid') || message.includes('invalid quantity') || message.includes('precision')) return 'quantity_invalid';
    if (message.includes('symbol_rules_missing') || message.includes('exchange info failed') || message.includes('rules missing')) return 'symbol_rules_missing';
    if (message.includes('timeout')) return 'failed_timeout';
    if (message.includes('binance') || message.includes('api') || message.includes('request')) return 'binance_api_error';
    return String(value || '').trim() || 'unknown';
}

function normalizeReason(row = {}) {
    const candidates = extractReasonCandidates(row);
    for (const candidate of candidates) {
        const mapped = mapKnownExecutionReason(candidate);
        if (mapped !== 'unknown') return mapped;
    }
    return candidates[0] ? String(candidates[0]).trim() : 'unknown';
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

function deriveDiagnosis(topReason) {
    const reason = String(topReason || '').toLowerCase();
    if (reason.includes('net_edge_too_low')) return 'net_edge_gate_blocking';
    if (reason.includes('late_entry')) return 'late_entry';
    if (reason.includes('pre_validation')) return 'pre_validation';
    if (reason.includes('protection')) return 'protection_mode';
    if (reason.includes('slippage')) return 'slippage';
    return 'no_execution_conditions';
}

async function getIntentExecutionDiagnostic(db, options = {}) {
    const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
    const { since, until } = getWindow(options);
    const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);

    const intents = rows.filter((row) => {
        const ts = resolveIntentTimestamp(row);
        return ts && ts >= since && ts <= until;
    });

    const counts = {
        intents_total: intents.length,
        executed: 0,
        blocked: 0,
        failed: 0,
        skipped: 0
    };
    const reasons = {};

    for (const row of intents) {
        const status = String(row.status || '').toLowerCase();
        if (status === 'executed') counts.executed += 1;
        else if (status === 'blocked') counts.blocked += 1;
        else if (status === 'failed') counts.failed += 1;
        else if (status === 'skipped') counts.skipped += 1;

        increment(reasons, normalizeReason(row));
    }

    const topReason = topEntries(reasons, 1)[0] ?.key || null;

    return {
        intents_total: counts.intents_total,
        executed: counts.executed,
        blocked: counts.blocked,
        failed: counts.failed,
        skipped: counts.skipped,
        top_block_reason: topReason,
        reasons_breakdown: topEntries(reasons, 20),
        diagnosis: deriveDiagnosis(topReason)
    };
}

module.exports = {
    getIntentExecutionDiagnostic
};