const db = require('../firebase-admin-config');

function normalizePercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function parseArgs(argv) {
  const args = { days: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--days' && argv[i + 1]) {
      args.days = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--from' && argv[i + 1]) {
      args.from = argv[i + 1];
      i += 1;
    } else if (token === '--to' && argv[i + 1]) {
      args.to = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function resolveWindow(args) {
  const now = new Date();
  let from = null;
  let to = null;

  if (args.from) {
    from = new Date(`${args.from}T00:00:00.000Z`);
  }
  if (args.to) {
    to = new Date(`${args.to}T23:59:59.999Z`);
  }
  if (!from) {
    from = new Date(now);
    from.setUTCDate(from.getUTCDate() - (Number(args.days) || 30));
  }
  if (!to) {
    to = now;
  }
  return { from, to };
}

function signalDate(data) {
  if (data?.created_at?.toDate) return data.created_at.toDate();
  if (data?.created_at) return new Date(data.created_at);
  if (data?.timestamp) return new Date(data.timestamp);
  return null;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const year = d.getUTCFullYear();
  const weekPadded = String(week).padStart(2, '0');
  return `${year}-W${weekPadded}`;
}

function outcomeLabel(data) {
  const raw = (
    data?.verification_outcome ||
    data?.verification?.verification_outcome ||
    data?.verification?.outcome_label ||
    data?.status ||
    ''
  ).toString().toUpperCase();
  if (raw.includes('WIN') || raw === 'VALIDADO') return 'WIN';
  if (raw.includes('LOSS') || raw === 'FALLIDO') return 'LOSS';
  if (raw.includes('SUPPRESSED') || raw === 'SUPRIMIDA') return 'SUPPRESSED';
  return 'OTHER';
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const { from, to } = resolveWindow(args);

  console.log(`Stability audit window: ${from.toISOString()} -> ${to.toISOString()}`);

  const snapshot = await db
    .collection('high_conviction_signals')
    .where('created_at', '>=', from)
    .where('created_at', '<=', to)
    .get();

  const rows = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  const total = rows.length;

  let sumStability = 0;
  let sumConfidence = 0;
  let persistedStabilityCount = 0;
  let wins = 0;
  let losses = 0;
  let missingStability = 0;
  const versionCount = {};
  const weekly = new Map();

  for (const row of rows) {
    const confidence = normalizePercent(row.confidence);
    sumConfidence += confidence;

    if (row.stability != null) {
      sumStability += normalizePercent(row.stability);
      persistedStabilityCount += 1;
    } else {
      missingStability += 1;
    }

    const version = row.stability_version != null ? String(row.stability_version) : 'missing';
    versionCount[version] = (versionCount[version] || 0) + 1;

    const outcome = outcomeLabel(row);
    if (outcome === 'WIN') wins += 1;
    if (outcome === 'LOSS') losses += 1;

    const dt = signalDate(row);
    if (!dt || Number.isNaN(dt.getTime())) continue;
    const weekKey = isoWeek(dt);
    if (!weekly.has(weekKey)) {
      weekly.set(weekKey, { week: weekKey, total: 0, wins: 0, losses: 0 });
    }
    const bucket = weekly.get(weekKey);
    bucket.total += 1;
    if (outcome === 'WIN') bucket.wins += 1;
    if (outcome === 'LOSS') bucket.losses += 1;
  }

  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const avgStability = persistedStabilityCount > 0 ? sumStability / persistedStabilityCount : 0;
  const avgConfidence = total > 0 ? sumConfidence / total : 0;

  console.log('\n1) Global');
  console.table({
    total,
    persisted_stability_count: persistedStabilityCount,
    missing_stability: missingStability,
    avg_stability: `${(avgStability * 100).toFixed(2)}%`,
    avg_confidence: `${(avgConfidence * 100).toFixed(2)}%`,
    wins,
    losses,
    win_rate: `${(winRate * 100).toFixed(2)}%`
  });

  console.log('\n2) Stability version consistency');
  console.table(versionCount);

  console.log('\n3) Weekly breakdown');
  const weeklyRows = Array.from(weekly.values())
    .map((w) => ({
      week: w.week,
      total: w.total,
      wins: w.wins,
      losses: w.losses,
      win_rate: `${((w.wins + w.losses > 0 ? w.wins / (w.wins + w.losses) : 0) * 100).toFixed(2)}%`
    }))
    .sort((a, b) => b.week.localeCompare(a.week));
  console.table(weeklyRows);

  if (missingStability > 0) {
    console.log(`\nWARN: found ${missingStability} signals without persisted stability.`);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('audit-stability failed:', err?.message || err);
    process.exit(1);
  });
