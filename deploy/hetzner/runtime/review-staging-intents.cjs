'use strict';
// One-time migration of legacy LOCAL stop refusals, never exchange-unknown executions.
// Preserve the complete record and evidence in a private archive; do not submit orders.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {makeFetch}=require('./readonly.cjs');
const {atomic}=require('./journal.cjs');
const {audit}=require('./audit.cjs');
async function main(){
  const state='/var/lib/proypers25',dir=path.join(state,'exit-state');
  const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)):[];
  const selected=files.map(n=>({file:path.join(dir,n),record:JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))}))
    .filter(({record:r})=>r.state==='STOP_REVIEW'&&!r.order&&['STOP_LOSS','STOP_LOSS_LIMIT'].includes(r.orderType));
  if(!selected.length){console.log('STAGING_REFUSAL_REVIEW archived=0');return;}
  if(process.getuid()!==0||fs.existsSync('/etc/proypers25/LIVE_AUTHORIZATION.json')||!fs.existsSync('/etc/proypers25/TRADING_DISABLED'))throw new Error('STAGING_ONLY_REVIEW_REQUIRED');
  const started=execFileSync('systemctl',['show','proypers25-live.service','-p','ExecMainStartTimestampMonotonic','--value'],{encoding:'utf8'}).trim();
  if(started!=='0')throw new Error('LIVE_SERVICE_HISTORY_REQUIRES_OWNER_REVIEW');
  const report=await audit();
  if(report.security.spotPermission||report.openOrderCount||report.positions.some(p=>p.status!=='DUST'))throw new Error('EXCHANGE_STATE_REQUIRES_OWNER_REVIEW');
  const creds=process.env.CREDENTIALS_DIRECTORY,key=fs.readFileSync(path.join(creds,'binance-key'),'utf8').trim(),secret=fs.readFileSync(path.join(creds,'binance-secret'),'utf8').trim();
  const transport=makeFetch();let archived=0;
  for(const {file,record:r} of selected){
    const time=Date.parse(r.updatedAt);if(!Number.isFinite(time))throw new Error('STAGING_TIMESTAMP_REQUIRED');
    const date=t=>new Date(t).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC');
    const journal=execFileSync('journalctl',['-u','proypers25-engine.service','--since',date(time-120000),'--until',date(time+180000),'-o','cat','--no-pager'],{encoding:'utf8',maxBuffer:2097152});
    if(!journal.includes('"mode":"STAGING_READ_ONLY"')||!journal.includes('"tradingActivated":false')||!journal.match(/"blockedWrites":[1-9]/))throw new Error('LOCAL_REFUSAL_JOURNAL_EVIDENCE_REQUIRED');
    const q=new URLSearchParams({symbol:r.symbol,origClientOrderId:r.clientId,recvWindow:'5000',timestamp:String(Date.now())});
    q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));
    const response=await transport(`https://api.binance.com/api/v3/order?${q}`,{method:'GET',headers:{'X-MBX-APIKEY':key}});
    const body=await response.json();if(response.status!==400||body.code!==-2013)throw new Error('ORDER_HISTORY_REQUIRES_OWNER_REVIEW');
    const archive=path.join(state,'review-archive',path.basename(file));
    if(fs.existsSync(archive))throw new Error('STAGING_ARCHIVE_ALREADY_EXISTS_REVIEW_REQUIRED');
    atomic(archive,{at:new Date().toISOString(),reason:'REVIEWED_LEGACY_STAGING_LOCAL_REFUSAL',record:r,
      evidence:{liveServiceNeverStarted:true,spotPermission:false,openOrders:0,allBalancesDust:true,orderLookupCode:-2013,
        journalHash:crypto.createHash('sha256').update(journal).digest('hex')}});
    fs.unlinkSync(file);const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    archived++;
  }
  console.log(`STAGING_REFUSAL_REVIEW archived=${archived} real_orders_sent=0`);
}
main().catch(error=>{console.error(/^[A-Z_]+$/.test(error.message)?error.message:'STAGING_REFUSAL_REVIEW_FAILED');process.exitCode=2;});
