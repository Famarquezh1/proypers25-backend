'use strict';
// Read-only inventory gate. It cannot enable either executor or disable protective monitoring.
const REQUIRED=['.github/workflows/spot-manual-approval.yml','.github/workflows/spot-auto-exit-local.yml','.github/workflows/spot-dust-under-one-usdt.yml',
  '.github/workflows/spot-github-radar.yml','.github/workflows/spot-microflow-hunter-v10.yml'];
function assess(snapshot,now=Date.now()){
  const reasons=[];
  const age=now-Date.parse(snapshot.checkedAt);
  if(!Number.isFinite(age)||age<0||age>120000)reasons.push('STALE_OR_INVALID_INVENTORY');
  if(snapshot.repository!=='Famarquezh1/proypers25-backend'||snapshot.complete!==true)reasons.push('INCOMPLETE_EXECUTOR_INVENTORY');
  for(const target of REQUIRED){
    const workflow=snapshot.workflows?.find(w=>w.path===target);
    if(!workflow||!['disabled_manually','disabled_inactivity'].includes(workflow.state))reasons.push(`LEGACY_WRITER_NOT_DISABLED:${target}`);
    if(!Array.isArray(workflow?.runs)||workflow.runs.some(r=>r.status!=='completed'))reasons.push(`LEGACY_WRITER_NOT_DRAINED:${target}`);
  }
  return {checkedAt:snapshot.checkedAt,legacyWritersIsolated:reasons.length===0,reasons,
    tradingActivated:false,liveReady:false};
}
if(require.main===module){
  const fs=require('node:fs');
  try{const report=assess(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));console.log(JSON.stringify(report));process.exitCode=report.legacyWritersIsolated?0:2;}
  catch{console.error('CUTOVER_CHECK_FAILED');process.exitCode=2;}
}
module.exports={assess,REQUIRED};
