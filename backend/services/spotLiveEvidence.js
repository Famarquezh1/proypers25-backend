'use strict';

const CYCLES = 'real_spot_cycle_decisions';
const EVENTS = 'real_spot_activity_events';
const SCHEDULER = 'real_spot_scheduler_runs';

function nowIso() { return new Date().toISOString(); }
function finite(value, fallback = null) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function text(...values) { const value = values.find((item) => item !== undefined && item !== null && String(item).trim()); return value === undefined ? null : String(value); }
function plain(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item && typeof item.toDate === 'function') return item.toDate().toISOString();
    return item;
  }));
}
function schedulerIntervalMinutes(config = {}) {
  const configured = finite(config.spot_cycle_interval_minutes ?? process.env.SPOT_REAL_CYCLE_INTERVAL_MINUTES, 15);
  return Math.max(1, configured || 15);
}
function addMinutes(iso, minutes) { return new Date(new Date(iso).getTime() + minutes * 60000).toISOString(); }

function blockerDetails({ reconciliation = {}, exits = {}, adaptiveGate = {}, promotionGate = {}, paperGate = {}, autonomy = {}, config = {}, startedAt }) {
  const blockers = [];
  const push = (component, active, reason, missingCondition, since) => {
    if (active) blockers.push({ component, reason, missing_condition: missingCondition, since: since || startedAt || nowIso() });
  };
  push('Reconciliation', reconciliation.account_consistent !== true || reconciliation.entries_blocked === true || config.reconciliation_required === true || config.account_consistent === false,
    reconciliation.reason || config.entry_block_reason || 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED', 'Binance y Firestore deben quedar consistentes y entries_blocked=false', reconciliation.created_at || config.updated_at);
  const failure = Array.isArray(exits.failures) ? exits.failures[0] : null;
  push('Exit Engine', exits.blocked === true || exits.ok === false || exits.exit_engine_healthy === false || (Array.isArray(exits.failures) && exits.failures.length > 0),
    text(failure?.reason, failure?.code, failure?.message, 'EXIT_ENGINE_NOT_HEALTHY'), 'Una evaluación completa de salidas debe terminar sin fallos', failure?.created_at || exits.updated_at);
  push('Adaptive Strategy', adaptiveGate.allowed === false, text(...(adaptiveGate.reasons || []), adaptiveGate.reason, 'ADAPTIVE_STRATEGY_DEGRADED'),
    text(adaptiveGate.missing_condition, 'La estrategia adaptativa debe marcar allowed=true'), adaptiveGate.updated_at);
  push('Strategy Promotion', promotionGate.allowed !== true, text(...(promotionGate.reasons || []), promotionGate.reason, promotionGate.state, 'STRATEGY_NOT_PROMOTED'),
    text(promotionGate.missing_condition, 'Debe existir una estrategia promovida y elegible'), promotionGate.updated_at || promotionGate.created_at);
  push('Paper → Real', paperGate.skipped !== true && paperGate.allowed !== true, text(...(paperGate.reasons || []), paperGate.reason, 'PAPER_REAL_ENTRY_GATE_BLOCKED'),
    text(paperGate.missing_condition, 'La muestra Paper y sus métricas deben superar el gate'), paperGate.updated_at || paperGate.created_at);
  push('Autonomy', autonomy.should_halt === true, autonomy.halt_reason || 'AUTONOMY_HALTED', 'Las guardias autónomas deben liberar el halt', autonomy.updated_at);
  push('Configuration', config.enabled !== true || config.kill_switch === true || config.new_entries_enabled !== true || config.auto_order_execution !== true || config.real_sells_enabled !== true,
    config.entry_block_reason || (config.kill_switch ? 'KILL_SWITCH_ACTIVE' : 'REAL_SPOT_CONFIGURATION_BLOCKED'), 'Motor, entradas, ejecución automática y ventas reales deben estar habilitados', config.updated_at);
  return blockers;
}

async function persistActivity(db, event) {
  const payload = plain({ event_type: event.event_type || event.type || 'UNKNOWN', source: event.source || 'BACKEND', created_at: event.created_at || nowIso(), ...event });
  const ref = await db.collection(EVENTS).add(payload);
  return { id: ref.id, ...payload };
}

async function persistCycleEvidence(db, input) {
  const completedAt = input.completed_at || nowIso();
  const interval = schedulerIntervalMinutes(input.config || {});
  const cycle = plain({
    ...input.decision,
    started_at: input.started_at,
    completed_at: completedAt,
    scheduler: {
      started_at: input.started_at,
      completed_at: completedAt,
      duration_ms: finite(input.duration_ms, 0),
      result: input.error ? 'FAILED' : (input.decision?.decision || 'COMPLETED'),
      next_execution_at: addMinutes(input.started_at, interval),
      interval_minutes: interval,
      error: input.error || null
    },
    blockers: blockerDetails({ ...input, startedAt: input.started_at }),
    reconciliation: input.reconciliation || null,
    exits: input.exits || null,
    entries: input.entries || null,
    adaptive_gate: input.adaptiveGate || null,
    promotion_gate: input.promotionGate || null,
    paper_gate: input.paperGate || null,
    autonomy: input.autonomy || null,
    config_snapshot: input.config || null
  });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await Promise.all([
    db.collection(CYCLES).doc(id).set(cycle),
    db.collection(SCHEDULER).doc(id).set(cycle.scheduler),
    persistActivity(db, { event_type: 'SCHEDULER', source: 'CLOUD_SCHEDULER', created_at: completedAt, cycle_id: id, result: cycle.scheduler.result, duration_ms: cycle.scheduler.duration_ms, error: cycle.scheduler.error }),
    persistActivity(db, { event_type: 'RECONCILIATION', source: 'BACKEND', created_at: completedAt, cycle_id: id, result: input.reconciliation?.account_consistent === true ? 'PASS' : 'BLOCK', details: input.reconciliation || null })
  ]);
  if (cycle.action === 'BUY') await persistActivity(db, { event_type: 'BUY', source: 'BINANCE_SPOT', created_at: completedAt, cycle_id: id, symbol: cycle.candidate?.symbol || input.entries?.symbol || null, details: input.entries || null });
  if (cycle.action === 'SELL' || cycle.action === 'SELL_AND_BUY') await persistActivity(db, { event_type: 'SELL', source: 'BINANCE_SPOT', created_at: completedAt, cycle_id: id, details: input.exits || null });
  if (cycle.decision === 'FAILED' || input.error) await persistActivity(db, { event_type: 'ERROR', source: 'BACKEND', created_at: completedAt, cycle_id: id, error: input.error || cycle.reason || 'UNKNOWN' });
  return { id, ...cycle };
}

module.exports = { CYCLES, EVENTS, SCHEDULER, blockerDetails, persistActivity, persistCycleEvidence, schedulerIntervalMinutes };
