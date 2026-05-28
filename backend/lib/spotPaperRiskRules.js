const PAPER_ONLY_LOCK = true;
const ELIGIBLE_CATEGORIES = new Set(['MOMENTUM', 'BREAKOUT', 'ACCUMULATION']);
const MIN_OPPORTUNITY_SCORE = 70;
const MAX_SIMULATED_CAPITAL_USDT = 100;
const MAX_OPEN_POSITIONS = 3;
const MAX_OPEN_POSITIONS_PER_SYMBOL = 1;
const STOP_LOSS_PCT = -5;
const TAKE_PROFIT_LEVELS = [
    { label: 'TP1', target_pct: 5 },
    { label: 'TP2', target_pct: 10 }
];
const TIMEOUT_HOURS = 24;
const ESTIMATED_FEE_PCT = 0.1;

function round(value, decimals = 4) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Number(numeric.toFixed(decimals));
}

function average(values = []) {
    const finite = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!finite.length) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function isEligiblePaperCategory(category) {
    return ELIGIBLE_CATEGORIES.has(String(category || '').toUpperCase());
}

function buildTakeProfitLevels(entryPrice) {
    const price = Number(entryPrice);
    return TAKE_PROFIT_LEVELS.map((level) => ({
        label: level.label,
        target_pct: level.target_pct,
        target_price: round(price * (1 + (level.target_pct / 100)), 8)
    }));
}

function summarizePositiveValidation(validation = {}) {
    const horizons = validation && typeof validation === 'object' ? validation.horizons || {} : {};
    const completed = ['h1', 'h4', 'h12']
        .map((key) => horizons[key])
        .filter((item) => item && item.status === 'completed');

    const positiveCompleted = completed.filter((item) => (
        Number(item.variation_pct || 0) > 0 ||
        Number(item.max_favorable_move_pct || 0) >= 3 ||
        item.hit_plus_5_pct === true
    ));

    const strongest = completed.sort((left, right) => {
        const rightValue = Number(right.max_favorable_move_pct || 0);
        const leftValue = Number(left.max_favorable_move_pct || 0);
        if (Math.abs(rightValue - leftValue) > 0.000001) return rightValue - leftValue;
        return Number(right.variation_pct || 0) - Number(left.variation_pct || 0);
    })[0] || null;

    return {
        completed_count: completed.length,
        positive_completed_count: positiveCompleted.length,
        positive: completed.length === 0 ? true : positiveCompleted.length > 0,
        strongest_horizon: strongest ? strongest.label || null : null,
        strongest_favorable_move_pct: strongest ? round(strongest.max_favorable_move_pct, 4) : null,
        strongest_variation_pct: strongest ? round(strongest.variation_pct, 4) : null
    };
}

function buildPaperExecutionConclusion(summary = {}) {
    const closed = Number(summary.closed_paper_positions || 0);
    const open = Number(summary.open_paper_positions || 0);
    const netPnl = Number(summary.total_net_pnl_usdt || 0);
    const winRate = Number(summary.win_rate || 0);

    if (!closed && open > 0) {
        return 'Paper execution is active, but closed paper positions are not available yet.';
    }
    if (!closed) {
        return 'Paper execution has not created closed paper positions yet.';
    }
    if (netPnl > 0 && winRate >= 50) {
        return 'Paper execution is net positive with a constructive win rate in the current sample.';
    }
    if (netPnl > 0) {
        return 'Paper execution is net positive, but the sample still needs more closed trades.';
    }
    return 'Paper execution is active, but the current closed sample is net negative.';
}

module.exports = {
    PAPER_ONLY_LOCK,
    ELIGIBLE_CATEGORIES,
    MIN_OPPORTUNITY_SCORE,
    MAX_SIMULATED_CAPITAL_USDT,
    MAX_OPEN_POSITIONS,
    MAX_OPEN_POSITIONS_PER_SYMBOL,
    STOP_LOSS_PCT,
    TAKE_PROFIT_LEVELS,
    TIMEOUT_HOURS,
    ESTIMATED_FEE_PCT,
    round,
    average,
    isEligiblePaperCategory,
    buildTakeProfitLevels,
    summarizePositiveValidation,
    buildPaperExecutionConclusion
};