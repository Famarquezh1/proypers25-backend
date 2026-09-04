'use strict';

const { filterBotPerformanceResults } = require('./spotPerformanceClassification');
const { buildLearningProfile } = require('./spotRealLearningPolicy');

const RESULTS_COLLECTION = 'real_spot_execution_results';
const CONTROL_PATH = 'real_spot_config/control';

const BASE_POSITION_USDT = 10;
const RECOVERY_POSITION_USDT = 25;
const GROWTH_POSITION_USDT = 20;
const MAX_INITIAL_POSITION_USDT = 25;
const MAX_OPEN_POSITIONS = 4;
const RECOVERY_MAX_OPEN_POSITIONS = 2;
const RECOVERY_MAX_TOTAL_CAPITAL_USDT = 50;
const LOSS_STREAK_KILL_SWITCH = 3;
const LOSS_STREAK_COOLDOWN_MINUTES = 180;
const MAX_SESSION_LOSS_USDT = 3;
const SESSION_WINDOW_HOURS = 24;
const PERFORMANCE_RECOVERY_MIN_TRADES = 10;
const PERFORMANCE_RECOVERY_MAX_WIN_RATE_PCT = 35;
const GROWTH_MIN_TRADES = 12;
const GROWTH_MIN_WIN_RATE_PCT = 45;
const GROWTH_MIN_PROFIT_FACTOR = 1.15;

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function closedAtMillis(result) {
  const value = result.closed_at || result.updated_at || result.created_at || 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function buildPerformanceRecoveryState({ completedTrades = 0, totalPnl = 0, winRate = 0 } = {}) {
  const sampleReady = Number(completedTrades) >= PERFORMANCE_RECOVERY_MIN_TRADES;
  const negativePnl = Number(totalPnl) < 0;
  const weakWinRate = Number(winRate) < PERFORMANCE_RECOVERY_MAX_WIN_RATE_PCT;
  const active = sampleReady && negativePnl && weakWinRate;
  return {
    performance_recovery_mode: active,
    performance_recovery_reason: active ? 'RECENT_REAL_PERFORMANCE_DEGRADED' : null,
    performance_recovery_min_trades: PERFORMANCE_RECOVERY_MIN_TRADES,
    performance_recovery_max_win_rate_pct: PERFORMANCE_RECOVERY_MAX_WIN_RATE_PCT,
    performance_recovery_position_usdt: active ? RECOVERY_POSITION_USDT : BASE_POSITION_USDT
  };
}

function buildGrowthState({ completedTrades = 0, totalPnl = 0, winRate = 0, profitFactor = 0, recoveryMode = false } = {}) {
  const active = recoveryMode !== true &&
    Number(completedTrades) >= GROWTH_MIN_TRADES &&
    Number(totalPnl) > 0 &&
    Number(winRate) >= GROWTH_MIN_WIN_RATE_PCT &&
    Number(profitFactor) >= GROWTH_MIN_PROFIT_FACTOR;
  return {
    growth_mode: active,
    growth_position_usdt: active ? GROWTH_POSITION_USDT : BASE_POSITION_USDT,
    growth_min_trades: GROWTH_MIN_TRADES,
    growth_min_win_rate_pct: GROWTH_MIN_WIN_RATE_PCT,
    growth_min_profit_factor: GROWTH_MIN_PROFIT_FACTOR
  };
}

function buildAutonomyHaltState({ consecutiveLosses = 0, totalPnl = 0, latestClosedAt = 0, now = new Date() } = {}) {
  const nowMsRaw = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : Date.now();
  const latestClosedAtMs = asNumber(latestClosedAt, 0);
  const lossStreakTriggered = Number(consecutiveLosses) >= LOSS_STREAK_KILL_SWITCH;
  const cooldownUntilMs = lossStreakTriggered && latestClosedAtMs > 0
    ? latestClosedAtMs + (LOSS_STREAK_COOLDOWN_MINUTES * 60 * 1000)
    : 0;
  const lossStreakCooldownActive = lossStreakTriggered && (
    latestClosedAtMs <= 0 || cooldownUntilMs > nowMs
  );
  const maxSessionLossReached = Number(totalPnl) <= -MAX_SESSION_LOSS_USDT;

  return {
    should_halt: maxSessionLossReached || lossStreakCooldownActive,
    halt_reason: maxSessionLossReached
      ? 'MAX_SESSION_LOSS_REACHED'
      : lossStreakCooldownActive
        ? 'THREE_CONSECUTIVE_LOSSES'
        : null,
    loss_streak_triggered: lossStreakTriggered,
    loss_streak_cooldown_active: lossStreakCooldownActive,
    loss_streak_cooldown_minutes: LOSS_STREAK_COOLDOWN_MINUTES,
    loss_streak_cooldown_until: cooldownUntilMs > 0 ? new Date(cooldownUntilMs).toISOString() : null,
    max_session_loss_reached: maxSessionLossReached
  };
}

async function buildAutonomySnapshot(db, now = new Date()) {
  const snapshot = await db.collection(RESULTS_COLLECTION).get();
  const trades = filterBotPerformanceResults(
    snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  ).sort((a, b) => closedAtMillis(b) - closedAtMillis(a));

  const recent = trades.slice(0, 30);
  const recentTotalPnl = recent.reduce((sum, trade) => sum + asNumber(trade.net_pnl_usdt), 0);
  const wins = recent.filter((trade) => asNumber(trade.net_pnl_usdt) > 0).length;
  const losses = recent.filter((trade) => asNumber(trade.net_pnl_usdt) < 0).length;
  const grossProfit = recent.reduce((sum, trade) => sum + Math.max(0, asNumber(trade.net_pnl_usdt)), 0);
  const grossLoss = Math.abs(recent.reduce((sum, trade) => sum + Math.min(0, asNumber(trade.net_pnl_usdt)), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  let consecutiveLosses = 0;
  for (const trade of recent) {
    if (asNumber(trade.net_pnl_usdt) < 0) consecutiveLosses += 1;
    else break;
  }

  const completedTrades = wins + losses;
  const winRate = completedTrades > 0 ? (wins / completedTrades) * 100 : 0;
  const latestClosedAt = recent.length ? closedAtMillis(recent[0]) : 0;
  const nowMsRaw = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : Date.now();
  const sessionCutoff = nowMs - (SESSION_WINDOW_HOURS * 60 * 60 * 1000);
  const sessionTrades = trades.filter((trade) => closedAtMillis(trade) >= sessionCutoff);
  const sessionPnl = sessionTrades.reduce((sum, trade) => sum + asNumber(trade.net_pnl_usdt), 0);
  const haltState = buildAutonomyHaltState({ consecutiveLosses, totalPnl: sessionPnl, latestClosedAt, now });
  const recoveryState = buildPerformanceRecoveryState({ completedTrades, totalPnl: recentTotalPnl, winRate });
  const growthState = buildGrowthState({ completedTrades, totalPnl: recentTotalPnl, winRate, profitFactor, recoveryMode: recoveryState.performance_recovery_mode });
  const learningProfile = buildLearningProfile(trades);
  const currentStage = recoveryState.performance_recovery_mode
    ? 'RECOVERY_25_USDT'
    : growthState.growth_mode
      ? 'GROWTH_20_USDT'
      : 'CONTROLLED_10_USDT';
  const recommendedPosition = recoveryState.performance_recovery_mode
    ? RECOVERY_POSITION_USDT
    : growthState.growth_mode
      ? GROWTH_POSITION_USDT
      : BASE_POSITION_USDT;

  return {
    completed_trades: completedTrades,
    wins,
    losses,
    win_rate_pct: Number(winRate.toFixed(2)),
    recent_net_pnl_usdt: Number(recentTotalPnl.toFixed(8)),
    recent_profit_factor: Number(profitFactor.toFixed(4)),
    session_window_hours: SESSION_WINDOW_HOURS,
    session_trade_count: sessionTrades.length,
    session_net_pnl_usdt: Number(sessionPnl.toFixed(8)),
    consecutive_losses: consecutiveLosses,
    latest_trade_closed_at: latestClosedAt > 0 ? new Date(latestClosedAt).toISOString() : null,
    ...haltState,
    ...recoveryState,
    ...growthState,
    learning_profile: learningProfile,
    current_stage: currentStage,
    recommended_position_usdt: recommendedPosition,
    scale_up_locked: growthState.growth_mode !== true,
    next_stage_requirement: `${GROWTH_MIN_TRADES} cierres recientes, PnL neto positivo, win rate >= ${GROWTH_MIN_WIN_RATE_PCT}% y profit factor >= ${GROWTH_MIN_PROFIT_FACTOR}`
  };
}

function buildAutonomyControlPatch(currentConfig = {}, snapshot = {}, now = new Date().toISOString()) {
  const recoveryMode = snapshot.performance_recovery_mode === true;
  const growthMode = snapshot.growth_mode === true && !recoveryMode;
  const effectivePositionUsdt = recoveryMode
    ? RECOVERY_POSITION_USDT
    : growthMode
      ? GROWTH_POSITION_USDT
      : BASE_POSITION_USDT;
  const effectiveMaxOpenPositions = recoveryMode ? RECOVERY_MAX_OPEN_POSITIONS : MAX_OPEN_POSITIONS;
  const effectiveTotalCapitalUsdt = recoveryMode
    ? RECOVERY_MAX_TOTAL_CAPITAL_USDT
    : effectivePositionUsdt * effectiveMaxOpenPositions;
  const patch = {
    autonomy_enabled: true,
    autonomy_stage: snapshot.current_stage || (recoveryMode ? 'RECOVERY_25_USDT' : growthMode ? 'GROWTH_20_USDT' : 'CONTROLLED_10_USDT'),
    performance_recovery_mode: recoveryMode,
    performance_recovery_reason: snapshot.performance_recovery_reason || null,
    growth_mode: growthMode,
    adaptive_position_usdt: effectivePositionUsdt,
    max_position_usdt: Math.min(MAX_INITIAL_POSITION_USDT, effectivePositionUsdt),
    max_total_capital_usdt: effectiveTotalCapitalUsdt,
    max_open_positions: effectiveMaxOpenPositions,
    spot_only: true,
    futures_allowed: false,
    margin_allowed: false,
    leverage_allowed: false,
    withdrawals_allowed: false,
    autonomy_last_evaluated_at: now,
    autonomy_snapshot: snapshot
  };

  if (snapshot.should_halt === true) {
    patch.kill_switch = true;
    patch.new_entries_enabled = false;
    patch.autonomy_halt_reason = snapshot.halt_reason;
    patch.autonomy_halted_at = currentConfig.autonomy_halted_at || now;
    patch.autonomy_resume_after = snapshot.loss_streak_cooldown_until || null;
    return patch;
  }

  const staleAutonomyHalt = Boolean(currentConfig.autonomy_halt_reason);
  if (!staleAutonomyHalt) return patch;

  patch.autonomy_halt_reason = null;
  patch.autonomy_released_at = now;
  patch.autonomy_halted_at = null;
  patch.autonomy_resume_after = null;
  if (currentConfig.manual_kill_switch !== true) patch.kill_switch = false;

  const manualPause = currentConfig.manual_entry_pause === true || currentConfig.entries_paused_manually === true;
  const reconciliationBlocked = currentConfig.reconciliation_required === true ||
    currentConfig.account_consistent === false ||
    currentConfig.entry_block_reason === 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED';
  const otherBlock = Boolean(
    currentConfig.entry_block_reason &&
    currentConfig.entry_block_reason !== 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED'
  );
  if (
    currentConfig.enabled === true &&
    currentConfig.manual_kill_switch !== true &&
    !manualPause &&
    !reconciliationBlocked &&
    !otherBlock
  ) {
    patch.new_entries_enabled = true;
  }
  return patch;
}

async function enforceAutonomousSafety(db, currentConfig = {}) {
  const nowDate = new Date();
  const snapshot = await buildAutonomySnapshot(db, nowDate);
  const controlRef = db.doc(CONTROL_PATH);
  const now = nowDate.toISOString();
  const patch = buildAutonomyControlPatch(currentConfig, snapshot, now);

  await controlRef.set(patch, { merge: true });

  return {
    ...snapshot,
    applied: true,
    autonomy_halt_released: snapshot.should_halt !== true && Boolean(currentConfig.autonomy_halt_reason),
    effective_position_usdt: patch.max_position_usdt,
    effective_total_capital_usdt: patch.max_total_capital_usdt,
    effective_max_open_positions: patch.max_open_positions
  };
}

module.exports = {
  buildAutonomySnapshot,
  buildAutonomyHaltState,
  buildPerformanceRecoveryState,
  buildGrowthState,
  buildAutonomyControlPatch,
  enforceAutonomousSafety,
  BASE_POSITION_USDT,
  RECOVERY_POSITION_USDT,
  GROWTH_POSITION_USDT,
  MAX_INITIAL_POSITION_USDT,
  MAX_OPEN_POSITIONS,
  RECOVERY_MAX_OPEN_POSITIONS,
  RECOVERY_MAX_TOTAL_CAPITAL_USDT,
  LOSS_STREAK_COOLDOWN_MINUTES,
  SESSION_WINDOW_HOURS,
  PERFORMANCE_RECOVERY_MIN_TRADES,
  PERFORMANCE_RECOVERY_MAX_WIN_RATE_PCT,
  GROWTH_MIN_TRADES,
  GROWTH_MIN_WIN_RATE_PCT,
  GROWTH_MIN_PROFIT_FACTOR
};
