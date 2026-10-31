'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {audit}=require('./audit.cjs');
const {atomic,Journal}=require('./journal.cjs');
const state=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25';
const repo=process.env.PROYPERS_REPO||'/opt/proypers25/repo';
const backend=path.join(repo,'backend');
const guard=path.join(__dirname,'readonly.cjs');
const journal=new Journal(path.join(state,'intents'));
const allowed=new Set(['github-spot-production-radar-v42-active.js','github-spot-manual-execution-v10-aware.js','github-spot-auto-exit.js','recover-orders.cjs']);
let stopping=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function summary(event,data={}) {console.log(JSON.stringify({at:new Date().toISOString(),event,mode:'STAGING_READ_ONLY',tradingActivated:false,...data}));}
function redact(text) {
  for(const name of ['binance-key','binance-secret']){
    const file=path.join(process.env.CREDENTIALS_DIRECTORY||'/nonexistent',name);
    if(fs.existsSync(file)){const secret=fs.readFileSync(file,'utf8').trim();if(secret)text=text.split(secret).join('[REDACTED]');}
  }
  return text.replace(/signature=[a-f0-9]+/gi,'signature=[REDACTED]');
}
async function run(script,extra={},timeoutMs=150000) {
  if(!allowed.has(script))throw new Error('SCRIPT_NOT_ALLOWED');
  const env={PATH:process.env.PATH,HOME:state,LANG:'C.UTF-8',NODE_OPTIONS:`--require=${guard}`,
    PROYPERS_STAGING_PRELOAD:'1',CREDENTIALS_DIRECTORY:process.env.CREDENTIALS_DIRECTORY,
    PROYPERS_LOCAL_STATE_DIR:state,PROYPERS_MANAGED_CONTEXT:path.join(__dirname,'managed-context.json'),
    PROYPERS_STATE_DIR:state,PROYPERS_REPO:repo,
    GITHUB_REPOSITORY:'Famarquezh1/proypers25-backend',GITHUB_TOKEN:'LOCAL_SNAPSHOT_ONLY',
    QUBO_V5_ADAPTIVE_CONFIG:path.join(__dirname,'adaptive-model.json'),...extra};
  if(script.includes('radar'))delete env.CREDENTIALS_DIRECTORY;
  return new Promise(resolve=>{
    const safeEntry=script==='github-spot-manual-execution-v10-aware.js'||script==='recover-orders.cjs';
    const target=safeEntry?path.join(__dirname,'entry-safe.cjs'):path.join(backend,'scripts',script);
    const args=['--require',guard,target,...(script==='recover-orders.cjs'?['--recover-only']:[])];
    const child=spawn(process.execPath,args,{cwd:backend,env,detached:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,closed=false;
    const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>1048576)stop();});
    child.stderr.on('data',data=>{stderr+=data;if(stderr.length>1048576)stop();});
    const done=(code)=>{if(closed)return;closed=true;clearTimeout(timer);
      atomic(path.join(state,`${script}.last.json`),{at:new Date().toISOString(),code,timedOut,stdout:redact(stdout.slice(-1048576)),stderr:redact(stderr.slice(-1048576))});
      const blocked=(stderr.match(/SHADOW_WRITE_BLOCKED/g)||[]).length;
      summary('SCRIPT_FINISHED',{script,code,timedOut,blockedWrites:blocked});resolve({code,timedOut,stdout,blocked});};
    child.on('error',()=>done(-1));child.on('close',done);
  });
}
async function cycle(scanDue) {
  if(!process.env.CREDENTIALS_DIRECTORY||!fs.existsSync(path.join(process.env.CREDENTIALS_DIRECTORY,'trading-disabled')))throw new Error('TRADING_DISABLED_MARKER_REQUIRED');
  const recovery=await run('recover-orders.cjs',{},90000);
  if(recovery.code!==0)summary('NEW_BUYS_BLOCKED_PENDING_RECOVERY');
  const report=await audit();atomic(path.join(state,'position-audit.json'),report);
  summary('ACCOUNT_AUDIT',{reviewRequired:report.reviewRequired,positions:report.positions.length,
    openOrders:report.openOrderCount,security:report.security});
  if(scanDue){
    // Original exit chain, including XEC/V61/V10/orphans, with every mutation blocked.
    const exits=await run('github-spot-auto-exit.js',{},150000);
    const scan=await run('github-spot-production-radar-v42-active.js',{},180000);
    if(scan.code!==0)throw new Error('RADAR_FAILED');
    let signal;try{signal=JSON.parse(scan.stdout.trim());}catch{throw new Error('RADAR_OUTPUT_INVALID');}
    atomic(path.join(state,'radar-last.json'),{at:new Date().toISOString(),signal});
    if(signal.notify===true&&recovery.code===0){
      const latestFile=path.join(state,'signal-dedupe.json');
      const latest=fs.existsSync(latestFile)?JSON.parse(fs.readFileSync(latestFile,'utf8')):{};
      const now=Date.now();
      if(now-Number(latest[signal.symbol]||0)>=20*60000){
        const payload={symbol:signal.symbol,createdAt:new Date(now).toISOString(),lane:'CORE',price:signal.price,pct:signal.pct};
        const intent=journal.claim(payload);
        latest[signal.symbol]=now;atomic(latestFile,latest);
        if(intent){
          const output=path.join(state,'entry-output.txt');fs.writeFileSync(output,'',{mode:0o600});
          const entry=await run('github-spot-manual-execution-v10-aware.js',{SIGNAL_SYMBOL:payload.symbol,SIGNAL_PRICE:String(payload.price),
            SIGNAL_PCT:String(payload.pct),SIGNAL_CREATED_AT:payload.createdAt,SIGNAL_LANE:payload.lane,GITHUB_OUTPUT:output},150000);
          journal.finish(intent,{code:entry.code,blockedWrites:entry.blocked,outcome:fs.readFileSync(output,'utf8').slice(0,8192)});
        }
      }
    }
    atomic(path.join(state,'shadow-status.json'),{at:new Date().toISOString(),exitCode:exits.code,radarCode:scan.code,tradingActivated:false,liveReady:false});
  }
  atomic(path.join(state,'heartbeat.json'),{at:new Date().toISOString(),pid:process.pid,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),mode:'STAGING_READ_ONLY',tradingActivated:false,liveReady:false,newBuysBlocked:recovery.code!==0});
}
async function main(){
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  const lock=path.join(state,'engine.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.fsyncSync(fd);}catch(e){
    if(e.code!=='EEXIST')throw e;
    const prior=Number(fs.readFileSync(lock,'utf8'));
    if(!Number.isSafeInteger(prior)||prior<2)throw new Error('LOCK_REVIEW_REQUIRED');
    try{process.kill(prior,0);throw new Error('ENGINE_ALREADY_RUNNING');}catch(err){if(err.code!=='ESRCH')throw err;}
    fs.unlinkSync(lock);fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.fsyncSync(fd);
  }
  const clean=()=>{try{fs.closeSync(fd);fs.unlinkSync(lock);}catch{}};
  process.once('exit',clean);
  process.on('SIGTERM',()=>{stopping=true;});
  process.on('SIGINT',()=>{stopping=true;});
  summary('ENGINE_STARTED');let nextScan=0;
  while(!stopping){
    const scanDue=Date.now()>=nextScan;
    try{await cycle(scanDue);if(scanDue)nextScan=Date.now()+5*60000;}
    catch(error){summary('CYCLE_FAILED',{reason:/^[A-Z_0-9]+$/.test(error.message)?error.message:'STAGING_CYCLE_FAILED'});throw new Error('STAGING_CYCLE_FAILED');}
    if(process.argv.includes('--once'))break;
    for(let i=0;i<60&&!stopping;i++)await sleep(1000);
  }
}
if(require.main===module)main().catch(()=>{summary('ENGINE_FAILED');process.exitCode=1;});
module.exports={run,cycle};
