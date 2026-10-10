'use strict';

const REPO=process.env.GITHUB_REPOSITORY||'Famarquezh1/proypers25-backend';
const TOKEN=process.env.GITHUB_TOKEN||'';
const BASE='https://data-api.binance.vision';
const WORKFLOW='precore-batch-planner.yml';
const ISSUE_TITLE='[RESEARCH] Winner Continuation Gate Repair';
const MAX_RUNS=36;
const COST_PCT=0.20;

async function gh(path,options={}){
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
  const r=await fetch(url,{headers:{'user-agent':'proypers25-winner-gate-repair/1.0'}});
  if(!r.ok) throw new Error('HTTP '+r.status);
  return await r.json();
}
async function klines(symbol,start,end){
  const q=new URLSearchParams({symbol,interval:'5m',startTime:String(start),endTime:String(end),limit:'1000'});
  return await get(BASE+'/api/v3/klines?'+q.toString());
}
async function refAt(symbol,t){
  const ks=await klines(symbol,t-10*60000,t+5*60000);
  const k=ks.filter(r=>+r[0]<=t).at(-1)||ks[0];
  return k?+k[4]:0;
}
function extract(log){
  for(const line of String(log||'').split(/\r?\n/)){
    const p=line.indexOf('{"ok":true,"mode":"PRE_CORE_BATCH_PLANNER_V1"');
    if(p>=0){try{return JSON.parse(line.slice(p))}catch{}}
  }
  return null;
}
function first3Before1(rows,entry){
  for(const r of rows){
    const up=(+r[2]/entry-1)*100, dn=(+r[3]/entry-1)*100;
    if(up>=3&&dn<=-1)return null;
    if(up>=3)return true;
    if(dn<=-1)return false;
  }
  return false;
}
function metrics(rows){
  if(!rows.length)return {n:0};
  const vals=rows.map(r=>r.net_terminal_pct);
  const wins=vals.filter(x=>x>0),losses=vals.filter(x=>x<0);
  return {
    n:rows.length,
    avg_net_pct:+(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3),
    win_rate_pct:+(100*wins.length/vals.length).toFixed(2),
    avg_mfe_pct:+(rows.reduce((s,x)=>s+x.mfe_pct,0)/rows.length).toFixed(3),
    avg_mae_pct:+(rows.reduce((s,x)=>s+x.mae_pct,0)/rows.length).toFixed(3),
    continuator_3_before_1_pct:+(100*rows.filter(x=>x.hit3before1===true).length/rows.length).toFixed(2),
    pf:+(losses.length?wins.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0)):(wins.length?999:0)).toFixed(3)
  };
}
const RULES={
  CURRENT:x=>x.expected_net_pct>=0.2&&x.continuation_rate_pct>=45&&x.reward_risk>=1.35&&x.profit_factor>1,
  RELAX_CONT_20:x=>x.expected_net_pct>=0.2&&x.continuation_rate_pct>=20&&x.reward_risk>=1.2&&x.profit_factor>=1.2,
  QUALITY_PF:x=>x.expected_net_pct>=0.3&&x.profit_factor>=1.5&&x.reward_risk>=1.5&&x.continuation_rate_pct>=20,
  WINNER_BALANCED:x=>x.lane==='WINNER_CONTINUATION'&&x.pct24h>=5&&x.pct24h<35&&x.expected_net_pct>=0.2&&x.profit_factor>=1.2&&x.reward_risk>=1.2&&x.continuation_rate_pct>=20,
  WINNER_EXPECTANCY:x=>x.lane==='WINNER_CONTINUATION'&&x.pct24h>=5&&x.pct24h<35&&x.expected_net_pct>=0.3&&x.profit_factor>=1.4&&x.reward_risk>=1.3
};
async function main(){
  const runs=await gh('/actions/workflows/'+WORKFLOW+'/runs?status=completed&per_page='+MAX_RUNS);
  const raw=[];
  for(const run of (runs.workflow_runs||[]).filter(r=>r.conclusion==='success').sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))){
    const jobs=await gh('/actions/runs/'+run.id+'/jobs?per_page=20');
    const job=(jobs.jobs||[]).find(j=>j.name==='plan')||(jobs.jobs||[])[0];
    if(!job)continue;
    const lr=await fetch('https://api.github.com/repos/'+REPO+'/actions/jobs/'+job.id+'/logs',{
      headers:{'Authorization':'Bearer '+TOKEN,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
    });
    if(!lr.ok)continue;
    const p=extract(await lr.text());
    if(!p)continue;
    const t=Date.parse(p.generated_at);
    if(!Number.isFinite(t)||Date.now()<t+180*60000)continue;
    const items=[
      ...(p.slots||[]).map(x=>({...x,actual_decision:'PLANNED'})),
      ...(p.top_rejected||[]).filter(x=>x.lane==='WINNER_CONTINUATION').map(x=>({...x,actual_decision:'REJECTED'}))
    ];
    for(const x of items){
      if(!x.symbol)continue;
      let entry=Number(x.reference_price||0);
      if(!(entry>0))entry=await refAt(x.symbol,t);
      if(!(entry>0))continue;
      const ks=await klines(x.symbol,t,t+180*60000);
      if(ks.length<12)continue;
      const last=+ks.at(-1)[4], max=Math.max(...ks.map(k=>+k[2])), min=Math.min(...ks.map(k=>+k[3]));
      raw.push({
        t,run_id:run.id,symbol:x.symbol,lane:x.lane||'PRE_CORE',actual_decision:x.actual_decision,
        pct24h:Number(x.observed_pct24h??x.pct24h??0),score:Number(x.score||0),
        expected_net_pct:Number(x.expected_net_pct||0),
        continuation_rate_pct:Number(x.continuation_rate_pct||0),
        profit_factor:Number(x.profit_factor||0),
        reward_risk:Number(x.reward_risk||0),
        entry,
        terminal_pct:+((last/entry-1)*100).toFixed(3),
        net_terminal_pct:+(((last/entry-1)*100)-COST_PCT).toFixed(3),
        mfe_pct:+((max/entry-1)*100).toFixed(3),
        mae_pct:+((min/entry-1)*100).toFixed(3),
        hit3before1:first3Before1(ks,entry)
      });
    }
  }

  // One independent 3h episode per symbol.
  const bySymbol=new Map();
  for(const r of raw.sort((a,b)=>a.t-b.t)){
    if(!bySymbol.has(r.symbol))bySymbol.set(r.symbol,[]);
    const a=bySymbol.get(r.symbol),last=a.at(-1);
    if(!last||r.t-last.t>=180*60000)a.push(r);
  }
  const rows=[...bySymbol.values()].flat().sort((a,b)=>a.t-b.t);
  const cut=Math.max(1,Math.floor(rows.length*.7));
  const dev=rows.slice(0,cut),hold=rows.slice(cut);

  const report={research_only:true,shadow_only:true,no_order_created:true,production_action:'NONE',
    generated_at:new Date().toISOString(),episodes:rows.length,development_n:dev.length,holdout_n:hold.length,
    baseline_actual_planned:{dev:metrics(dev.filter(x=>x.actual_decision==='PLANNED')),holdout:metrics(hold.filter(x=>x.actual_decision==='PLANNED'))},
    baseline_rejected_winners:{dev:metrics(dev.filter(x=>x.actual_decision==='REJECTED')),holdout:metrics(hold.filter(x=>x.actual_decision==='REJECTED'))},
    rules:{}};
  const ranked=[];
  for(const [name,fn] of Object.entries(RULES)){
    const dm=metrics(dev.filter(fn)), hm=metrics(hold.filter(fn));
    report.rules[name]={development:dm,holdout:hm};
    if(dm.n>=5)ranked.push({name,m:dm});
  }
  ranked.sort((a,b)=>(b.m.avg_net_pct-a.m.avg_net_pct)||(b.m.pf-a.m.pf));
  report.chosen_on_development=ranked[0]?.name||null;
  report.chosen_holdout=report.chosen_on_development?report.rules[report.chosen_on_development].holdout:null;

  const lines=['# Winner Continuation Gate Repair','',
    'Research/shadow only. Fixed candidate rules are compared on chronological development/holdout episodes; no production orders or settings are changed.','',
    `Episodes: ${report.episodes} · development: ${report.development_n} · holdout: ${report.holdout_n}`,'',
    '| rule | dev n | dev net | dev PF | dev 3-before-1 | holdout n | holdout net | holdout PF | holdout 3-before-1 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const [name,r] of Object.entries(report.rules)){
    lines.push(`| ${name} | ${r.development.n||0} | ${r.development.avg_net_pct??'—'}% | ${r.development.pf??'—'} | ${r.development.continuator_3_before_1_pct??'—'}% | ${r.holdout.n||0} | ${r.holdout.avg_net_pct??'—'}% | ${r.holdout.pf??'—'} | ${r.holdout.continuator_3_before_1_pct??'—'}% |`);
  }
  lines.push('',`Chosen on development: **${report.chosen_on_development||'none'}**`);
  if(report.chosen_holdout)lines.push(`Unseen holdout: n=${report.chosen_holdout.n||0} · net=${report.chosen_holdout.avg_net_pct??'—'}% · PF=${report.chosen_holdout.pf??'—'} · 3-before-1=${report.chosen_holdout.continuator_3_before_1_pct??'—'}%`);
  lines.push('','No production change is authorized by this study.');

  require('fs').writeFileSync('winner-gate-repair.json',JSON.stringify({...report,rows},null,2));
  require('fs').writeFileSync('winner-gate-repair.md',lines.join('\n'));
  console.log(JSON.stringify(report));
  if(TOKEN){
    const open=await gh('/issues?state=open&per_page=100');
    const found=open.find(i=>i.title===ISSUE_TITLE);
    const body=JSON.stringify({body:lines.join('\n')});
    if(found)await gh('/issues/'+found.number,{method:'PATCH',body});
    else await gh('/issues',{method:'POST',body:JSON.stringify({title:ISSUE_TITLE,body:lines.join('\n')})});
  }
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
