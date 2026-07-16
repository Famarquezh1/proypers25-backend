'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getSpotPaperExecutionDiagnostic } = require('../services/binanceSpotPaperExecutor');

const router = express.Router();
const SCANS = 'spot_opportunity_scans';
const CANDIDATES = 'spot_opportunity_candidates';
const VALIDATIONS = 'spot_opportunity_validations';

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validatePrivateSecret(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'PRIVATE_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

function numberFrom(item, keys, fallback = 0) {
  for (const key of keys) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function textFrom(item, keys, fallback = null) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return fallback;
}

async function buildLatestRanking() {
  const latestScanSnapshot = await db.collection(SCANS).orderBy('created_at', 'desc').limit(1).get();
  if (latestScanSnapshot.empty) {
    return { scan: null, ranking: [], total_candidates: 0, eligible: 0, discarded: 0, selected: null };
  }

  const scanDoc = latestScanSnapshot.docs[0];
  const scan = { id: scanDoc.id, ...(scanDoc.data() || {}) };
  const [candidateSnapshot, validationSnapshot] = await Promise.all([
    db.collection(CANDIDATES).where('scan_id', '==', scan.id).get(),
    db.collection(VALIDATIONS).where('scan_id', '==', scan.id).get()
  ]);

  const validations = new Map(validationSnapshot.docs.map((doc) => {
    const item = { id: doc.id, ...(doc.data() || {}) };
    return [String(item.symbol || '').toUpperCase(), item];
  }));

  const ranking = candidateSnapshot.docs.map((doc) => {
    const candidate = { id: doc.id, ...(doc.data() || {}) };
    const symbol = String(candidate.symbol || '').toUpperCase();
    const validation = validations.get(symbol) || {};
    const rejected = candidate.rejected === true || ['REJECTED', 'DISCARDED', 'BLOCKED'].includes(String(candidate.status || '').toUpperCase());
    return {
      id: candidate.id,
      symbol,
      score: numberFrom(candidate, ['opportunityScore', 'opportunity_score', 'score', 'final_score']),
      validation_priority: numberFrom(candidate, ['validation_priority', 'validationPriority']),
      quote_volume_24h: numberFrom(candidate, ['quoteVolume24h', 'quote_volume_24h', 'volume24h']),
      category: textFrom(candidate, ['category', 'risk_category'], 'UNKNOWN'),
      risk: textFrom(candidate, ['risk_level', 'risk', 'category'], 'UNKNOWN'),
      recommendation: textFrom(candidate, ['recommendation', 'decision'], null),
      rejected,
      rejection_reason: textFrom(candidate, ['rejection_reason', 'blocked_reason', 'reason'], null),
      reasons: Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 5) : [],
      validation_positive: validation.positive === true || validation.is_positive === true,
      validation_status: textFrom(validation, ['status', 'result'], null),
      validation_sample_size: numberFrom(validation, ['sample_size', 'completed_count', 'observations'])
    };
  }).sort((left, right) => {
    if (left.rejected !== right.rejected) return left.rejected ? 1 : -1;
    if (Math.abs(right.validation_priority - left.validation_priority) > 0.000001) return right.validation_priority - left.validation_priority;
    if (Math.abs(right.score - left.score) > 0.000001) return right.score - left.score;
    return right.quote_volume_24h - left.quote_volume_24h;
  }).map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    scan: {
      id: scan.id,
      created_at: scan.created_at || null,
      market_regime: scan.market_regime || scan.context || null
    },
    ranking: ranking.slice(0, 50),
    total_candidates: ranking.length,
    eligible: ranking.filter((item) => !item.rejected).length,
    discarded: ranking.filter((item) => item.rejected).length,
    selected: ranking.find((item) => !item.rejected) || null
  };
}

router.get('/internal/paper-ranking', validatePrivateSecret, async (req, res) => {
  try {
    const [diagnostic, latest] = await Promise.all([
      getSpotPaperExecutionDiagnostic(db, { maxDocs: 250 }),
      buildLatestRanking()
    ]);
    return res.json({ ok: true, paper_only: true, generated_at: new Date().toISOString(), ...latest, diagnostic });
  } catch (error) {
    console.error('[PAPER_RANKING] Failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'PAPER_RANKING_FAILED', details: error?.message || String(error) });
  }
});

router.get('/paper-ranking-dashboard', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 Ranking</title><style>body{margin:0;background:#07111f;color:#e9f2ff;font-family:Inter,system-ui,sans-serif}.w{max-width:1080px;margin:auto;padding:20px}.t{display:flex;gap:10px;flex-wrap:wrap}.t input{flex:1;min-width:220px;padding:13px;border:1px solid #29415f;border-radius:10px;background:#0d1b2d;color:#fff}.t button{padding:13px 18px;border:0;border-radius:10px;font-weight:800}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}.c{background:#0d1b2d;border:1px solid #203853;border-radius:14px;padding:16px}.l{color:#8fa7c2;font-size:13px}.v{font-size:22px;font-weight:800;margin-top:6px}.ok{color:#51d88a}.bad{color:#ff718a}.muted{color:#8fa7c2}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #203853;white-space:nowrap}th{color:#8fa7c2}.err{color:#ff718a;margin-top:12px}</style></head><body><main class="w"><h1>Ranking de oportunidades</h1><div class="muted">Solo validación simulada. No ejecuta órdenes.</div><div class="t"><input id="s" type="password" placeholder="Clave privada"><button onclick="load()">Actualizar</button></div><div id="e" class="err"></div><div id="x" hidden><div id="cards" class="g"></div><div id="sel" class="c"></div><h2>Último ranking</h2><div class="c" style="overflow:auto"><table><thead><tr><th>#</th><th>Par</th><th>Score</th><th>Riesgo</th><th>Validación</th><th>Estado</th><th>Motivo</th></tr></thead><tbody id="r"></tbody></table></div><h2>Aprendizaje simulado</h2><div id="a" class="c"></div></div><script>const n=(v,d=2)=>Number(v||0).toLocaleString('es-CL',{maximumFractionDigits:d});const m=v=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(v||0));async function load(){const s=document.getElementById('s').value;localStorage.setItem('proypers25_summary_secret',s);document.getElementById('e').textContent='Cargando...';try{const q=await fetch('/internal/paper-ranking',{headers:{'x-investments-secret':s}});const d=await q.json();if(!q.ok)throw new Error(d.error+(d.details?' · '+d.details:''));render(d);document.getElementById('e').textContent='';}catch(err){document.getElementById('x').hidden=true;document.getElementById('e').textContent=err.message;}}function render(d){document.getElementById('x').hidden=false;const z=d.diagnostic||{};document.getElementById('cards').innerHTML=[['Candidatos',d.total_candidates],['Elegibles',d.eligible],['Descartados',d.discarded],['Paper abiertos',z.open_paper_positions],['Paper cerrados',z.closed_paper_positions],['Win rate',n(z.win_rate)+'%'],['PnL simulado',m(z.total_net_pnl_usdt)]].map(i=>'<div class="c"><div class="l">'+i[0]+'</div><div class="v">'+i[1]+'</div></div>').join('');const s=d.selected;document.getElementById('sel').innerHTML=s?'<div class="l">Primera oportunidad elegible</div><div class="v ok">#'+s.rank+' '+s.symbol+' · Score '+n(s.score)+'</div><div>Riesgo: '+s.risk+' · Categoría: '+s.category+'</div><div class="muted">'+(s.reasons||[]).join(' · ')+'</div>':'<div class="bad">No hay oportunidad elegible en el último escaneo.</div>';document.getElementById('r').innerHTML=(d.ranking||[]).map(i=>'<tr><td>'+i.rank+'</td><td><b>'+i.symbol+'</b></td><td>'+n(i.score)+'</td><td>'+i.risk+'</td><td>'+(i.validation_positive?'POSITIVA':(i.validation_status||'—'))+'</td><td class="'+(i.rejected?'bad':'ok')+'">'+(i.rejected?'DESCARTADA':'ELEGIBLE')+'</td><td>'+(i.rejection_reason||(i.reasons||[]).join(', ')||'—')+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">Sin candidatos.</td></tr>';document.getElementById('a').innerHTML='<b>Resultado acumulado:</b> '+m(z.total_net_pnl_usdt)+' · <b>Win rate:</b> '+n(z.win_rate)+'% · <b>Ganancia media:</b> '+n(z.avg_win_pct)+'% · <b>Pérdida media:</b> '+n(z.avg_loss_pct)+'%<br><span class="muted">'+String(z.conclusion||'Aún no hay muestra suficiente.')+'</span>';}document.getElementById('s').value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
