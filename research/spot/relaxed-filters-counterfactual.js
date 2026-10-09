'use strict';

const REPO=process.env.GITHUB_REPOSITORY||'Famarquezh1/proypers25-backend';
const TOKEN=process.env.GITHUB_TOKEN||'';
const LIMIT=30;
const ISSUE_TITLE='[RESEARCH] Spot relaxed filters counterfactual';

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
function classify(reason=''){
  if(reason.includes('Local microvalidation blocked: MOMENTUM_CONTINUATION_WEAK')){
    return {relaxed:'PASS_TWO_FILTERS',cause:'MOMENTUM_CONTINUATION_WEAK'};
  }
  if(reason.includes('CORE real entry requires 3/3 V4.2 quality')){
    return {relaxed:'PASS_TWO_FILTERS',cause:'CORE_QUALITY_REQUIRED'};
  }
  return {relaxed:'STILL_REJECTED',cause:reason||'UNKNOWN'};
}
function parseReason(comment=''){
  const m=comment.match(/Motivo:\s*([^\n]+)/i);
  return m?m[1].trim():'';
}
async function main(){
  const issues=await gh('/issues?state=all&per_page=100&sort=updated&direction=desc');
  const signals=issues.filter(i=>/^\[SPOT SIGNAL\]/.test(i.title||'')).slice(0,LIMIT);
  const rows=[];
  for(const i of signals){
    const comments=await gh('/issues/'+i.number+'/comments?per_page=100');
    const decision=[...comments].reverse().find(c=>/Oportunidad descartada automáticamente por el PC local|validación autónoma local aprobó/i.test(c.body||''));
    if(!decision) continue;
    const executed=/ejecutó la compra Spot/i.test(decision.body||'');
    const reason=executed?'EXECUTED':parseReason(decision.body||'');
    const c=executed?{relaxed:'ALREADY_EXECUTED',cause:'EXECUTED'}:classify(reason);
    rows.push({issue:i.number,title:i.title,executed,reason,...c});
  }
  const declined=rows.filter(r=>!r.executed);
  const wouldPass=declined.filter(r=>r.relaxed==='PASS_TWO_FILTERS');
  const still=declined.filter(r=>r.relaxed==='STILL_REJECTED');
  const result={
    research_only:true,shadow_only:true,no_order_created:true,production_action:'NONE',
    scanned_signals:signals.length,decisions_found:rows.length,already_executed:rows.filter(r=>r.executed).length,
    declined:declined.length,would_pass_two_relaxed_filters:wouldPass.length,still_rejected:still.length,
    rows
  };
  const lines=[
    '# Spot relaxed filters counterfactual','',
    'Research/shadow only. No production settings or Binance orders are changed.','',
    `Scanned signals: ${result.scanned_signals} · decisions found: ${result.decisions_found} · declined: ${result.declined} · would pass the two relaxed filters: ${result.would_pass_two_relaxed_filters} · still rejected: ${result.still_rejected}`,'',
    '| issue | signal | actual reason | relaxed result |',
    '|---:|---|---|---|'
  ];
  for(const r of rows){
    lines.push(`| #${r.issue} | ${String(r.title).replace(/\|/g,'/')} | ${String(r.reason).replace(/\|/g,'/')} | ${r.relaxed} |`);
  }
  require('fs').writeFileSync('spot-relaxed-filters-counterfactual.json',JSON.stringify(result,null,2));
  require('fs').writeFileSync('spot-relaxed-filters-counterfactual.md',lines.join('\n'));
  console.log(JSON.stringify(result));
  if(TOKEN){
    const open=await gh('/issues?state=open&per_page=100');
    const found=open.find(i=>i.title===ISSUE_TITLE);
    const body=JSON.stringify({body:lines.join('\n')});
    if(found) await gh('/issues/'+found.number,{method:'PATCH',body});
    else await gh('/issues',{method:'POST',body:JSON.stringify({title:ISSUE_TITLE,body:lines.join('\n')})});
  }
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
