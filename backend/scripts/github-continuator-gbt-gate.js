'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const HIST=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const START=Date.parse(process.env.GATE_START||'2026-04-01T00:00:00Z');
const END=Date.parse(process.env.GATE_END||'2026-09-01T00:00:00Z');
const MAX_ROWS=Math.max(250,Math.min(700,Number(process.env.GATE_MAX_ROWS||450)));
const COST=.4;

function loadLib(){
  let src=fs.readFileSync(HIST,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__x={loadR7,buildRaw,productionEligible};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:HIST});
  vm.runInContext(src,c,{filename:HIST}); return c.__x;
}
function dedupe(rows){const out=[],last=new Map();for(const s of [...rows].sort((a,b)=>a.t-b.t||a.symbol.localeCompare(b.symbol))){const p=last.get(s.symbol)||-Infinity;if(s.t-p<30*60*1000)continue;out.push(s);last.set(s.symbol,s.t)}return out}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function row(s){
 const f=s.f||{},q=s.productionV42||{},d=q.detail||{},o=s.outcome||{},b=s.breadth||{};
 let payoff;
 const cont=Boolean(o.continuator ?? o.hit3_before_minus1);
 const ret4=Number(o.return4hNet ?? o.return_4h_net ?? o.net4h ?? 0)*100;
 const mfe=Number(o.mfe ?? 0)*100;
 const mae=Number(o.mae ?? 0)*100;
 if(cont) payoff=3-COST;
 else if(mae<=-1) payoff=-1-COST;
 else payoff=Math.max(-1-COST,Math.min(3-COST,ret4));
 return {
  t:s.t,symbol:s.symbol,target_continuator:cont,payoff_pct:payoff,return4h_net_pct:ret4,mfe_pct:mfe,mae_pct:mae,
  r15:Number(f.r15||0),r60:Number(f.r60||0),r24:Number(f.r24||0),
  ignition:Number(d.ignition||0),confirm:Number(d.confirm||0),extension:Number(d.extension||0),
  v42_pass:Number(q.pass||0),v42_norm:Number(q.norm||0),
  breadth_up60:Number(b.up60??b.up60Rate??0),breadth_breakout:Number(b.breakout??b.breakoutRate??0),breadth_mean60:Number(b.mean60??0)
 };
}
function summary(rows){
 const n=rows.length,w=rows.filter(x=>x.target_continuator).length;
 return {n,continuators:w,continuator_rate:n?w/n:null,avg_payoff_pct:n?mean(rows.map(x=>x.payoff_pct)):null,
   avg_return4h_net_pct:n?mean(rows.map(x=>x.return4h_net_pct)):null,
   hit5_rate:n?rows.filter(x=>x.mfe_pct>=5).length/n:null,hit10_rate:n?rows.filter(x=>x.mfe_pct>=10).length/n:null};
}

(async()=>{
 process.env.DEV_START=new Date(START).toISOString();
 process.env.DEV_END=new Date(START+Math.floor((END-START)*.6)).toISOString();
 process.env.CONFIRM_START=process.env.DEV_END;
 process.env.CONFIRM_END=new Date(END).toISOString();

 const h=loadLib(),lib=h.loadR7(),built=await h.buildRaw(lib);
 const base=dedupe(built.raw.filter(x=>x.t>=START&&x.t<END).filter(h.productionEligible)).slice(0,MAX_ROWS).map(row);
 if(base.length<180)throw Error('insufficient rows '+base.length);
 const a=Math.floor(base.length*.6),b=Math.floor(base.length*.8);
 const train=base.slice(0,a),validation=base.slice(a,b),holdout=base.slice(b);
 const baseV=summary(validation),baseH=summary(holdout);

 const rules=[];
 const passes=[2,3];
 const norms=[.82,.88,.94,.97];
 const confirms=[.28,.34,.40,.46];
 const extensions=[.015,.025,.04,.06];
 const r24max=[.05,.08,.10,.12];
 for(const pass of passes)for(const norm of norms)for(const confirm of confirms)for(const ext of extensions)for(const r24 of r24max){
   rules.push({id:`p${pass}_n${norm}_c${confirm}_e${ext}_r24${r24}`,pass,norm,confirm,ext,r24,
    fn:x=>x.v42_pass>=pass&&x.v42_norm>=norm&&x.confirm>=confirm&&x.extension>=ext&&x.r24<r24});
 }

 const candidates=rules.map(rule=>{
   const v=validation.filter(rule.fn),s=summary(v);
   const delta=s.continuator_rate===null?null:s.continuator_rate-baseV.continuator_rate;
   const eligible=Boolean(
     s.n>=15 &&
     s.continuator_rate>=.35 &&
     delta>=.10 &&
     s.avg_payoff_pct>0 &&
     s.avg_return4h_net_pct>baseV.avg_return4h_net_pct
   );
   const score=eligible?s.avg_payoff_pct+delta*4+Math.max(0,s.hit5_rate-baseV.hit5_rate):null;
   return {rule:{id:rule.id,pass:rule.pass,norm:rule.norm,confirm:rule.confirm,extension:rule.ext,r24_max:rule.r24},
     validation:s,delta_continuator:delta,eligible,score,fn:rule.fn};
 }).filter(x=>x.validation.n>0).sort((x,y)=>(y.score??-Infinity)-(x.score??-Infinity));

 const selected=candidates.find(x=>x.eligible)||null;
 let holdoutResult=null,promote=false;
 if(selected){
   const hs=summary(holdout.filter(selected.fn));
   const delta=hs.continuator_rate-baseH.continuator_rate;
   promote=Boolean(
     hs.n>=15 &&
     hs.continuator_rate>=.35 &&
     delta>=.10 &&
     hs.avg_payoff_pct>0 &&
     hs.avg_return4h_net_pct>=baseH.avg_return4h_net_pct
   );
   holdoutResult={baseline:baseH,selected:hs,delta_continuator:delta,pass:promote};
 }

 console.log(JSON.stringify({
   ok:true,research_only:true,no_order_created:true,
   family:'CORE_HIGH_CONVICTION_COHORT_V1',
   objective:'find a pre-buy CORE cohort with positive OOS economics and materially higher continuation',
   rows:base.length,blocks:{train:train.length,validation:validation.length,holdout:holdout.length},
   baselines:{validation:baseV,holdout:baseH},
   candidate_count:candidates.length,
   top_validation:candidates.slice(0,12).map(({fn,...x})=>x),
   selected_rule:selected?(({fn,...x})=>x)(selected):null,
   holdout_result:holdoutResult,
   production_decision:promote?'PROMOTE_TO_SHADOW':'DISABLE_CORE_AS_BUYER_IF_NO_OTHER_VALIDATED_EDGE',
   promote_to_shadow:promote,
   success_gate:'holdout n>=15, continuator>=35%, +10pp vs baseline, positive payoff, non-worse 4h net'
 },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});