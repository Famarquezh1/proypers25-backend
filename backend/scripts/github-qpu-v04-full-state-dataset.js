'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || '.qpu-v04';
const MANIFEST = process.argv[3] || path.join(ROOT, 'manifest.json');
const OUTPUT = process.argv[4] || 'qpu-v04-prebuy-full-state.jsonl';
const META = process.argv[5] || 'qpu-v04-prebuy-full-state.meta.json';

const BIN = 'https://data-api.binance.vision';
const H = 240;
const DEDUPE_MS = 30 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'proypers25-qpu-v04/1.0' } });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(350 * (i + 1)); continue; }
      throw new Error(`HTTP_${r.status}`);
    } catch (e) { last = e; if (i < 4) await sleep(350 * (i + 1)); }
  }
  throw last || new Error('fetch failed');
}

function candidateFromSelected(scan, run) {
  if (scan?.notify !== true || !scan?.symbol || !(Number(scan?.price) > 0) || !scan?.v42_detail) return null;
  return {
    observed_at: run.observed_at,
    run_id: run.run_id,
    source_role: 'PRODUCTION_SELECTED',
    symbol: String(scan.symbol).toUpperCase(),
    price: Number(scan.price),
    pct: Number(scan.pct || 0),
    qv: Number(scan.quote_volume || 0),
    utility: Number(scan.utility || 0),
    base: Number(scan.base_utility || 0),
    stable: Number(scan.stable_norm || 0),
    v42: Number(scan.v42_norm || 0),
    v42_pass_windows: Number(scan.v42_pass_windows || 0),
    v42_detail: scan.v42_detail,
    market_regime: String(scan.market_regime || 'UNKNOWN'),
    stage: 'PRODUCTION_SELECTED',
    reasons: []
  };
}

function candidatesFromScan(scan, run) {
  const rows = [];
  const selected = candidateFromSelected(scan, run);
  if (selected) rows.push(selected);
  for (const item of Array.isArray(scan?.learning_rejections) ? scan.learning_rejections : []) {
    if (!item?.symbol || !(Number(item?.price) > 0) || !item?.v42_detail) continue;
    rows.push({
      observed_at: run.observed_at,
      run_id: run.run_id,
      source_role: 'LEARNING_REJECTION',
      symbol: String(item.symbol).toUpperCase(),
      price: Number(item.price),
      pct: Number(item.pct || 0),
      qv: Number(item.qv || 0),
      utility: Number(item.utility || 0),
      base: Number(item.base || 0),
      stable: Number(item.stable || 0),
      v42: Number(item.v42 || 0),
      v42_pass_windows: Number(item.v42_pass_windows || 0),
      v42_detail: item.v42_detail,
      market_regime: String(item.market_regime || 'UNKNOWN'),
      stage: String(item.stage || 'UNKNOWN'),
      reasons: Array.isArray(item.reasons) ? item.reasons : []
    });
  }
  return rows;
}

function dedupe(rows) {
  const kept = [];
  for (const row of rows.sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at))) {
    const t = Date.parse(row.observed_at);
    const duplicate = kept.some(prev =>
      prev.symbol === row.symbol &&
      prev.stage === row.stage &&
      t - Date.parse(prev.observed_at) >= 0 &&
      t - Date.parse(prev.observed_at) < DEDUPE_MS
    );
    if (!duplicate) kept.push(row);
  }
  return kept;
}

async function label(row) {
  const t = Date.parse(row.observed_at);
  const q = new URLSearchParams({
    symbol: row.symbol,
    interval: '1m',
    startTime: String(t),
    endTime: String(t + (H + 5) * 60000),
    limit: '500'
  });
  const k = await getJson(`${BIN}/api/v3/klines?${q}`);
  if (!Array.isArray(k) || k.length < 61) return null;

  const entry = Number(row.price);
  let first3=null, firstNeg1=null, first5=null, first10=null, mfe=-Infinity, mae=Infinity;
  for (let i=1;i<k.length;i++) {
    const hi=Number(k[i][2])/entry-1, lo=Number(k[i][3])/entry-1;
    mfe=Math.max(mfe,hi); mae=Math.min(mae,lo);
    if(first3===null&&hi>=.03) first3=i;
    if(first5===null&&hi>=.05) first5=i;
    if(first10===null&&hi>=.10) first10=i;
    if(firstNeg1===null&&lo<=-.01) firstNeg1=i;
  }
  const last=Math.min(H,k.length-1);
  const d=row.v42_detail || {};
  return {
    observed_at: row.observed_at,
    run_id: row.run_id,
    source_role: row.source_role,
    symbol: row.symbol,
    entry_price: entry,
    pct: row.pct,
    qv: row.qv,
    log_qv: Math.log1p(Math.max(0,row.qv)),
    utility: row.utility,
    base: row.base,
    stable: row.stable,
    v42: row.v42,
    v42_pass_windows: row.v42_pass_windows,
    ignition: Number(d.ignition || 0),
    confirm: Number(d.confirm || 0),
    extension: Number(d.extension || 0),
    r15: Number(d.r15 || 0),
    r60: Number(d.r60 || 0),
    r24: Number(d.r24 || 0),
    fresh_enough: d.freshEnough === true,
    market_regime: row.market_regime,
    stage: row.stage,
    reasons: row.reasons,
    target_continuator: first3!==null&&(firstNeg1===null||first3<firstNeg1),
    first_plus3_min:first3,
    first_minus1_min:firstNeg1,
    first_plus5_min:first5,
    first_plus10_min:first10,
    hit_plus3:mfe>=.03,
    hit_plus5:mfe>=.05,
    hit_plus10:mfe>=.10,
    mfe_pct:mfe*100,
    mae_pct:mae*100,
    return_4h_pct:(Number(k[last][4])/entry-1)*100
  };
}

(async()=>{
  const manifest=JSON.parse(fs.readFileSync(MANIFEST,'utf8'));
  const raw=[];
  for(const run of manifest.runs||[]) {
    const scanPath=path.join(ROOT,String(run.run_id),'spot-radar-scan.json');
    if(!fs.existsSync(scanPath)) continue;
    const scan=JSON.parse(fs.readFileSync(scanPath,'utf8'));
    raw.push(...candidatesFromScan(scan,run));
  }

  const unique=dedupe(raw);
  const rows=[], skipped=[];
  for(const row of unique) {
    try {
      const out=await label(row);
      if(out) rows.push(out); else skipped.push({symbol:row.symbol,observed_at:row.observed_at,reason:'INSUFFICIENT_DATA'});
    } catch(e) {
      skipped.push({symbol:row.symbol,observed_at:row.observed_at,reason:e.message});
    }
    await sleep(25);
  }

  rows.sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
  fs.writeFileSync(OUTPUT,rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''),'utf8');

  const meta={
    ok:true,research_only:true,no_order_created:true,
    radar_runs:(manifest.runs||[]).length,
    raw_candidates:raw.length,
    deduped_candidates:unique.length,
    rows:rows.length,
    skipped:skipped.length,
    continuators:rows.filter(r=>r.target_continuator).length,
    non_continuators:rows.filter(r=>!r.target_continuator).length,
    target_definition:'+3% before -1%',
    horizon_minutes:H,
    complete_v42_detail:rows.length,
    first_observed_at:rows[0]?.observed_at||null,
    last_observed_at:rows[rows.length-1]?.observed_at||null,
    fields:['pct','log_qv','utility','base','stable','v42','v42_pass_windows','ignition','confirm','extension','r15','r60','r24','fresh_enough','market_regime','stage','reasons'],
    output:OUTPUT,
    bytes:fs.statSync(OUTPUT).size,
    skipped_examples:skipped.slice(0,10)
  };
  fs.writeFileSync(META,JSON.stringify(meta,null,2)+'\n','utf8');
  console.log(JSON.stringify(meta,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
