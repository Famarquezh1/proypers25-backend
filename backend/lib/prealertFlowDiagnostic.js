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

function deriveDiagnosis(report = {}) {
  if (Number(report.predictions_loaded || 0) === 0) {
    return 'insufficient_data';
  }
  if (Number(report.prealerts_generated || 0) === 0 && Number(report.prealerts_filtered || 0) === 0) {
    return 'no_prealert_generation';
  }
  if (Number(report.prealerts_generated || 0) === 0 && Number(report.prealerts_filtered || 0) > 0) {
    return 'filtered_all';
  }
  return 'no_prealert_generation';
}

async function getPrealertFlowDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const predictionRows = await loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs);

  const predictions = predictionRows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const filteredReasons = {};
  let prealertsGenerated = 0;
  let prealertsFiltered = 0;

  for (const row of predictions) {
    const decision = row.manual_prealert_decision || null;
    if (!decision) continue;
    if (decision.ok === true) {
      prealertsGenerated += 1;
    } else {
      prealertsFiltered += 1;
      increment(filteredReasons, decision.reason || 'unknown');
    }
  }

  return {
    predictions_loaded: predictions.length,
    prealerts_generated: prealertsGenerated,
    prealerts_filtered: prealertsFiltered,
    top_filter_reason: topEntries(filteredReasons, 1)[0]?.key || null,
    diagnosis: deriveDiagnosis({
      predictions_loaded: predictions.length,
      prealerts_generated: prealertsGenerated,
      prealerts_filtered: prealertsFiltered
    })
  };
}

module.exports = {
  getPrealertFlowDiagnostic
};
