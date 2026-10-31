'use strict';
const fs=require('node:fs');
const {assess,REQUIRED}=require('./cutover-check.cjs');
async function collect(get,now=Date.now()){
  const snapshot={repository:'Famarquezh1/proypers25-backend',checkedAt:new Date(now).toISOString(),complete:true,workflows:[]};
  for(const target of REQUIRED){
    try{
      const w=await get(`/actions/workflows/${target.split('/').at(-1)}`);
      if(w.path!==target||!w.id)throw new Error('WORKFLOW_IDENTITY_INVALID');
      const runs=[];
      for(const status of ['queued','in_progress','waiting','requested','pending']){
        const page=await get(`/actions/workflows/${w.id}/runs?status=${status}&per_page=100`);
        if(!Array.isArray(page.workflow_runs)||!Number.isInteger(page.total_count)||page.total_count!==page.workflow_runs.length)throw new Error('TRUNCATED_RUNS');
        if(page.workflow_runs.some(r=>r.workflow_id!==w.id||r.status!==status))throw new Error('RUN_IDENTITY_INVALID');
        runs.push(...page.workflow_runs.map(r=>({id:r.id,status:r.status})));
      }
      snapshot.workflows.push({path:w.path,state:w.state,runs});
    }catch{snapshot.complete=false;}
  }
  return {snapshot,report:assess(snapshot,now)};
}
if(require.main===module){
  const token=process.env.GH_TOKEN;
  if(!token)throw new Error('GITHUB_READ_TOKEN_REQUIRED');
  collect(async endpoint=>{
    const r=await fetch(`https://api.github.com/repos/Famarquezh1/proypers25-backend${endpoint}`,{
      headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw new Error('INVENTORY_READ_FAILED');return r.json();
  }).then(result=>{
    fs.writeFileSync(process.argv[2],JSON.stringify(result),{mode:0o600});
    console.log(JSON.stringify(result.report));
  }).catch(()=>{console.error('CUTOVER_INVENTORY_FAILED');process.exitCode=2;});
}
module.exports={collect};
