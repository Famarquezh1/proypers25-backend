'use strict';

const { filterBotPerformanceResults } = require('./spotPerformanceClassification');

const RESULTS_COLLECTION = 'real_spot_execution_results';
const CONTROL_PATH = 'real_spot_config/control';

const BASE_POSITION_USDT = 10;
const MAX_INITIAL_POSITION_USDT = 10;
const MAX_OPEN_POSITIONS = 1;
const LOSS_STREAK_KILL_SWITCH = 3;
const LOSS_STREAK_COOLDOWN_MINUTES = 180;
const MAX_SESSION_LOSS_USDT = 3;

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function closedAtMillis(result) {
  const value = result.closed_at || result.updated_at || result.created_at || 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function buildAutonomyHaltState({ consecutiveLosses = 0, totalPnl = 0, latestClosedAt = 0, now = new Date() } = {}) {
  const nowMsRaw = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const nowMs = Number.isFinite(nowMsRaw) ? nowMsRaw : Date.now();
  const latestClosedAtMs = asNumber(latestClosedAt, 0);
  const lossStreakTriggered = Number(consecutiveLosses) >= LOSS_STREAK_KILL_SWITCH;
  const cooldownUntilMs = lossStreakTriggered && latestClosedAtMs > 0
    ? latestClosedAtMs + (LOSS_STREAK_COOLDOWN_MINUTES * 60 * 1000)
    : 0;
  // If a legacy result has no usable close timestamp, fail safe and keep the
  // loss-streak halt active rather than silently releasing it.
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
  const totalPnl = recent.reduce((sum, trade) => sum + asNumber(trade.net_pnl_usdt), 0);
  const wins = recent.filter((trade) => asNumber(trade.net_pnl_usdt) > 0).length;
  const losses = recent.filter((trade) => asNumber(trade.net_pnl_usdt) < 0).length;

  let consecutiveLosses = 0;
  for (const trade of recent) {
    if (asNumber(trade.net_pnl_usdt) < 0) consecutiveLosses += 1;
    else break;
  }

  const completedTrades = wins + losses;
  const winRate = completedTrades > 0 ? (wins / completedTrades) * 100 : 0;
  const latestClosedAt = recent.length ? closedAtMillis(recent[0]) : 0;
  const haltState = buildAutonomyHaltState({
    consecutiveLosses,
    totalPnl,
    latestClosedAt,
    now
  });

  return {
    completed_trades: completedTrades,
    wins,
    losses,
    win_rate_pct: Number(winRate.toFixed(2)),
    recent_net_pnl_usdt: Number(totalPnl.toFixed(8)),
    consecutive_losses: consecutiveLosses,
    latest_trade_closed_at: latestClosedAt > 0 ? new Date(latestClosedAt).toISOString() : null,
    ...haltState,
    current_stage: 'CONTROLLED_10_USDT',
    recommended_position_usdt: BASE_POSITION_USDT,
    scale_up_locked: completedTrades < 10 || totalPnl <= 0 || winRate < 50,
    next_stage_requirement: '10 cierres, PnL neto positivo y win rate mínimo de 50%'
  };
}

function buildAutonomyControlPatch(currentConfig = {}, snapshot = {}, now = new Date().toISOString()) {
  const patch = {
    autonomy_enabled: true,
    autonomy_stage: snapshot.current_stage || 'CONTROLLED_10_USDT',
    adaptive_position_usdt: BASE_POSITION_USDT,
    max_position_usdt: Math.min(
      Math.max(asNumber(currentConfig.max_position_usdt, BASE_POSITION_USDT), BASE_POSITION_USDT),
      MAX_INITIAL_POSITION_USDT
    ),
    max_total_capital_usdt: MAX_INITIAL_POSITION_USDT,
    max_open_positions: MAX_OPEN_POSITIONS,
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

  // Release only a halt that the autonomy controller itself created. A manual
  // kill switch remains protected when explicitly marked as manual.
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
  buildAutonomyControlPatch,
  enforceAutonomousSafety,
  BASE_POSITION_USDT,
  MAX_INITIAL_POSITION_USDT,
  LOSS_STREAK_COOLDOWN_MINUTES
};
