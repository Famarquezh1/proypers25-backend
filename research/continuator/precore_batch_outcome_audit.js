'use strict';

const REPO=process.env.GITHUB_REPOSITORY||'Famarquezh1/proypers25-backend';
const TOKEN=process.env.GITHUB_TOKEN||'';
const BASE='https://data-api.binance.vision';
const WORKFLOW='precore-batch-planner.yml';
const ISSUE_TITLE='[RESEARCH] Pre-CORE Batch Outcome Audit';
const MAX_RUNS=24;

async function gh(path, options={}){
  const r=await fetch('https://api.github.com/repos/'+REPO+path,{
    ...options,
    headers:{
      'Authorization':'Bearer '+TOKEN,
      'Accept':'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  if(!r.ok) throw new Error('GitHub '+r.status+' '+await r.text());
  const t=await r.text(); return t?JSON.parse(t):{};
}
async function get(url){
  const r=await fetch(url,{headers:{'user-agent':'proypers25-batch-outcome/1.0'}});
  if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
  return await r.json();
}
function extractPlan(log){
  for(const line of String(log||'').split(/\r?\n/)){
    const p=line.indexOf('{"ok":true,"mode":"PRE_CORE_BATCH_PLANNER_V1"');
    if(p<0) continue;
    try{return JSON.parse(line.slice(p))}catch{}
  }
  return null;
}
function firstHit(rows,entry,tpPct,slPct){
  for(const r of rows){
    const hi=(+r[2]/entry-1)*100;
    const lo=(+r[3]/entry-1)*100;
    const tp=hi>=tpPct;
    const sl=lo<=slPct;
    if(tp&&sl)return 'AMBIGUOUS_SAME_BAR';
    if(tp)return 'TP_HIT';
    if(sl)return 'SL_HIT';
  }
  return 'OPEN';
}
async function klines(symbol,start,end){
  const q=new URLSearchParams({
    symbol,interval:'5m',startTime:String(start),endTime:String(end),limit:'1000'
  });
  return await get(BASE+'/api/v3/klines?'+q.toString());
}
async function main(){
  const runs=await gh('/actions/workflows/'+WORKFLOW+'/runs?status=completed&per_page='+MAX_RUNS);
  const plans=[];
  for(const run of (runs.workflow_runs||[]).filter(r=>r.conclusion==='success')){
    const jobs=await gh('/actions/runs/'+run.id+'/jobs?per_page=20');
    const job=(jobs.jobs||[]).find(j=>j.name==='plan')||(jobs.jobs||[])[0];
    if(!job) continue;
    const lr=await fetch('https://api.github.com/repos/'+REPO+'/actions/jobs/'+job.id+'/logs',{
      headers:{'Authorization':'Bearer '+TOKEN,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
    });
    if(!lr.ok) continue;
    const plan=extractPlan(await lr.text());
    if(plan) plans.push({...plan,run_id:run.id});
  }

  const now=Date.now();
  const rows=[];
  for(const p of plans){
    const generated=Date.parse(p.generated_at);
    if(!Number.isFinite(generated)) continue;
    const horizonEnd=Math.min(now,generated+180*60000);
    const inspect=[
      ...(p.slots||[]).map(x=>({...x,decision:'PLANNED'})),
      ...(p.top_rejected||[]).filter(x=>x.lane==='WINNER_CONTINUATION').slice(0,6)
        .map(x=>({...x,decision:'REJECTED_WINNER'}))
    ];
    for(const x of inspect){
      if(!x.symbol) continue;
      const entry=Number(x.reference_price||x.price||0);
      // rejected rows do not store reference price; skip exact outcome until planner exposes it
      if(!(entry>0)) {
        rows.push({run_id:p.run_id,batch_id:p.batch_id,symbol:x.symbol,decision:x.decision,status:'NO_REFERENCE_PRICE'});
        continue;
      }
      const ks=await klines(x.symbol,generated,horizonEnd);
      if(!ks.length) continue;
      const tp=Number(x.take_profit_pct||0);
      const sl=Number(x.stop_loss_pct||0);
      const last=+ks[ks.length-1][4];
      const max=Math.max(...ks.map(r=>+r[2]));
      const min=Math.min(...ks.map(r=>+r[3]));
      rows.push({
        run_id:p.run_id,batch_id:p.batch_id,symbol:x.symbol,decision:x.decision,
        age_min:+((horizonEnd-generated)/60000).toFixed(1),
        entry,latest:last,
        return_pct:+((last/entry-1)*100).toFixed(3),
        mfe_pct:+((max/entry-1)*100).toFixed(3),
        mae_pct:+((min/entry-1)*100).toFixed(3),
        tp_pct:tp||null,sl_pct:sl||null,
        outcome:(tp&&sl)?firstHit(ks,entry,tp,sl):'OBSERVED'
      });
    }
  }

  const matured=rows.filter(r=>r.age_min>=175&&r.entry);
  const planned=matured.filter(r=>r.decision==='PLANNED');
  const rejected=matured.filter(r=>r.decision==='REJECTED_WINNER');

  function uniqueEpisodes(items){
    const bySymbol=new Map();
    for(const r of items.slice().sort((a,b)=>String(a.batch_id).localeCompare(String(b.batch_id)))){
      if(!bySymbol.has(r.symbol)) bySymbol.set(r.symbol,[]);
      const arr=bySymbol.get(r.symbol);
      const last=arr[arr.length-1];
      const t=Date.parse(String(r.batch_id||'').replace(/^precore-batch-/,'').replace(/-(\d{3})Z$/,'$1Z').replace(/-/g,':'));
      const lt=last?last._t:NaN;
      if(!last || !Number.isFinite(t) || !Number.isFinite(lt) || t-lt>=180*60000){
        arr.push({...r,_t:t});
      }
    }
    return [...bySymbol.values()].flat().map(({_t,...r})=>r);
  }

  const plannedUnique=uniqueEpisodes(planned);
  const rejectedUnique=uniqueEpisodes(rejected);
  const summary={
    research_only:true,shadow_only:true,no_order_created:true,production_action:'NONE',
    generated_at:new Date().toISOString(),
    plans_scanned:plans.length,observations:rows.length,matured: matured.length,
    matured_planned:planned.length,
    matured_planned_unique:plannedUnique.length,
    matured_rejected_winner_unique:rejectedUnique.length,
    planned_avg_return_pct:plannedUnique.length?+(plannedUnique.reduce((s,x)=>s+x.return_pct,0)/plannedUnique.length).toFixed(3):null,
    planned_avg_mfe_pct:plannedUnique.length?+(plannedUnique.reduce((s,x)=>s+x.mfe_pct,0)/plannedUnique.length).toFixed(3):null,
    planned_avg_mae_pct:plannedUnique.length?+(plannedUnique.reduce((s,x)=>s+x.mae_pct,0)/plannedUnique.length).toFixed(3):null,
    rejected_avg_return_pct:rejectedUnique.length?+(rejectedUnique.reduce((s,x)=>s+x.return_pct,0)/rejectedUnique.length).toFixed(3):null,
    rejected_avg_mfe_pct:rejectedUnique.length?+(rejectedUnique.reduce((s,x)=>s+x.mfe_pct,0)/rejectedUnique.length).toFixed(3):null,
    rejected_avg_mae_pct:rejectedUnique.length?+(rejectedUnique.reduce((s,x)=>s+x.mae_pct,0)/rejectedUnique.length).toFixed(3):null,
    tp_hits:plannedUnique.filter(x=>x.outcome==='TP_HIT').length,
    sl_hits:plannedUnique.filter(x=>x.outcome==='SL_HIT').length,
    rows
  };

  const lines=[
    '# Pre-CORE Batch Outcome Audit','',
    'Research/shadow only. No orders are created or modified.','',
    `Plans scanned: ${summary.plans_scanned} · observations: ${summary.observations} · matured planned snapshots: ${summary.matured_planned} · unique planned episodes: ${summary.matured_planned_unique} · unique rejected-winner episodes: ${summary.matured_rejected_winner_unique}`,
    `Unique planned avg return: ${summary.planned_avg_return_pct??'—'}% · avg MFE: ${summary.planned_avg_mfe_pct??'—'}% · avg MAE: ${summary.planned_avg_mae_pct??'—'}% · TP hits: ${summary.tp_hits} · SL hits: ${summary.sl_hits}`,
    `Unique rejected-winner avg return: ${summary.rejected_avg_return_pct??'—'}% · avg MFE: ${summary.rejected_avg_mfe_pct??'—'}% · avg MAE: ${summary.rejected_avg_mae_pct??'—'}%`,'',
    '| batch | symbol | decision | age | return | MFE | MAE | outcome |',
    '|---|---|---|---:|---:|---:|---:|---|'
  ];
  for(const r of rows.slice(0,60)){
    lines.push(`| ${r.batch_id||'—'} | ${r.symbol} | ${r.decision} | ${r.age_min??'—'}m | ${r.return_pct??'—'}% | ${r.mfe_pct??'—'}% | ${r.mae_pct??'—'}% | ${r.outcome||r.status||'—'} |`);
  }

  require('fs').writeFileSync('precore-batch-outcomes.json',JSON.stringify(summary,null,2));
  require('fs').writeFileSync('precore-batch-outcomes.md',lines.join('\n'));
  console.log(JSON.stringify(summary));

  if(TOKEN){
    const open=await gh('/issues?state=open&per_page=100');
    const found=open.find(i=>i.title===ISSUE_TITLE);
    const body=JSON.stringify({body:lines.join('\n')});
    if(found) await gh('/issues/'+found.number,{method:'PATCH',body});
    else await gh('/issues',{method:'POST',body:JSON.stringify({title:ISSUE_TITLE,body:lines.join('\n')})});
  }
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
