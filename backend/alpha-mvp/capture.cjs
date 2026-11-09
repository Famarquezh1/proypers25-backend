'use strict';
// Passive filesystem evidence collector. Runs independently of trading processes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25';
const h=x=>crypto.createHash('sha256').update(x).digest('hex');
function json(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}}
function rows(dir,pattern){if(!fs.existsSync(dir))return[];return fs.readdirSync(dir).filter(f=>pattern.test(f)).map(f=>json(path.join(dir,f))).filter(Boolean);}
function write(p,data){fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,p);}
function strategySnapshot(opts={}){
 const repo=opts.repo||process.env.PROYPERS_REPO||'/opt/proypers25/repo',runtime=opts.runtimeDir||'/opt/proypers25/runtime';
 const inputs=['backend/scripts/github-spot-production-radar-v42.js','backend/scripts/github-spot-manual-execution-v10-aware.js','backend/scripts/github-spot-manual-execution.js','backend/scripts/github-spot-auto-exit-legacy-v10-aware.js','backend/scripts/github-spot-auto-exit-legacy.js','backend/config/spot-qubo-production-v5.json','backend/config/spot-exit-policy-v2.json','backend/config/spot-growth-engine-v1.json'];
 const parts=[],missing=[];
 for(const file of inputs){const p=path.join(repo,file);if(fs.existsSync(p))parts.push([file,h(fs.readFileSync(p))]);else missing.push(file);}
 for(const file of ['engine.cjs','exit-integration.cjs','entry-safe.cjs','exit-safe.cjs']){const p=path.join(runtime,file);if(fs.existsSync(p))parts.push(['runtime/'+file,h(fs.readFileSync(p))]);else missing.push('runtime/'+file);}
 const adaptive=process.env.QUBO_V5_ADAPTIVE_CONFIG||path.join(runtime,'adaptive-model.json');
 if(fs.existsSync(adaptive))parts.push(['adaptive-qubo',h(fs.readFileSync(adaptive))]);
 let commit=null;try{const head=fs.readFileSync(path.join(repo,'.git/HEAD'),'utf8').trim();commit=head.startsWith('ref: ')?fs.readFileSync(path.join(repo,'.git',head.slice(5)),'utf8').trim():head;}catch{}
 return{strategy_version:missing.length?null:'RADAR_V42_QUBO_V5_ENTRY_V61',strategy_hash:missing.length?null:h(JSON.stringify(parts)),manifest:parts,missing_config:missing,git_commit:commit};
}
function parseEntryOutput(output,symbol,orderId){
 const lines=String(output?.stdout||'').split(/\r?\n/);
 const created=lines.find(x=>x.startsWith('ORDER_CREATED symbol='+symbol+' '));
 const found=created?.match(/orderId=([^ ]+)/)?.[1]||null;
 if(!found||String(found)!==String(orderId))return{};
 const approved=lines.find(x=>x.startsWith('APPROVED_V61 ')&&x.includes('symbol='+symbol+' '));
 const growth=lines.find(x=>x.startsWith('GROWTH_ENGINE_V1 '));
 const number=(line,key)=>{const v=line?.match(new RegExp('(?:^| )'+key+'=([^ ]+)'))?.[1];return v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;};
 return{entry_v61_decision:approved?{entry_score:number(approved,'v61_score'),conviction_tier:approved.match(/conviction_tier=([^ ]+)/)?.[1]||null}:null,capital_at_entry_usdt:number(growth,'equity_usdt'),entry_reason:approved?'APPROVED_V61':null};
}
function captureOnce({state=ROOT,repo,runtimeDir}={}){
 const entries=rows(path.join(state,'execution-state'),/^[a-f0-9]{32}\.json$/),intents=rows(path.join(state,'intents'),/^[a-f0-9]{24}\.json$/);
 const radar=json(path.join(state,'radar-last.json')),output=json(path.join(state,'github-spot-manual-execution-v10-aware.js.last.json'));
 const manifest=strategySnapshot({repo,runtimeDir}),target=path.join(state,'alpha-mvp','records');let updated=0;
 for(const entry of entries){
  if(!entry.buy?.orderId||!entry.symbol||!entry.createdAt)continue;
  const orderId=String(entry.buy.orderId),p=path.join(target,h(entry.symbol+':'+orderId).slice(0,32)+'.json'),old=json(p)||{};
  const intent=intents.find(x=>x.signal?.symbol===entry.symbol&&x.signal?.createdAt===entry.createdAt&&x.signal?.lane===entry.lane);
  const matching=radar?.signal?.symbol===entry.symbol&&Number.isFinite(Date.parse(radar.at))&&Math.abs(Date.parse(radar.at)-Date.parse(entry.createdAt))<120000;
  const signal=matching?radar.signal:null;
  const parsed=parseEntryOutput(output,entry.symbol,orderId);
  const timely=Math.abs(Date.now()-Date.parse(entry.createdAt))<120000;
  const evidence={buy_order_id:orderId,symbol:entry.symbol,signal_created_at:entry.createdAt,lane:entry.lane||null,
   strategy_version:old.strategy_version||(timely&&entry.lane==='CORE'?manifest.strategy_version:null),
   strategy_hash:old.strategy_hash||(timely&&entry.lane==='CORE'?manifest.strategy_hash:null),
   git_commit:old.git_commit||(timely?manifest.git_commit:null),
   strategy_manifest:old.strategy_manifest||(timely?manifest.manifest:null),
   capital_at_entry_usdt:old.capital_at_entry_usdt??parsed.capital_at_entry_usdt??null,
   radar_signal:old.radar_signal??(signal||intent?.signal||null),
   v42_prediction:old.v42_prediction??signal?.v42_norm??null,
   qubo_decision:old.qubo_decision??(signal?{
    qubo_score:signal.mode==='PRODUCTION_V42_QUBO_V5'?signal.utility??null:null,
    qubo_score_source:signal.mode==='PRODUCTION_V42_QUBO_V5'?'RADAR_QUBO_UTILITY_ROUNDED_6':null,
    qubo_objective:signal.qubo_objective??null}:null),
   entry_v61_decision:old.entry_v61_decision??parsed.entry_v61_decision??null,
   entry_reason:old.entry_reason??parsed.entry_reason??null,
   first_captured_at:old.first_captured_at||new Date().toISOString()};
  evidence.missing_attribution=['strategy_hash','capital_at_entry_usdt','radar_signal','v42_prediction','qubo_decision','entry_v61_decision'].filter(k=>evidence[k]===null);
  if(JSON.stringify(evidence)!==JSON.stringify(old)){write(p,evidence);updated++;}
 }
 return{observed:entries.length,updated};
}
function allCaptured(state=ROOT){return rows(path.join(state,'alpha-mvp','records'),/^[a-f0-9]{32}\.json$/);}
if(require.main===module){
 const watch=process.argv.includes('--watch'),run=()=>{try{const r=captureOnce();if(!watch)console.log(JSON.stringify(r));}catch(e){console.error('ALPHA_CAPTURE_ERROR:'+e.message);if(!watch)process.exitCode=2;}};
 run();if(watch)setInterval(run,5000);
}
module.exports={captureOnce,allCaptured,strategySnapshot,parseEntryOutput};
