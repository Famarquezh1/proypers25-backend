/**
 * QPU research dataset exporter (READ ONLY).
 *
 * Reads selected Proypers25 signal documents from Firestore and writes a compact
 * local JSONL dataset for proypers-qpu-emulator.
 *
 * Usage:
 *   node backend/scripts/export-qpu-dataset.js
 *   QPU_EXPORT_LIMIT=5000 node backend/scripts/export-qpu-dataset.js
 *
 * Safety:
 * - no Firestore writes
 * - no Binance calls
 * - no execution collections
 * - output stays local under backend/qpu_exports/
 */

const fs = require('fs');
const path = require('path');
const db = require('../firebase-admin-config');

const COLLECTION = 'velas_predicciones';
const LIMIT = Math.max(1, Math.min(Number(process.env.QPU_EXPORT_LIMIT || 5000), 10000));
const OUTPUT_DIR = path.resolve(__dirname, '..', 'qpu_exports');

function toIso(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function first(row, paths) {
  for (const p of paths) {
    let cur = row;
    let ok = true;
    for (const part of p.split('.')) {
      if (!cur || typeof cur !== 'object' || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && cur !== undefined && cur !== null) return cur;
  }
  return null;
}

function num(row, paths) {
  const v = first(row, paths);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function canonicalize(id, row) {
  return {
    document_id: id,
    symbol: first(row, ['symbol', 'simbolo', 'simbolo_normalizado']),
    timestamp: toIso(first(row, ['signal_emitted_at', 'signal_created_at', 'created_at', 'timestamp'])),
    direction: first(row, ['direction', 'direccion']),
    mode: first(row, ['execution_mode', 'mode']),
    timeframe: first(row, ['timeframe']),
    signal_emitted: boolOrNull(row.signal_emitted),

    confidence: num(row, ['confidence', 'confianza']),
    quantum_score_legacy: num(row, ['quantum_score', 'quantumScore']),
    timing_score: num(row, ['timing_score', 'timingScore']),
    stability: num(row, ['stability']),
    expected_move_percent: num(row, ['expected_move_percent']),
    spot_price: num(row, ['spot_price', 'precio_actual', 'precio_estimado']),

    context_score: num(row, ['context_score', 'event_context_filter.context_score']),
    context_quality: num(row, ['context_quality', 'event_context_filter.context_quality']),
    structural_context_score: num(row, ['structural_context_score', 'event_context_filter.structural_context_score']),
    volatility_context_score: num(row, ['volatility_context_score', 'event_context_filter.volatility_context_score']),
    volume_flow_context_score: num(row, ['volume_flow_context_score', 'event_context_filter.volume_flow_context_score']),
    liquidity_context_score: num(row, ['liquidity_context_score', 'event_context_filter.liquidity_context_score']),

    mfe_pct: num(row, [
      'mfe_pct',
      'mfe',
      'max_favorable_move_pct',
      'verification.mfe_pct',
      'verification.mfe',
      'verification.max_favorable_move_pct'
    ]),
    mae_pct: num(row, [
      'mae_pct',
      'mae',
      'max_adverse_move_pct',
      'verification.mae_pct',
      'verification.mae',
      'verification.max_adverse_move_pct'
    ]),

    // Never infer +3% before -1% from extrema alone.
    target_continuator: boolOrNull(
      first(row, ['continuator', 'is_continuator', 'target_continuation', 'verification.continuator'])
    )
  };
}

async function loadLatest() {
  let snap;
  try {
    snap = await db
      .collection(COLLECTION)
      .orderBy('created_at', 'desc')
      .limit(LIMIT)
      .get();
  } catch (err) {
    console.warn('[QPU_EXPORT] created_at ordering failed; falling back to un-ordered read:', err.message);
    snap = await db.collection(COLLECTION).limit(LIMIT).get();
  }

  return snap.docs.map(doc => canonicalize(doc.id, doc.data() || {}));
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const rows = await loadLatest();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dataPath = path.join(OUTPUT_DIR, `velas_predicciones_${stamp}.jsonl`);
  const metaPath = path.join(OUTPUT_DIR, `velas_predicciones_${stamp}.meta.json`);

  const body = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(dataPath, body, 'utf8');

  const labeled = rows.filter(row => typeof row.target_continuator === 'boolean').length;
  const metadata = {
    generated_at: new Date().toISOString(),
    source_collection: COLLECTION,
    requested_limit: LIMIT,
    rows: rows.length,
    labeled_continuators: labeled,
    read_only: true,
    binance_called: false,
    firestore_writes: 0,
    data_file: path.basename(dataPath),
    bytes: Buffer.byteLength(body)
  };
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({
    ok: true,
    ...metadata,
    output_dir: OUTPUT_DIR
  }, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error('[QPU_EXPORT_ERROR]', err?.stack || err);
    process.exit(1);
  });
}

module.exports = { canonicalize, loadLatest };
