function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function summarizePnL(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return {
    count: 0,
    avg: null,
    expectancy: null,
    total: 0,
    win_rate: null
  };
  const wins = finite.filter((value) => value > 0);
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    avg: total / finite.length,
    expectancy: total / finite.length,
    total,
    win_rate: wins.length / finite.length
  };
}

function resolveLifecyclePhase(row = {}) {
  return String(
    row?.impulse_lifecycle?.lifecycle_phase ||
      row?.impulse_lifecycle?.impulse_state ||
      row?.impulse_state ||
      'unknown'
  );
}

function resolveLegacyLifecycleState(row = {}) {
  const explicit = String(row?.impulse_lifecycle?.impulse_state_legacy || '').trim();
  if (explicit) return explicit;
  const phase = resolveLifecyclePhase(row);
  if (phase === 'expansion') return 'alive';
  if (phase === 'deterioration') return 'dead';
  if (phase === 'evaluation') return 'decaying';
  return 'ignition';
}

function buildReasonStats(comparisons = []) {
  const buckets = new Map();
  for (const item of comparisons) {
    const reason = String(item?.comparison?.shadow_exit_reason || 'unknown');
    if (!buckets.has(reason)) buckets.set(reason, []);
    buckets.get(reason).push(item);
  }
  return [...buckets.entries()].map(([reason, items]) => {
    const pnls = items
      .map((item) => toNumber(item?.comparison?.shadow_exit_pnl_pct))
      .filter(Number.isFinite);
    const wins = pnls.filter((value) => value > 0).length;
    return {
      reason,
      count: items.length,
      win_rate: pnls.length ? Number((wins / pnls.length).toFixed(4)) : null,
      avg_pnl: pnls.length ? Number((average(pnls) || 0).toFixed(4)) : null
    };
  });
}

async function loadRecentClosedPositions(db, options = {}) {
  const maxDocs = Math.max(50, Math.min(4000, Number(options.maxDocs || 500)));
  const days = Math.max(1, Math.min(365, Number(options.days || 30)));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection('binance_open_positions').orderBy('updated_at', 'desc').limit(maxDocs).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => String(row?.status || '').toLowerCase() === 'closed')
    .filter((row) => {
      const closedAt = parseDateLike(row?.closed_at || row?.updated_at);
      return closedAt ? closedAt.getTime() >= since : false;
    });
}

function buildSourceSegmentation(rows = [], valueSelector) {
  const buckets = new Map();
  for (const row of rows) {
    const key = String(row?.source_profile || row?.source || 'unknown');
    if (!buckets.has(key)) buckets.set(key, []);
    const value = valueSelector(row);
    if (value != null) buckets.get(key).push(value);
  }
  return [...buckets.entries()].map(([source_profile, values]) => ({
    source_profile,
    ...summarizePnL(values)
  }));
}

function buildSymbolSegmentation(rows = [], valueSelector) {
  const buckets = new Map();
  for (const row of rows) {
    const key = String(row?.symbol || 'UNKNOWN');
    if (!buckets.has(key)) buckets.set(key, []);
    const value = valueSelector(row);
    if (value != null) buckets.get(key).push(value);
  }
  return [...buckets.entries()]
    .map(([symbol, values]) => ({
      symbol,
      ...summarizePnL(values)
    }))
    .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
    .slice(0, 12);
}

async function getAdaptiveExitSummary(db, options = {}) {
  const rows = await loadRecentClosedPositions(db, options);
  const comparisons = rows
    .map((row) => ({
      row,
      comparison: row?.adaptive_exit_comparison || null
    }))
    .filter((item) => item.comparison?.shadow_available);

  const shadowPnls = comparisons
    .map((item) => toNumber(item.comparison?.shadow_exit_pnl_pct))
    .filter(Number.isFinite);
  const deltaPnls = comparisons
    .map((item) => toNumber(item.comparison?.pnl_delta_pct))
    .filter(Number.isFinite);
  const improved = comparisons.filter((item) => item.comparison?.improved === true).length;
  const worsened = comparisons.filter((item) => item.comparison?.worsened === true).length;
  const noDifference = comparisons.filter((item) => item.comparison?.no_difference === true).length;

  const reasons = comparisons.reduce((acc, item) => {
    const reason = String(item.comparison?.shadow_exit_reason || 'unknown');
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});

  const bySource = buildSourceSegmentation(
    comparisons.map((item) => ({ ...item.row, comparison: item.comparison })),
    (row) => toNumber(row?.adaptive_exit_comparison?.pnl_delta_pct)
  );

  const bySymbol = buildSymbolSegmentation(
    comparisons.map((item) => ({ ...item.row, comparison: item.comparison })),
    (row) => toNumber(row?.adaptive_exit_comparison?.pnl_delta_pct)
  );

  return {
    generated_at: new Date().toISOString(),
    window_days: Math.max(1, Math.min(365, Number(options.days || 30))),
    total_shadow_exits: comparisons.length,
    shadow_win_rate: shadowPnls.length
      ? Number((shadowPnls.filter((value) => value > 0).length / shadowPnls.length).toFixed(4))
      : null,
    shadow_expectancy: shadowPnls.length ? Number((shadowPnls.reduce((sum, value) => sum + value, 0) / shadowPnls.length).toFixed(4)) : null,
    avg_shadow_pnl: shadowPnls.length ? Number(average(shadowPnls).toFixed(4)) : null,
    avg_delta_vs_real_pnl: deltaPnls.length ? Number(average(deltaPnls).toFixed(4)) : null,
    improved_trades_count: improved,
    worsened_trades_count: worsened,
    no_difference_trades_count: noDifference,
    exit_reasons_breakdown: reasons,
    exit_reasons_stats: buildReasonStats(comparisons),
    by_source_profile: bySource,
    top_symbols_by_shadow_delta: bySymbol
  };
}

async function getImpulseLifecycleSummary(db, options = {}) {
  const rows = await loadRecentClosedPositions(db, options);
  const withLifecycle = rows.filter((row) => row?.impulse_lifecycle?.impulse_state);
  const ignitionSuccess = withLifecycle.filter((row) => row?.impulse_lifecycle?.time_to_first_expansion_ms != null).length;
  const deadRows = withLifecycle.filter((row) => resolveLegacyLifecycleState(row) === 'dead');
  const aliveRows = withLifecycle.filter((row) => resolveLegacyLifecycleState(row) === 'alive');
  const phaseDistribution = withLifecycle.reduce((acc, row) => {
    const phase = resolveLifecyclePhase(row);
    acc[phase] = (acc[phase] || 0) + 1;
    return acc;
  }, {});
  const legacyDistribution = withLifecycle.reduce((acc, row) => {
    const state = resolveLegacyLifecycleState(row);
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {});
  const deadLosses = deadRows.filter((row) => String(row?.win_exchange || '') === 'LOSS').length;
  const aliveWins = aliveRows.filter((row) => String(row?.win_exchange || '') === 'WIN').length;

  return {
    generated_at: new Date().toISOString(),
    window_days: Math.max(1, Math.min(365, Number(options.days || 30))),
    total_positions: withLifecycle.length,
    ignition_success_rate: withLifecycle.length ? Number((ignitionSuccess / withLifecycle.length).toFixed(4)) : null,
    avg_time_to_first_expansion_ms: Number(
      average(withLifecycle.map((row) => toNumber(row?.impulse_lifecycle?.time_to_first_expansion_ms)))?.toFixed?.(2) || 0
    ) || null,
    avg_time_to_death_ms: Number(
      average(
        deadRows.map((row) => {
          const openedAt = parseDateLike(row?.opened_at);
          const closedAt = parseDateLike(row?.closed_at);
          if (!openedAt || !closedAt) return null;
          return closedAt.getTime() - openedAt.getTime();
        })
      )?.toFixed?.(2) || 0
    ) || null,
    dead_impulse_hit_rate: withLifecycle.length ? Number((deadRows.length / withLifecycle.length).toFixed(4)) : null,
    alive_to_win_rate: aliveRows.length ? Number((aliveWins / aliveRows.length).toFixed(4)) : null,
    dead_to_loss_rate: deadRows.length ? Number((deadLosses / deadRows.length).toFixed(4)) : null,
    phase_distribution: phaseDistribution,
    legacy_state_distribution: legacyDistribution,
    average_momentum_decay_score: Number(
      average(withLifecycle.map((row) => toNumber(row?.impulse_lifecycle?.momentum_decay_score)))?.toFixed?.(4) || 0
    ) || null,
    by_source_profile: withLifecycle.reduce((acc, row) => {
      const key = String(row?.source_profile || row?.source || 'unknown');
      if (!acc[key]) {
        acc[key] = {
          total: 0,
          phase_distribution: {},
          legacy_state_distribution: {},
          wins: 0,
          losses: 0
        };
      }
      acc[key].total += 1;
      const phase = resolveLifecyclePhase(row);
      const legacyState = resolveLegacyLifecycleState(row);
      acc[key].phase_distribution[phase] = (acc[key].phase_distribution[phase] || 0) + 1;
      acc[key].legacy_state_distribution[legacyState] = (acc[key].legacy_state_distribution[legacyState] || 0) + 1;
      if (String(row?.win_exchange || '') === 'WIN') acc[key].wins += 1;
      if (String(row?.win_exchange || '') === 'LOSS') acc[key].losses += 1;
      return acc;
    }, {})
  };
}

async function getPositionExitComparison(db, options = {}) {
  const rows = await loadRecentClosedPositions(db, options);
  const comparisons = rows
    .filter((row) => row?.adaptive_exit_comparison?.shadow_available)
    .slice(0, Math.max(10, Math.min(200, Number(options.limit || 50))))
    .map((row) => ({
      position_id: row.id,
      symbol: row.symbol || 'UNKNOWN',
      source_profile: row.source_profile || row.source || 'unknown',
      entry_price: toNumber(row.entry_price),
      real_close_at: row.closed_at || null,
      real_close_reason: row.close_reason || null,
      real_close_pnl_pct: toNumber(row.close_pnl_pct),
      shadow_exit_at: row?.adaptive_exit_comparison?.shadow_exit_at || null,
      shadow_exit_reason: row?.adaptive_exit_comparison?.shadow_exit_reason || null,
      shadow_exit_priority: toNumber(row?.adaptive_exit_comparison?.shadow_exit_priority),
      shadow_exit_pnl_pct: toNumber(row?.adaptive_exit_comparison?.shadow_exit_pnl_pct),
      shadow_lifecycle_phase: row?.adaptive_exit_comparison?.shadow_lifecycle_phase || null,
      shadow_lifecycle_legacy_state: row?.adaptive_exit_comparison?.shadow_lifecycle_legacy_state || null,
      shadow_decision_flow: row?.adaptive_exit_comparison?.shadow_decision_flow || null,
      pnl_delta_pct: toNumber(row?.adaptive_exit_comparison?.pnl_delta_pct),
      time_delta_ms: toNumber(row?.adaptive_exit_comparison?.time_delta_ms),
      improved: Boolean(row?.adaptive_exit_comparison?.improved),
      worsened: Boolean(row?.adaptive_exit_comparison?.worsened),
      no_difference: Boolean(row?.adaptive_exit_comparison?.no_difference)
    }));

  return {
    generated_at: new Date().toISOString(),
    window_days: Math.max(1, Math.min(365, Number(options.days || 30))),
    total: comparisons.length,
    comparisons
  };
}

module.exports = {
  getAdaptiveExitSummary,
  getImpulseLifecycleSummary,
  getPositionExitComparison
};
