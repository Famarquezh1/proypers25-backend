'use strict';

const { filterBotPerformanceResults } = require('./spotPerformanceClassification');

const RESULTS_COLLECTION = 'real_spot_execution_results';
const CONTROL_PATH = 'real_spot_config/control';

const BASE_POSITION_USDT = 10;
const MAX_INITIAL_POSITION_USDT = 10;
const MAX_OPEN_POSITIONS = 1;
const LOSS_STREAK_KILL_SWITCH = 3;
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

async function buildAutonomySnapshot(db) {
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
  const shouldHalt = consecutiveLosses >= LOSS_STREAK_KILL_SWITCH || totalPnl <= -MAX_SESSION_LOSS_USDT;

  return {
    completed_trades: completedTrades,
    wins,
    losses,
    win_rate_pct: Number(winRate.toFixed(2)),
    recent_net_pnl_usdt: Number(totalPnl.toFixed(8)),
    consecutive_losses: consecutiveLosses,
    should_halt: shouldHalt,
    halt_reason: consecutiveLosses >= LOSS_STREAK_KILL_SWITCH
      ? 'THREE_CONSECUTIVE_LOSSES'
      : totalPnl <= -MAX_SESSION_LOSS_USDT
        ? 'MAX_SESSION_LOSS_REACHED'
        : null,
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
    patch.autonomy_halted_at = now;
    return patch;
  }

  const staleAutonomyHalt = Boolean(currentConfig.autonomy_halt_reason);
  if (!staleAutonomyHalt) return patch;

  // Release only a halt that the autonomy controller itself created. A manual
  // kill switch remains protected when explicitly marked as manual.
  patch.autonomy_halt_reason = null;
  patch.autonomy_released_at = now;
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
  const snapshot = await buildAutonomySnapshot(db);
  const controlRef = db.doc(CONTROL_PATH);
  const now = new Date().toISOString();
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
  buildAutonomyControlPatch,
  enforceAutonomousSafety,
  BASE_POSITION_USDT,
  MAX_INITIAL_POSITION_USDT
};
