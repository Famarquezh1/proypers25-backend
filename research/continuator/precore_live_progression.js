'use strict';

const REPO=process.env.GITHUB_REPOSITORY||'Famarquezh1/proypers25-backend';
const TOKEN=process.env.GITHUB_TOKEN||'';
const WORKFLOW='core-precore-phased-shadow.yml';
const ISSUE_TITLE='[RESEARCH] Pre-CORE Live Progression';
const MAX_RUNS=40;
const ORDER={NONE:0,PRECURSOR_BUILDING:1,PASS1_EARLY:2,PASS2_ESCALATED:3,CORE_FORMING:4};

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
function extractResult(log){
  const lines=String(log||'').split(/\r?\n/);
  for(const line of lines){
    const p=line.indexOf('{"ok":true,"mode":"PRE_CORE_PHASED_SHADOW_V1"');
    if(p<0) continue;
    try{return JSON.parse(line.slice(p))}catch{}
  }
  return null;
}
async function main(){
  const runs=await gh('/actions/workflows/'+WORKFLOW+'/runs?status=completed&per_page='+MAX_RUNS);
  const completed=(runs.workflow_runs||[]).filter(r=>r.conclusion==='success').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const snapshots=[];
  for(const run of completed){
    const jobs=await gh('/actions/runs/'+run.id+'/jobs?per_page=20');
    const job=(jobs.jobs||[]).find(j=>j.name==='scan')||(jobs.jobs||[])[0];
    if(!job) continue;
    const r=await fetch('https://api.github.com/repos/'+REPO+'/actions/jobs/'+job.id+'/logs',{
      headers:{'Authorization':'Bearer '+TOKEN,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
    });
    if(!r.ok) continue;
    const result=extractResult(await r.text());
    if(result) snapshots.push({run_id:run.id,at:run.created_at,result});
  }

  const histories=new Map();
  for(const snap of snapshots){
    for(const row of snap.result.top||[]){
      if(!histories.has(row.symbol)) histories.set(row.symbol,[]);
      histories.get(row.symbol).push({at:snap.at,run_id:snap.run_id,stage:row.stage,pct24h:row.pct24h,score:row.score});
    }
  }

  const rows=[];
  let precursor=0,toPass1=0,toPass2=0,toCore=0;
  for(const [symbol,h] of histories){
    const first=h[0];
    if(first.stage!=='PRECURSOR_BUILDING') continue;
    precursor++;
    let max=1;
    for(const x of h) max=Math.max(max,ORDER[x.stage]||0);
    if(max>=2) toPass1++;
    if(max>=3) toPass2++;
    if(max>=4) toCore++;
    rows.push({
      symbol,seen:h.length,first:first.stage,max_stage:Object.keys(ORDER).find(k=>ORDER[k]===max),
      first_at:first.at,last_at:h[h.length-1].at,last_stage:h[h.length-1].stage,
      first_pct:first.pct24h,last_pct:h[h.length-1].pct24h
    });
  }
  rows.sort((a,b)=>(ORDER[b.max_stage]-ORDER[a.max_stage])||b.seen-a.seen);

  const pct=(n,d)=>d?+(100*n/d).toFixed(2):0;
  const result={
    research_only:true,shadow_only:true,no_order_created:true,production_action:'NONE',
    successful_snapshots:snapshots.length,
    unique_symbols:histories.size,
    precursor_cohort:precursor,
    converted_to_pass1:toPass1,pass1_rate_pct:pct(toPass1,precursor),
    converted_to_pass2:toPass2,pass2_rate_pct:pct(toPass2,precursor),
    converted_to_core:toCore,core_rate_pct:pct(toCore,precursor),
    rows
  };

  const lines=[
    '# Pre-CORE Live Progression','',
    'Research/shadow only. This measures stage progression across completed live shadow scans; it has zero execution influence.','',
    `Successful scans: ${result.successful_snapshots} · unique symbols observed: ${result.unique_symbols} · precursor cohort: ${result.precursor_cohort}`,
    `PRECURSOR → PASS1: **${result.converted_to_pass1}/${result.precursor_cohort} (${result.pass1_rate_pct}%)** · → PASS2: **${result.converted_to_pass2}/${result.precursor_cohort} (${result.pass2_rate_pct}%)** · → CORE_FORMING: **${result.converted_to_core}/${result.precursor_cohort} (${result.core_rate_pct}%)**`,'',
    '| symbol | seen | max stage | last stage | first 24h | last 24h |',
    '|---|---:|---|---|---:|---:|'
  ];
  for(const r of rows.slice(0,40)) lines.push(`| ${r.symbol} | ${r.seen} | ${r.max_stage} | ${r.last_stage} | ${r.first_pct}% | ${r.last_pct}% |`);

  require('fs').writeFileSync('precore-live-progression.json',JSON.stringify(result,null,2));
  require('fs').writeFileSync('precore-live-progression.md',lines.join('\n'));
  console.log(JSON.stringify(result));

  if(TOKEN){
    const open=await gh('/issues?state=open&per_page=100');
    const found=open.find(i=>i.title===ISSUE_TITLE);
    if(found) await gh('/issues/'+found.number,{method:'PATCH',body:JSON.stringify({body:lines.join('\n')})});
    else await gh('/issues',{method:'POST',body:JSON.stringify({title:ISSUE_TITLE,body:lines.join('\n')})});
  }
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
