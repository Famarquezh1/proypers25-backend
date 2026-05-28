const QUALITY_GATE_MIN_CONFIDENCE = 0.65;
const QUALITY_GATE_MIN_QUANTUM = 0.6;
const QUALITY_GATE_MIN_TIMING = 0.6;

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

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(0.1, Number(options.hours || 1));
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

function resolvePredictionTimestamp(row = {}) {
  return (
    parseDateLike(row.created_at) ||
    parseDateLike(row.timestamp) ||
    parseDateLike(row.signal_created_at) ||
    parseDateLike(row.ahora)
  );
}

function parseFailedChecks(gateReason) {
  const normalized = String(gateReason || '').trim();
  if (!normalized) return [];
  if (!normalized.startsWith('missing:')) {
    return [normalized];
  }
  return normalized
    .slice('missing:'.length)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTrendAlignment(row = {}, failedChecks = []) {
  if (failedChecks.includes('direction')) return 0;
  const direction = String(
    row.direction ||
    row.decision_post_learning?.direction ||
    row.prediccion ||
    ''
  ).toLowerCase();
  if (!direction || direction === 'neutral') return 0;
  return 1;
}

function buildBlockedSummary(blockedRows = []) {
  const failedCheckCounts = {};
  const qualityScores = [];
  const confidences = [];
  const timingScores = [];
  const expectedMoves = [];
  const volatilities = [];
  const trendAlignments = [];
  const marketContextScores = [];
  const quantumScores = [];

  for (const row of blockedRows) {
    const confidence = toNumber(
      row.decision_post_learning?.confidence ??
      row.confidence ??
      row.confianza,
      null
    );
    const quantum = toNumber(
      row.decision_post_learning?.quantum ??
      row.quantum_score ??
      row.quantum,
      null
    );
    const timing = toNumber(
      row.decision_post_learning?.timing ??
      row.timing_score ??
      row.timing,
      null
    );
    const expectedMove = toNumber(
      row.expected_move_percent ??
      row.expected_delta_pct,
      null
    );
    const volatility = toNumber(
      row.volatility_expansion_ratio ??
      row.event_context_filter?.volatility_expansion_ratio ??
      row.decision_post_learning?.event_context_filter?.volatility_expansion_ratio,
      null
    );
    const marketContext = toNumber(
      row.context_score ??
      row.event_context_filter?.context_score ??
      row.decision_post_learning?.event_context_filter?.context_score,
      null
    );
    const failedChecks = parseFailedChecks(
      row.decision_post_learning?.gate_reason ||
      row.gate_reason ||
      row.suppression_reason
    );

    for (const check of failedChecks) {
      increment(failedCheckCounts, check);
    }

    if (confidence != null) confidences.push(confidence);
    if (quantum != null) quantumScores.push(quantum);
    if (timing != null) timingScores.push(timing);
    if (expectedMove != null) expectedMoves.push(expectedMove);
    if (volatility != null) volatilities.push(volatility);
    if (marketContext != null) marketContextScores.push(marketContext);
    trendAlignments.push(normalizeTrendAlignment(row, failedChecks));

    const composite = average([confidence, quantum, timing]);
    if (composite != null) qualityScores.push(composite);
  }

  return {
    quality_score: round(average(qualityScores)),
    min_quality_required: {
      confidence: QUALITY_GATE_MIN_CONFIDENCE,
      quantum: QUALITY_GATE_MIN_QUANTUM,
      timing: QUALITY_GATE_MIN_TIMING,
      composite: round(average([
        QUALITY_GATE_MIN_CONFIDENCE,
        QUALITY_GATE_MIN_QUANTUM,
        QUALITY_GATE_MIN_TIMING
      ]))
    },
    failed_checks: topEntries(failedCheckCounts),
    top_failed_check: topEntries(failedCheckCounts, 1)[0]?.key || null,
    confidence: round(average(confidences)),
    timing_score: round(average(timingScores)),
    expected_move: round(average(expectedMoves)),
    volatility: round(average(volatilities)),
    trend_alignment: round(average(trendAlignments)),
    market_context_score: round(average(marketContextScores))
  };
}

function deriveDiagnosis(report = {}) {
  const blocked = Number(report.blocked_quality || 0);
  if (blocked === 0) return 'mixed';

  const topFailed = String(report.top_failed_check || '');
  const confidence = toNumber(report.confidence, null);
  const timingScore = toNumber(report.timing_score, null);
  const marketContext = toNumber(report.market_context_score, null);
  const qualityScore = toNumber(report.quality_score, null);
  const minComposite = toNumber(report.min_quality_required?.composite, null);

  if (topFailed === 'confidence' || (confidence != null && confidence < QUALITY_GATE_MIN_CONFIDENCE)) {
    return 'confidence_weak';
  }
  if (topFailed === 'timing' || (timingScore != null && timingScore < QUALITY_GATE_MIN_TIMING)) {
    return 'timing_weak';
  }
  if (
    topFailed === 'direction' ||
    topFailed === 'impulse' ||
    topFailed === 'quantum' ||
    (marketContext != null && marketContext <= 0)
  ) {
    return 'context_weak';
  }
  if (
    qualityScore != null &&
    minComposite != null &&
    qualityScore >= (minComposite - 0.03)
  ) {
    return 'quality_threshold_too_high';
  }
  return 'mixed';
}

async function getQualityGateBreakdownDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs);

  const predictions = rows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until && row.decision_post_learning;
  });

  const blockedRows = predictions.filter((row) => row.decision_post_learning?.quality_gate_passed === false);
  const passedRows = predictions.filter((row) => row.decision_post_learning?.quality_gate_passed === true);
  const blockedSummary = buildBlockedSummary(blockedRows);

  const report = {
    total_signals: predictions.length,
    passed_quality: passedRows.length,
    blocked_quality: blockedRows.length,
    ...blockedSummary
  };

  return {
    ...report,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getQualityGateBreakdownDiagnostic
};
