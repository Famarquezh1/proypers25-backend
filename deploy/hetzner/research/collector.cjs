'use strict';
// Public market GETs only. Independent research ledger; no order credentials or runtime imports.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const END=Date.parse('2026-11-15T03:00:00Z'),FREEZE=Date.parse('2026-11-10T03:00:00Z');
const FEATURES=new Set(['last5mPct','last15mPct','last60mPct','range60mPct','spreadPct']);
function validate(p){
  if(!p||!/^\d{8}-v\d+$/.test(p.version)||!Array.isArray(p.candidates)||p.candidates.length<1||p.candidates.length>6)throw Error('PROPOSAL_SCHEMA');
  const ids=new Set();for(const c of p.candidates){if(!/^[a-z0-9-]{1,50}$/.test(c.id)||ids.has(c.id)||!Array.isArray(c.conditions)||c.conditions.length>6)throw Error('CANDIDATE_SCHEMA');ids.add(c.id);for(const q of c.conditions)if(!FEATURES.has(q.feature)||!['gt','lt'].includes(q.op)||!Number.isFinite(q.value)||Math.abs(q.value)>100)throw Error('CONDITION_SCHEMA');}
  return p;
}
function predict(c,f){return c.conditions.every(q=>Number.isFinite(f[q.feature])&&(q.op==='gt'?f[q.feature]>q.value:f[q.feature]<q.value));}
function features(bars,book,at){
  if(!Array.isArray(bars)||bars.length<12||bars.some(b=>Number(b[6])>=at)||!(Number(book.askPrice)>0&&Number(book.bidPrice)>0))throw Error('FEATURE_DATA_INVALID');
  const a=bars.slice(-12),last=Number(a[11][4]),pct=x=>(last/Number(x)-1)*100;
  const f={last5mPct:pct(a[11][1]),last15mPct:pct(a[9][1]),last60mPct:pct(a[0][1]),range60mPct:(Math.max(...a.map(b=>Number(b[2])))/Math.min(...a.map(b=>Number(b[3])))-1)*100,spreadPct:(Number(book.askPrice)/Number(book.bidPrice)-1)*100};
  if(Object.values(f).some(v=>!Number.isFinite(v)))throw Error('FEATURE_NUMBER_INVALID');return f;
}
function metric(rows){const n=rows.length,wins=rows.filter(r=>r.netPct>0),losses=rows.filter(r=>r.netPct<=0),gain=wins.reduce((s,r)=>s+r.netPct/10,0),loss=-losses.reduce((s,r)=>s+r.netPct/10,0);return {n,hypotheticalNetGainsUsdtAt10Each:gain,hypotheticalAbsoluteNetLossesUsdtAt10Each:loss,assumedCostsUsdtAt10Each:rows.reduce((s,r)=>s+(r.grossPct-r.netPct)/10,0),upAccuracy:n?rows.filter(r=>r.grossPct>0).length/n:null,netWins:wins.length,netLosses:losses.length,hypotheticalNetUsdtAt10Each:gain-loss,profitFactor:loss>0?gain/loss:null,meanNetPct:n?rows.reduce((s,r)=>s+r.netPct,0)/n:null};}
function report(ledger,now){
  const all=ledger.observations,groups={};
  for(const o of all)for(const p of o.predictions){const k=o.version+':'+p.id;groups[k]??={observed:0,selected:0,discovery:[],holdout:[]};const g=groups[k];g.observed++;if(!p.up)continue;g.selected++;if(o.outcome)g[o.at>=FREEZE?'holdout':'discovery'].push(o.outcome);}
  return {at:new Date(now).toISOString(),endsAt:new Date(END).toISOString(),freezeAt:new Date(FREEZE).toISOString(),mode:'RESEARCH_ONLY',realOrdersSent:0,observations:all.length,pending:all.filter(o=>!o.outcome).length,skippedCapture:ledger.skippedCapture||0,costAssumptionPct:.30,horizon:'60 to 61 minutes; minute close, hypothetical fixed 10 USDT per selected signal',notActualAccountPnl:true,groups:Object.fromEntries(Object.entries(groups).map(([k,g])=>[k,{observed:g.observed,selected:g.selected,discovery:metric(g.discovery),holdout:metric(g.holdout),promotion:'NOT_AUTHORIZED',evidence:g.holdout.length<30?'INSUFFICIENT_PROSPECTIVE_SAMPLE':'REQUIRES_INDEPENDENT_REVIEW'}]))};
}
function atomic(file,data){const t=file+'.'+process.pid+'.tmp';fs.writeFileSync(t,JSON.stringify(data),{mode:0o600});fs.renameSync(t,file);}
async function main(){
  const root=process.env.PROYPERS_RESEARCH_DIR||'/var/lib/proypers25/research',state='/var/lib/proypers25',now=Date.now();fs.mkdirSync(root,{recursive:true,mode:0o700});
  const lock=path.join(root,'collector.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(lock,'utf8'));if(!Number.isSafeInteger(pid)||pid<2)throw Error('LOCK_REVIEW');try{process.kill(pid,0);throw Error('COLLECTOR_RUNNING');}catch(x){if(x.code!=='ESRCH')throw x;}fs.unlinkSync(lock);fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}
  try{
    const p=validate(JSON.parse(fs.readFileSync(path.join(__dirname,'proposals.json'),'utf8'))),hash=crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const file=path.join(root,'ledger.json'),ledger=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{schema:1,observations:[],versions:{}};
    if(ledger.schema!==1||ledger.observations.length>5000)throw Error('LEDGER_SCOPE');
    if(ledger.versions[p.version]&&ledger.versions[p.version]!==hash)throw Error('VERSION_REUSED_WITH_DIFFERENT_PROPOSAL');
    if(now>=FREEZE){if(ledger.frozenHash&&ledger.frozenHash!==hash)throw Error('HOLDOUT_FROZEN');ledger.frozenHash=hash;}
    ledger.versions[p.version]=hash;let requests=0;
    async function get(endpoint,params){if(!['klines','ticker/bookTicker'].includes(endpoint)||++requests>14)throw Error('PUBLIC_READ_BUDGET');const r=await fetch('https://api.binance.com/api/v3/'+endpoint+'?'+new URLSearchParams(params),{method:'GET',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('PUBLIC_DATA_HTTP_'+r.status);return r.json();}
    let publicDataVerified=false,lastRadarAt=null,lastNotify=null;
    if(now<END){
      const probe=await get('ticker/bookTicker',{symbol:'BTCUSDT'});if(!(Number(probe.askPrice)>0&&Number(probe.bidPrice)>0))throw Error('PUBLIC_PROBE_INVALID');publicDataVerified=true;
      const radar=JSON.parse(fs.readFileSync(path.join(state,'radar-last.json'),'utf8')),s=radar.signal;
      lastRadarAt=radar.at;lastNotify=s?.notify===true;
      if(s?.notify===true&&/^[A-Z0-9]{2,24}USDT$/.test(s.symbol||'')&&now-Date.parse(radar.at)>=0&&now-Date.parse(radar.at)<=7*60000){
        const previous=ledger.observations.filter(o=>o.symbol===s.symbol).at(-1);
        if(!previous||now-previous.at>=20*60000){
          const [bars,book]=await Promise.all([get('klines',{symbol:s.symbol,interval:'5m',endTime:String(Math.floor(now/300000)*300000-1),limit:'12'}),get('ticker/bookTicker',{symbol:s.symbol})]);
          const at=Date.now();if(at-now>30000)throw Error('CAPTURE_TOO_SLOW');
          ledger.observations.push({id:crypto.createHash('sha256').update(s.symbol+':'+radar.at).digest('hex').slice(0,20),symbol:s.symbol,at,targetAt:Math.floor((at+3600000)/60000)*60000+59999,entryAsk:Number(book.askPrice),version:p.version,features:features(bars,book,now),predictions:p.candidates.map(c=>({id:c.id,up:predict(c,features(bars,book,now))}))});
          atomic(file,ledger);
        }
      }
    }
    // Labels are append-only and obtained only after the whole future candle has closed.
    for(const o of ledger.observations.filter(o=>!o.outcome&&o.targetAt+2000<now).slice(0,10)){
      const bars=await get('klines',{symbol:o.symbol,interval:'1m',startTime:String(o.targetAt-59999),endTime:String(o.targetAt),limit:'1'}),b=bars[0];
      if(!b||Number(b[6])!==o.targetAt||!(Number(b[4])>0))throw Error('LABEL_DATA_INVALID');
      const grossPct=(Number(b[4])/o.entryAsk-1)*100;o.outcome={grossPct,netPct:grossPct-.30,close:Number(b[4]),labelAt:now};atomic(file,ledger);
    }
    ledger.updatedAt=Date.now();atomic(file,ledger);const result=report(ledger,Date.now());atomic(path.join(root,'report.json'),result);atomic(path.join(root,'health.json'),{at:new Date().toISOString(),ok:true,requests,publicDataVerified,lastRadarAt,lastNotify,ended:now>=END,observations:ledger.observations.length});console.log('RESEARCH_CYCLE_OK',JSON.stringify(result));
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
module.exports={validate,predict,features,metric,report,END,FREEZE};
if(require.main===module)main().catch(e=>{console.error(/^\w+$/.test(e.message)?e.message:'RESEARCH_CYCLE_FAILED');process.exitCode=1;});
