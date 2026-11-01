'use strict';
// Read-only owner preflight. It never creates an authorization or starts the live service.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {audit}=require('./audit.cjs');
const {assess}=require('./cutover-check.cjs');
const STATES=new Set(['BUY_INTENT','BUY_UNKNOWN','BUY_PENDING','BUY_FILLED','PROTECTION_PENDING','STOP_INTENT','STOP_UNKNOWN',
  'SELL_INTENT','SELL_UNKNOWN','SELL_PENDING','SELL_REVIEW','SELL_PARTIAL','SELL_RESIDUAL_PENDING','STOP_REVIEW']);
async function check(){
  const blocks=[],state='/var/lib/proypers25';
  const release=path.basename(path.dirname(__dirname));
  const strategy=spawnSync('git',['-C','/opt/proypers25/repo','rev-parse','HEAD'],{encoding:'utf8'});
  if(strategy.status!==0||strategy.stdout.trim()!=='8d88021dea30eb87f786b5685818d01204d132a3')blocks.push('STRATEGY_PIN_MISMATCH');
  if(spawnSync('git',['-C','/opt/proypers25/repo','diff','--quiet','HEAD','--','backend']).status!==0)blocks.push('STRATEGY_WORKTREE_MODIFIED');
  const hashes=spawnSync('sha256sum',['--status','-c',path.join(__dirname,'SHA256SUMS')],{encoding:'utf8'});
  if(hashes.status!==0)blocks.push('RELEASE_HASH_MISMATCH');
  const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'release-evidence.json'),'utf8'));
  if(evidence.release!==release||evidence.offlineChecksPassed!==true)blocks.push('RELEASE_TEST_EVIDENCE_REQUIRED');
  for(const name of ['execution-state','exit-state','transition-state']){
    const dir=path.join(state,name);if(!fs.existsSync(dir))continue;
    for(const n of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n))){
      const r=JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
      const terminal=name==='transition-state'?['REPLACED','RESTORED','OLD_RETAINED','CLOSED','STAGING_BLOCKED']:
        name==='exit-state'?['SELL_FILLED','SELL_COMPLETED','SELL_DUST','SELL_REMAINDER_PROTECTED','STOP_ACTIVE']:['PROTECTED','CLOSED','REJECTED','NO_FILL'];
      if(STATES.has(r.state)||!terminal.includes(r.state))blocks.push('PENDING_EXECUTION_REVIEW');
    }
  }
  try{
    const inventory=JSON.parse(fs.readFileSync(path.join(state,'cutover-inventory.json'),'utf8'));
    const result=assess(inventory.snapshot);
    if(!result.legacyWritersIsolated)blocks.push(...result.reasons);
  }catch{blocks.push('FRESH_CUTOVER_INVENTORY_REQUIRED');}
  const report=await audit();
  if(!report.accountCanTrade)blocks.push('ACCOUNT_CANNOT_TRADE');
  if(fs.existsSync(path.join(state,'BUY_PAUSED')))blocks.push('OWNER_BUY_PAUSE_IS_SET');
  if(!report.security.reading||!report.security.spotPermission)blocks.push('OWNER_MUST_ENABLE_SPOT_PERMISSION');
  if(report.security.futuresPermission||report.security.transferPermission)blocks.push('EXCESS_API_PERMISSIONS');
  if(report.positions.some(p=>p.status!=='DUST')||report.openOrderCount!==0)blocks.push('INITIAL_CUTOVER_REQUIRES_DUST_ONLY_AND_NO_OPEN_ORDERS');
  const result={at:new Date().toISOString(),release,mode:'LIVE_CORE_ONLY',readyToActivate:blocks.length===0,
    blocks:[...new Set(blocks)],positionStatuses:report.positions.map(p=>p.status),openOrders:report.openOrderCount,tradingActivated:false};
  fs.writeFileSync('/etc/proypers25/activation-check.json',JSON.stringify(result),{mode:0o600});
  console.log(JSON.stringify(result));return result;
}
if(require.main===module)check().then(r=>{if(process.argv.includes('--require-ready')&&!r.readyToActivate)process.exitCode=2;}).catch(()=>{console.error('OWNER_PREFLIGHT_FAILED');process.exitCode=2;});
module.exports={check};
