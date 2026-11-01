'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {atomic}=require('./journal.cjs');
function validate(result) {
  if(result?.ok!==true||typeof result.notify!=='boolean'||result.lane!=='V10_HUNTER')throw new Error('V10_OUTPUT_INVALID');
  if(result.notify) {
    if(!/^[A-Z0-9]+USDT$/.test(result.symbol)||!(Number(result.price)>0)||!Number.isFinite(result.pct)||
       !Number.isFinite(result.microflow_score)||!Number.isFinite(result.microflow_margin)||!Number.isFinite(result.score_cut)||
       !(result.margin_cut===null||Number.isFinite(result.margin_cut))||
       !(result.calibration?.avgNet>0&&result.calibration.growth>0&&result.calibration.avgAlpha>0&&result.calibration.top10HitRate>.18&&result.calibration.stopRate<.68)||
       result.trained_samples<800||result.calibration_samples<300||result.maximum_real_order_usdt!==10||
       result.exit_policy?.hard_stop!==.012||result.exit_policy?.take_profit!==.03||result.exit_policy?.timeout_minutes!==180)
      throw new Error('V10_CALIBRATION_OR_POLICY_INVALID');
  }
  return result;
}
function fresh(snapshot,now=Date.now()) {
  if(snapshot?.version!==1||snapshot.code!==0)return null;
  const age=now-Date.parse(snapshot.completedAt);
  if(!Number.isFinite(age)||age<0||age>20*60000)return null;
  const r=validate(snapshot.result);
  if(r.notify){const ageTarget=now-Date.parse(r.target);if(!Number.isFinite(ageTarget)||ageTarget<0||ageTarget>30*60000)return null;}
  return r;
}
async function scan() {
  const state=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25';
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  const repo=process.env.PROYPERS_REPO||'/opt/proypers25/repo';
  const guard=path.join(__dirname,'readonly.cjs');
  const startedAt=new Date().toISOString();
  const result=await new Promise(resolve=>{
    const child=spawn(process.execPath,['--max-old-space-size=384','--require',guard,path.join(repo,'backend/scripts/github-spot-microflow-hunter-v10.js')],{
      cwd:path.join(repo,'backend'),env:{PATH:process.env.PATH,HOME:state,LANG:'C.UTF-8',
        NODE_OPTIONS:`--require=${guard}`,PROYPERS_STAGING_PRELOAD:'1',V8_MAX_SYMBOLS:'40',V8_MIN_QV:'200000'},
      stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',expired=false,done=false;
    const timeout=setTimeout(()=>{expired=true;child.kill('SIGKILL');},240000);
    child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1048576)child.kill('SIGKILL');});
    child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1048576)child.kill('SIGKILL');});
    const finish=code=>{if(done)return;done=true;clearTimeout(timeout);resolve({code:expired?124:code,stdout,stderr});};
    child.on('error',()=>finish(-1));child.on('close',finish);
  });
  let output;
  try{if(result.code!==0)throw new Error('V10_PROCESS_FAILED');output=validate(JSON.parse(result.stdout.trim()));}
  catch{atomic(path.join(state,'v10-last.json'),{version:1,startedAt,completedAt:new Date().toISOString(),code:result.code||2,tradingActivated:false});throw new Error('V10_SCAN_FAILED');}
  atomic(path.join(state,'v10-last.json'),{version:1,release:process.env.PROYPERS_RELEASE_ID,startedAt,completedAt:new Date().toISOString(),code:0,result:output,tradingActivated:false});
  console.log(JSON.stringify({event:'V10_SCAN_COMPLETE',notify:output.notify,reason:output.reason||'calibrated signal',tradingActivated:false}));
}
if(require.main===module)scan().catch(()=>{console.error('V10_SCAN_FAILED');process.exitCode=2;});
module.exports={validate,fresh};
