'use strict';
// Triggered after workflow registration; research-only nonlinear gate.

const fs=require('fs'),path=require('path'),vm=require('vm');
const HIST=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const BIN='https://data-api.binance.vision';
const START=Date.parse(process.env.GATE_START||'2026-04-01T00:00:00Z');
const END=Date.parse(process.env.GATE_END||'2026-09-01T00:00:00Z');
const MAX_ROWS=Math.max(250,Math.min(700,Number(process.env.GATE_MAX_ROWS||450)));
const H=240,COST_PCT=.4;
const FEATURES=['r5','r15','r30','r60','r240','r24','vol15','vol30','trade_accel','breakout60','breakout240','rs60','rs240','qv','ignition','confirm','extension','v42_pass','v42_norm','breadth_up15','breadth_up60','breadth_breakout','breadth_ignite','breadth_mean60','regime_trend_up','regime_volatile','regime_risk_off'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function loadLib(){
 let src=fs.readFileSync(HIST,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
 src+=';globalThis.__x={loadR7,buildRaw,productionEligible};';
 const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:HIST});
 vm.runInContext(src,c,{filename:HIST}); return c.__x;
}
async function getJson(url){
 let last; for(let i=0;i<5;i++){try{const r=await fetch(url,{headers:{'user-agent':'proypers25-continuator-gbt/1.0'}});if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(250*(i+1));continue}throw Error('HTTP_'+r.status)}catch(e){last=e;if(i<4)await sleep(250*(i+1))}} throw last||Error('fetch failed');
}
function dedupe(rows){const out=[],last=new Map();for(const s of [...rows].sort((a,b)=>a.t-b.t||a.symbol.localeCompare(b.symbol))){const p=last.get(s.symbol)||-Infinity;if(s.t-p<30*60*1000)continue;out.push(s);last.set(s.symbol,s.t)}return out}
async function label(s){
 const start=s.t+5*60000;
 const q=new URLSearchParams({symbol:s.symbol,interval:'1m',startTime:String(start),endTime:String(start+(H+5)*60000),limit:'500'});
 const k=await getJson(BIN+'/api/v3/klines?'+q); if(!Array.isArray(k)||k.length<241)return null;
 const entry=Number(k[0][1]); let first3=null,first1=null,mfe=-Infinity,mae=Infinity;
 for(let i=1;i<=H;i++){const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(first3===null&&hi>=.03)first3=i;if(first1===null&&lo<=-.01)first1=i}
 const cont=first3!==null&&(first1===null||first3<first1);
 const close=Number(k[H][4]); const ret4=(close/entry-1)*100-COST_PCT;
 let payoff;
 if(cont) payoff=3-COST_PCT;
 else if(first1!==null&&(first3===null||first1<first3)) payoff=-1-COST_PCT;
 else payoff=Math.max(-1-COST_PCT,Math.min(3-COST_PCT,ret4));
 const f=s.f||{},p=s.productionV42||{},d=p.detail||{},bd=s.breadth||{},rw=s.regimeWeights||{};
 return {timestamp:new Date(s.t).toISOString(),symbol:s.symbol,
  r5:+(f.r5||0),r15:+(f.r15||0),r30:+(f.r30||0),r60:+(f.r60||0),r240:+(f.r240||0),r24:+(f.r24||0),
  vol15:+(f.vol15||0),vol30:+(f.vol30||0),trade_accel:+(f.tradeAccel||0),breakout60:+(f.breakout60||0),breakout240:+(f.breakout240||0),
  rs60:+(f.rs60||0),rs240:+(f.rs240||0),qv:+(f.qv||0),ignition:+(d.ignition||0),confirm:+(d.confirm||0),extension:+(d.extension||0),
  v42_pass:+(p.pass||0),v42_norm:+(p.norm||0),breadth_up15:+(bd.up15||0),breadth_up60:+(bd.up60||0),breadth_breakout:+(bd.breakout||0),breadth_ignite:+(bd.ignite||0),breadth_mean60:+(bd.mean60||0),
  regime_trend_up:+(rw.TREND_UP||0),regime_volatile:+(rw.VOLATILE||0),regime_risk_off:+(rw.RISK_OFF||0),
  target_continuator:cont,first_plus3_min:first3,first_minus1_min:first1,mfe_pct:mfe*100,mae_pct:mae*100,return_4h_net_pct:ret4,payoff_pct:payoff};
}
function sigmoid(z){if(z>30)return 1;if(z<-30)return 0;return 1/(1+Math.exp(-z))}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0}
function quantiles(vals){const s=[...vals].filter(Number.isFinite).sort((a,b)=>a-b);if(s.length<5)return[];return [.15,.3,.45,.6,.75,.9].map(q=>s[Math.min(s.length-1,Math.floor(q*(s.length-1)))]).filter((v,i,a)=>i===0||v!==a[i-1])}
function leafValue(rows,resids){return rows.length?mean(rows.map(x=>resids[x.i])):0}
function fitStump(rows,resids,featureIdxs){
 let best=null,bestErr=Infinity;
 for(const fi of featureIdxs){const f=FEATURES[fi],ths=quantiles(rows.map(i=>i.row[f]));for(const th of ths){
   const L=rows.filter(i=>i.row[f]<th),R=rows.filter(i=>i.row[f]>=th); if(L.length<8||R.length<8)continue;
   const lv=leafValue(L,resids),rv=leafValue(R,resids);
   const err=L.reduce((sum,x)=>sum+(resids[x.i]-lv)**2,0)+R.reduce((sum,x)=>sum+(resids[x.i]-rv)**2,0);
   if(err<bestErr){bestErr=err;best={f,th,lv,rv}}
 }}
 return best;
}
function train(rows){
 const y=rows.map(x=>x.target_continuator?1:0),prev=Math.max(.02,Math.min(.98,mean(y))),base=Math.log(prev/(1-prev));
 const score=new Array(rows.length).fill(base),trees=[],lr=.35;
 for(let m=0;m<60;m++){
  const p=score.map(sigmoid),resids=y.map((v,i)=>v-p[i]);
  const indexed=rows.map((row,i)=>({row,i}));
  const tree=fitStump(indexed,resids,FEATURES.map((_,i)=>i)); if(!tree)break;
  trees.push(tree); for(let i=0;i<rows.length;i++)score[i]+=lr*(rows[i][tree.f]<tree.th?tree.lv:tree.rv);
 }
 return {base,lr,trees,prob:r=>{let z=base;for(const t of trees)z+=lr*(r[t.f]<t.th?t.lv:t.rv);return sigmoid(z)}};
}
function summary(rows){const n=rows.length,w=rows.filter(x=>x.target_continuator).length;return {n,continuators:w,continuator_rate:n?w/n:null,avg_payoff_pct:n?mean(rows.map(x=>x.payoff_pct)):null,avg_return4h_net_pct:n?mean(rows.map(x=>x.return_4h_net_pct)):null,hit5_rate:n?rows.filter(x=>x.mfe_pct>=5).length/n:null,hit10_rate:n?rows.filter(x=>x.mfe_pct>=10).length/n:null}}
function chooseThreshold(model,rows){
 const base=summary(rows),probs=rows.map(r=>model.prob(r)).sort((a,b)=>a-b);
 const ths=[.35,.4,.45,.5,.55,.6,.65,.7,.75,.8,...[.45,.55,.65,.75,.85].map(q=>probs[Math.min(probs.length-1,Math.floor(q*(probs.length-1)))])];
 let best=null;
 for(const th of [...new Set(ths.filter(Number.isFinite))]){const sel=rows.filter(r=>model.prob(r)>=th),s=summary(sel);if(sel.length<Math.max(15,Math.floor(rows.length*.15)))continue;
  const delta=s.continuator_rate-base.continuator_rate,score=s.avg_payoff_pct+delta*4+Math.max(0,s.avg_return4h_net_pct-base.avg_return4h_net_pct)*.2;
  if(s.avg_payoff_pct>0&&delta>=.08&&(!best||score>best.score))best={threshold:th,validation:s,baseline:base,delta_continuator:delta,score};
 }
 return best;
}
(async()=>{
 process.env.DEV_START=new Date(START).toISOString();process.env.DEV_END=new Date(START+Math.floor((END-START)*.6)).toISOString();process.env.CONFIRM_START=process.env.DEV_END;process.env.CONFIRM_END=new Date(END).toISOString();
 const h=loadLib(),lib=h.loadR7(),built=await h.buildRaw(lib); const eligible=dedupe(built.raw.filter(x=>x.t>=START&&x.t<END).filter(h.productionEligible)).slice(0,MAX_ROWS);
 const rows=[],skipped=[];for(const s of eligible){try{const x=await label(s);if(x)rows.push(x);else skipped.push({symbol:s.symbol,t:s.t})}catch(e){skipped.push({symbol:s.symbol,t:s.t,error:e.message})}await sleep(10)}
 rows.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)); if(rows.length<180)throw Error('insufficient labeled rows '+rows.length);
 const a=Math.floor(rows.length*.6),b=Math.floor(rows.length*.8),trainRows=rows.slice(0,a),validation=rows.slice(a,b),holdout=rows.slice(b);
 const model=train(trainRows),choice=chooseThreshold(model,validation),baseH=summary(holdout);
 let result=null,promote=false;
 if(choice){const selected=holdout.filter(r=>model.prob(r)>=choice.threshold),s=summary(selected),delta=s.continuator_rate-baseH.continuator_rate;
   promote=selected.length>=Math.max(15,Math.floor(holdout.length*.15))&&delta>=.10&&s.avg_payoff_pct>0&&s.avg_return4h_net_pct>=baseH.avg_return4h_net_pct;
   result={threshold:choice.threshold,selected:s,baseline:baseH,delta_continuator:delta,pass:promote};
 }
 const importance={};for(const t of model.trees)importance[t.f]=(importance[t.f]||0)+1;
 const out={ok:true,research_only:true,no_order_created:true,family:'CONTINUATOR_GBT_GATE_V1',period:[new Date(START).toISOString(),new Date(END).toISOString()],rows:rows.length,skipped:skipped.length,blocks:{train:trainRows.length,validation:validation.length,holdout:holdout.length},baselines:{train:summary(trainRows),validation:summary(validation),holdout:baseH},trees:model.trees.length,feature_usage:Object.entries(importance).sort((a,b)=>b[1]-a[1]).slice(0,12),validation_choice:choice,holdout_result:result,production_decision:promote?'PROMOTE_TO_SHADOW':'REJECT_MODEL_FAMILY',promote_to_shadow:promote,success_gate:'holdout delta continuator >= +10pp, positive payoff, non-worse 4h net, adequate sample'};
 console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
