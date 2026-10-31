'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assess,REQUIRED}=require('./cutover-check.cjs');
const {collect}=require('./collect-cutover.cjs');
function snapshot(){return {repository:'Famarquezh1/proypers25-backend',checkedAt:new Date().toISOString(),complete:true,
  workflows:REQUIRED.map(path=>({path,state:'disabled_manually',runs:[]}))};}
test('cutover inventory requires every legacy writer disabled and drained',()=>{
  const s=snapshot();assert.equal(assess(s).legacyWritersIsolated,true);assert.equal(assess(s).liveReady,false);
  s.workflows[0].state='active';assert.equal(assess(s).legacyWritersIsolated,false);
  s.workflows[0].state='disabled_manually';s.workflows[1].runs=[{status:'queued'}];assert.equal(assess(s).legacyWritersIsolated,false);
});
test('inventory collector checks all non-terminal statuses and rejects truncation or access errors',async()=>{
  for(const mode of ['normal','truncated','denied']){
    const result=await collect(async endpoint=>{
      if(mode==='denied')throw new Error('denied');
      if(!endpoint.includes('/runs?')){const file=endpoint.split('/').at(-1);return {id:REQUIRED.findIndex(p=>p.endsWith(file))+1,path:`.github/workflows/${file}`,state:'disabled_manually'};}
      return {total_count:mode==='truncated'?101:0,workflow_runs:[]};
    });
    assert.equal(result.report.legacyWritersIsolated,mode==='normal');
  }
});
test('missing, stale or truncated inventory cannot approve a cutover',()=>{
  for(const change of [s=>s.workflows.pop(),s=>s.complete=false,s=>s.checkedAt='2000-01-01',s=>delete s.workflows[0].runs]){
    const s=snapshot();change(s);assert.equal(assess(s).legacyWritersIsolated,false);
  }
});
