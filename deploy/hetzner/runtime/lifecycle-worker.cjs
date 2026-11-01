'use strict';
const path=require('node:path');
const {exchange}=require('./lifecycle-fixture.cjs');
const {createExitSafety}=require('./exit-safety.cjs');
const {createTransitions}=require('./protection-transition.cjs');
const {lock}=require('./execution-safety.cjs');
async function main(){
  const dir=process.env.SPOT_TEST_DIR;if(!dir)throw new Error('OFFLINE_DIRECTORY_REQUIRED');
  const release=lock(path.join(dir,'execution-state'));process.once('exit',release);
  const e=exchange(dir,process.env.SPOT_TEST_CASE);
  const safety=createExitSafety({transport:e.transport,dir:path.join(dir,'exit-state'),key:'fixture',secret:'fixture'});
  const transitions=createTransitions({transport:e.transport,dir:path.join(dir,'transition-state'),key:'fixture',secret:'fixture',resumeSell:safety.resumeConfirmedSell});
  if(process.argv.includes('--exit'))await transitions.exit({symbol:'SOLUSDT',oldOrder:e.load().stops.find(o=>o.status==='NEW'),info:e.info,managedQty:e.load().qty});
  if(process.argv.includes('--tighten'))await transitions.tighten({symbol:'SOLUSDT',oldOrder:e.load().stops[0],info:e.info,stopPrice:100});
  const a=await safety.recover(),b=await transitions.recover();
  console.log(JSON.stringify({pending:a.pending+b.pending,states:transitions.records().map(r=>r.state),sellStates:safety.records().map(r=>r.state)}));
}
main().catch(()=>{console.error('LIFECYCLE_RECONCILIATION_PENDING');process.exitCode=2;});
