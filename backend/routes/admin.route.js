const express = require('express');
const router = express.Router();
const db = require('../firebase-admin-config');

/**
 * ADMIN ROUTE: Generate Fresh Spot Opportunity Scans
 * Called by Cloud Scheduler every 45 minutes
 */

// Middleware: Validate cron secret
const validateCronSecret = (req, res, next) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  const expectedSecret = process.env.CRON_SECRET || 'proypers25-cron-secret';
  
  if (secret !== expectedSecret) {
    console.warn('[ADMIN] Unauthorized access attempt to generate-scan');
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: Invalid cron secret'
    });
  }
  
  next();
};

/**
 * POST /internal/admin/generate-scan
 * 
 * Generates a fresh spot opportunity scan with current market candidates.
 * Called automatically by Cloud Scheduler every 45 minutes.
 * 
 * Security: Requires x-cron-secret header matching CRON_SECRET env var
 */
router.post('/internal/admin/generate-scan', validateCronSecret, async (req, res) => {
  try {
    console.log('[ADMIN] Generating fresh spot scan...');
    
    const scanId = `spot_scan_${Date.now()}`;
    const now = new Date();
    
    // Get top 50 candidates from paper collection
    const candidatesSnap = await db.collection('spot_opportunity_candidates')
      .orderBy('opportunityScore', 'desc')
      .limit(50)
      .get();
    
    const candidates = candidatesSnap.docs.map(doc => ({
      ...doc.data(),
      id: doc.id
    }));
    
    console.log(`[ADMIN] Found ${candidates.length} candidates for scan`);
    
    // Create scan document
    await db.collection('spot_opportunity_scans').doc(scanId).set({
      scan_id: scanId,
      created_at: now.toISOString(),
      completed_at: now.toISOString(),
      candidates_count: candidates.length,
      status: 'COMPLETED',
      version: '1.0',
      metadata: {
        source: 'cloud_scheduler_automated',
        manual: false
      }
    });
    
    console.log(`[ADMIN] Created scan: ${scanId}`);
    
    // Update candidates to reference this scan
    const batch = db.batch();
    for (let i = 0; i < Math.min(candidates.length, 50); i++) {
      const candidate = candidates[i];
      const docRef = db.collection('spot_opportunity_candidates').doc(candidate.id);
      batch.update(docRef, {
        scan_id: scanId,
        updated_at: now.toISOString()
      });
    }
    
    await batch.commit();
    console.log(`[ADMIN] Updated ${Math.min(candidates.length, 50)} candidates with new scan_id`);
    
    return res.status(200).json({
      ok: true,
      message: 'Fresh scan generated successfully',
      scan_id: scanId,
      candidates_count: candidates.length,
      timestamp: now.toISOString()
    });
    
  } catch (error) {
    console.error('[ADMIN] Error generating scan:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to generate scan',
      details: error.message
    });
  }
});

/**
 * GET /internal/admin/scan-status
 * 
 * Check the status of the latest scan
 */
router.get('/internal/admin/scan-status', validateCronSecret, async (req, res) => {
  try {
    const latestScanSnap = await db.collection('spot_opportunity_scans')
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    
    if (latestScanSnap.empty) {
      return res.status(200).json({
        ok: true,
        message: 'No scans found',
        latest_scan: null
      });
    }
    
    const latestScan = latestScanSnap.docs[0].data();
    const scanAgeMs = Date.now() - new Date(latestScan.created_at).getTime();
    const scanAgeMinutes = scanAgeMs / (60 * 1000);
    
    return res.status(200).json({
      ok: true,
      message: 'Latest scan found',
      latest_scan: {
        scan_id: latestScan.scan_id,
        created_at: latestScan.created_at,
        age_minutes: Number(scanAgeMinutes.toFixed(2)),
        candidates_count: latestScan.candidates_count,
        status: latestScan.status
      }
    });
    
  } catch (error) {
    console.error('[ADMIN] Error getting scan status:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to get scan status',
      details: error.message
    });
  }
});

// Runtime identity endpoint: confirms which image/commit Cloud Run is executing.
router.get('/__version', (req, res) => {
  res.json({
    ok: true,
    service: 'proypers25-backend',
    commit: process.env.APP_COMMIT_SHA || 'unknown',
    started_at: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Mobile dashboard is deliberately served from this long-standing router.
// Data remains protected and is loaded from the private summary endpoint.
router.get('/investments-dashboard', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Proypers25 · Centro de control</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#07111f;color:#eef6ff}.wrap{max-width:1050px;margin:auto;padding:18px}.bar{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.bar input{flex:1;min-width:220px;padding:13px;border-radius:10px;border:1px solid #29415f;background:#0d1b2d;color:#fff}.bar button{padding:13px 18px;border:0;border-radius:10px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card{background:#0d1b2d;border:1px solid #203853;border-radius:14px;padding:15px}.label{font-size:13px;color:#8fa7c2}.value{font-size:24px;font-weight:800;margin-top:6px}.good{color:#51d88a}.bad{color:#ff718a}.warn{color:#ffd166}.error{color:#ff718a;white-space:pre-wrap}.muted{color:#8fa7c2}table{width:100%;border-collapse:collapse}th,td{padding:10px 7px;border-bottom:1px solid #203853;text-align:left;font-size:13px}th{color:#8fa7c2}.scroll{overflow:auto}h1{margin-bottom:4px}h2{margin-top:25px}
  </style>
</head>
<body><main class="wrap">
  <h1>Proypers25</h1><div class="muted">Centro privado de inversiones Spot</div>
  <div class="bar"><input id="secret" type="password" placeholder="Clave privada"><button onclick="loadData()">Actualizar</button></div>
  <div id="error" class="error"></div>
  <div id="content" hidden><section id="cards" class="grid"></section>
    <h2>Activos</h2><div class="card scroll"><table><thead><tr><th>Activo</th><th>Valor</th><th>Cantidad</th><th>Origen</th><th>PnL API</th></tr></thead><tbody id="assets"></tbody></table></div>
    <h2>Últimas operaciones</h2><div class="card scroll"><table><thead><tr><th>Par</th><th>PnL</th><th>%</th><th>Motivo</th><th>Fecha</th></tr></thead><tbody id="trades"></tbody></table></div>
  </div>
<script>
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(n||0));
const pct=n=>Number(n||0).toFixed(2)+'%';
async function loadData(){const s=document.getElementById('secret').value;localStorage.setItem('proypers25_summary_secret',s);const e=document.getElementById('error');e.textContent='Cargando...';try{const r=await fetch('/internal/investments/summary',{headers:{'x-investments-secret':s}});const d=await r.json();if(!r.ok)throw new Error((d.error||'ERROR')+(d.details?' · '+d.details:''));render(d);e.textContent='';}catch(x){document.getElementById('content').hidden=true;e.textContent=x.message;}}
function render(d){document.getElementById('content').hidden=false;const cards=[['Capital total',money(d.account.total_equity_usdt),''],['USDT disponible',money(d.account.available_usdt),''],['Exposición API',money(d.allocation.api_exposure_usdt),''],['PnL realizado',money(d.performance.realized_pnl_usdt),d.performance.realized_pnl_usdt>=0?'good':'bad'],['Win rate',pct(d.performance.win_rate_pct),d.performance.win_rate_pct>=50?'good':'warn'],['Posiciones API',d.engine.open_positions,''],['Compras',d.engine.new_entries_enabled?'ACTIVAS':'BLOQUEADAS',d.engine.new_entries_enabled?'warn':'good'],['Ventas',d.engine.real_sells_enabled?'ACTIVAS':'BLOQUEADAS',d.engine.real_sells_enabled?'bad':'good']];document.getElementById('cards').innerHTML=cards.map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value '+x[2]+'">'+x[1]+'</div></div>').join('');document.getElementById('assets').innerHTML=d.assets.map(a=>'<tr><td><b>'+a.asset+'</b></td><td>'+money(a.value_usdt)+'</td><td>'+Number(a.quantity).toLocaleString('es-CL',{maximumFractionDigits:8})+'</td><td>'+(a.managed_by_api?'API':'Cuenta')+'</td><td class="'+((a.unrealized_pnl_usdt||0)>=0?'good':'bad')+'">'+(a.unrealized_pnl_usdt==null?'—':money(a.unrealized_pnl_usdt))+'</td></tr>').join('');document.getElementById('trades').innerHTML=d.recent_trades.map(t=>'<tr><td>'+String(t.symbol||'—')+'</td><td class="'+(t.net_pnl_usdt>=0?'good':'bad')+'">'+money(t.net_pnl_usdt)+'</td><td>'+pct(t.net_pnl_pct)+'</td><td>'+String(t.closing_reason||'—')+'</td><td>'+String(t.closed_at||'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">Aún no hay cierres registrados.</td></tr>';}
document.getElementById('secret').value=localStorage.getItem('proypers25_summary_secret')||'';
</script></main></body></html>`);
});

module.exports = router;
