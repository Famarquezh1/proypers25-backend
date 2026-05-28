const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MAX_DOCS = 2000;

function toNumber(value, fallback = null) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, decimals = 4) {
    const numeric = toNumber(value, null);
    if (numeric === null) return null;
    return Number(numeric.toFixed(decimals));
}

function average(values = []) {
    const finite = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!finite.length) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

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
    const hours = Math.max(1, Number(options.hours || DEFAULT_WINDOW_HOURS));
    return {
        since: sinceExplicit || new Date(until.getTime() - (hours * 60 * 60 * 1000)),
        until
    };
}

function resolveShadowTimestamp(row = {}) {
    return (
        parseDateLike(row.shadow_validation ?.evaluated_at) ||
        parseDateLike(row.updated_at) ||
        parseDateLike(row.created_at) ||
        null
    );
}

function getShadowHorizon(row = {}, minutes) {
    const horizons = Array.isArray(row.shadow_validation ?.horizons) ? row.shadow_validation.horizons : [];
    return horizons.find((horizon) => Number(horizon ?.horizon_minutes || 0) === Number(minutes)) || null;
}

function getShadowSummary(row = {}) {
    const shadow = row.shadow_validation || {};
    return {
        gross_move_pct: toNumber(shadow.gross_move_pct, null),
        estimated_net_edge_pct: toNumber(shadow.estimated_net_edge_pct, null),
        profitable_after_fees: shadow.profitable_after_fees === true,
        max_favorable_move_pct: toNumber(shadow.max_favorable_move_pct, null),
        max_adverse_move_pct: toNumber(shadow.max_adverse_move_pct, null)
    };
}

function buildRate(numerator, denominator) {
    if (!denominator) return null;
    return round((numerator / denominator) * 100, 2);
}

function buildGroupSummary(rows = []) {
    const summaries = rows.map(getShadowSummary);
    const profitableCount = summaries.filter((summary) => summary.profitable_after_fees === true).length;
    return {
        count: rows.length,
        avg_gross_move_pct: round(average(summaries.map((summary) => summary.gross_move_pct)), 6),
        avg_estimated_net_edge_pct: round(average(summaries.map((summary) => summary.estimated_net_edge_pct)), 6),
        profitable_after_fees_count: profitableCount,
        profitable_after_fees_rate: buildRate(profitableCount, rows.length),
        avg_max_favorable_move_pct: round(average(summaries.map((summary) => summary.max_favorable_move_pct)), 6),
        avg_max_adverse_move_pct: round(average(summaries.map((summary) => summary.max_adverse_move_pct)), 6)
    };
}

function buildBreakdown(rows = [], keyResolver) {
    const groups = new Map();
    for (const row of rows) {
        const key = String(keyResolver(row) || 'unknown');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    return Array.from(groups.entries())
        .map(([key, groupRows]) => ({
            key,
            ...buildGroupSummary(groupRows)
        }))
        .sort((left, right) => {
            const edgeDiff = Number(right.avg_estimated_net_edge_pct || 0) - Number(left.avg_estimated_net_edge_pct || 0);
            if (Math.abs(edgeDiff) > 0.000001) return edgeDiff;
            return Number(right.count || 0) - Number(left.count || 0);
        });
}

function buildSymbolRanking(rows = [], direction = 'best') {
    const breakdown = buildBreakdown(rows, (row) => row.symbol || row.simbolo || 'unknown')
        .filter((row) => row.key && row.key !== 'unknown');
    const sorted = breakdown.sort((left, right) => {
        const multiplier = direction === 'worst' ? 1 : -1;
        const edgeDiff = (Number(left.avg_estimated_net_edge_pct || 0) - Number(right.avg_estimated_net_edge_pct || 0)) * multiplier;
        if (Math.abs(edgeDiff) > 0.000001) return edgeDiff;
        return Number(right.count || 0) - Number(left.count || 0);
    });
    return sorted.slice(0, 5);
}

function deriveConclusion(report = {}) {
    if (!Number(report.total_signals_evaluated || 0)) {
        return 'insufficient_shadow_data';
    }
    if (Number(report.avg_estimated_net_edge_pct || 0) > 0 && Number(report.profitable_after_fees_rate || 0) >= 55) {
        return 'positive_edge_after_fees';
    }
    if (Number(report.avg_gross_move_pct || 0) > 0 && Number(report.avg_estimated_net_edge_pct || 0) <= 0) {
        return 'gross_edge_eroded_by_fees';
    }
    return 'no_reliable_edge_after_fees';
}

async function getShadowValidationDiagnostic(db, options = {}) {
    const maxDocs = Math.max(100, Math.min(Number(options.maxDocs || DEFAULT_MAX_DOCS), 5000));
    const { since, until } = getWindow(options);
    const snapshot = await db.collection('velas_predicciones').orderBy('updated_at', 'desc').limit(maxDocs).get();
    const rows = snapshot.docs
        .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
        .filter((row) => row.shadow_validation && Array.isArray(row.shadow_validation.horizons))
        .filter((row) => {
            const ts = resolveShadowTimestamp(row);
            return ts && ts >= since && ts <= until;
        })
        .filter((row) => row.shadow_validation.horizons.length > 0);

    const horizonMinutes = [1, 3, 5, 10];
    const horizonStats = Object.fromEntries(
        horizonMinutes.map((minutes) => {
            const horizonRows = rows
                .map((row) => ({ row, horizon: getShadowHorizon(row, minutes) }))
                .filter((item) => item.horizon);
            const correctCount = horizonRows.filter((item) => item.horizon.direction_correct === true).length;
            return [minutes, {
                count: horizonRows.length,
                win_rate_direction: buildRate(correctCount, horizonRows.length)
            }];
        })
    );

    const summary = buildGroupSummary(rows);
    const report = {
        window: {
            since: since.toISOString(),
            until: until.toISOString(),
            hours: round((until.getTime() - since.getTime()) / (60 * 60 * 1000), 2)
        },
        total_signals_evaluated: rows.length,
        win_rate_direction_1m: horizonStats[1].win_rate_direction,
        win_rate_direction_3m: horizonStats[3].win_rate_direction,
        win_rate_direction_5m: horizonStats[5].win_rate_direction,
        win_rate_direction_10m: horizonStats[10].win_rate_direction,
        avg_gross_move_pct: summary.avg_gross_move_pct,
        avg_estimated_net_edge_pct: summary.avg_estimated_net_edge_pct,
        profitable_after_fees_count: summary.profitable_after_fees_count,
        profitable_after_fees_rate: summary.profitable_after_fees_rate,
        avg_max_favorable_move_pct: summary.avg_max_favorable_move_pct,
        avg_max_adverse_move_pct: summary.avg_max_adverse_move_pct,
        best_symbols: buildSymbolRanking(rows, 'best'),
        worst_symbols: buildSymbolRanking(rows, 'worst'),
        by_symbol: buildBreakdown(rows, (row) => row.symbol || row.simbolo || 'unknown'),
        by_timeframe: buildBreakdown(rows, (row) => row.timeframe || 'unknown'),
        by_direction: buildBreakdown(rows, (row) => row.direction || 'unknown'),
        by_confidence_bucket: buildBreakdown(rows, (row) => row.shadow_validation ?.confidence_bucket || 'unknown'),
        by_expected_move_bucket: buildBreakdown(rows, (row) => row.shadow_validation ?.expected_move_bucket || 'unknown'),
        by_signal_state: buildBreakdown(rows, (row) => row.shadow_validation ?.signal_state || 'unknown')
    };

    report.conclusion = deriveConclusion(report);
    return report;
}

module.exports = {
    getShadowValidationDiagnostic
};