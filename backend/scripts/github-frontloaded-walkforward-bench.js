'use strict';

/*
 * H-FRONTLOADED-WF-001
 * Research-only expanding purged walk-forward study.
 * Hypothesis: the relative hazard of continuation vs early failure during minutes 6-30
 * transports better than cumulative 4h continuation classifiers and can define a
 * selective entry gate with positive net expectancy.
 *
 * FINAL HOLDOUT: last 43 usable signals is never evaluated here.
 */
const GH='https://api.github.com', TOKEN=process.env.GITHUB_TOKEN, H=240, COST=.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Frontloaded-WF/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw Error(r.status+' '+url)}throw Error('fetch failed')}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const median=a=>{if(!a.length)return 0;const z=[...a].sort((x,y)=>x-y),m=Math.floor(z.length/2);return z.length%2?z[m]:(z[m-1]+z[m])/2};
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))||1};
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
async function klines(symbol,start){const base='https://data-api.binance.vision/api/v3/klines';const u=new URL(base);for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:start+(H+5)*60000,limit:500}))u.searchParams.set(k,v);return json(u)}
function feat(k,p0,m){const z=k.slice(0,m+1),cl=+z.at(-1)[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,v=0,vp=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;v+=+z[i][5];vp+=+z[i-1][5]}return{ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),volRatio:v/Math.max(1e-12,vp)}}
function pathLabel(k,p0){let plus=Infinity,fail=Infinity,mfe=-Infinity,mae=Infinity;for(let i=1;i<=H;i++){const hi=+k[i][2]/p0-1,lo=+k[i][3]/p0-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(plus===Infinity&&hi>=.03)plus=i;if(fail===Infinity&&lo<=-.01)fail=i}return{cont:plus<fail,hit3:plus,hitm1:fail,mfe,mae,terminal:+k[H][4]/p0-1-COST}}
function earlyLabel(r){const a=r.y.hit3,b=r.y.hitm1; if(a>=6&&a<=30&&a<b)return 1; if(b>=6&&b<=30&&b<a)return 0; return null}
function zfit(rows,get){const a=rows.map(get).filter(Number.isFinite),m=mean(a),s=sd(a);return r=>(get(r)-m)/s}
function sigmoid(x){return 1/(1+Math.exp(-Math.max(-30,Math.min(30,x))))}
function fitLogistic(rows,lambda=.15,iters=350,lr=.04){
 const getters=[
  r=>r.f[5].ret,r=>r.f[5].adverse,r=>r.f[5].closePos,r=>r.f[5].upFrac,
  r=>Math.log(Math.max(.01,r.f[5].volRatio)),r=>r.f[5].range,
  r=>r.f[3].ret-r.f[1].ret,r=>r.f[5].ret-r.f[3].ret,
  r=>r.f[5].adverse-r.f[2].adverse
 ];
 const Z=getters.map(g=>zfit(rows,g));let w=Array(Z.length+1).fill(0);
 for(let it=0;it<iters;it++){const g=Array(w.length).fill(0);for(const r of rows){const y=earlyLabel(r);if(y===null)continue;const x=[1,...Z.map(f=>f(r))],p=sigmoid(w.reduce((s,a,j)=>s+a*x[j],0)),e=p-y;for(let j=0;j<w.length;j++)g[j]+=e*x[j]}const n=Math.max(1,rows.filter(r=>earlyLabel(r)!==null).length);for(let j=0;j<w.length;j++){const reg=j?lambda*w[j]:0;w[j]-=lr*(g[j]/n+reg)}}return r=>sigmoid(w.reduce((s,a,j)=>s+a*[1,...Z.map(f=>f(r))][j],0))}
function auc(rows,score){const z=rows.filter(r=>earlyLabel(r)!==null),p=z.filter(r=>earlyLabel(r)===1),n=z.filter(r=>earlyLabel(r)===0);let w=0,t=0;for(const a of p)for(const b of n){t++;const x=score(a),y=score(b);w+=x>y?1:x===y?.5:0}return t?w/t:null}
function tradeReturn(r,delay=5,cost=COST){const e=+r.k[Math.min(delay,r.k.length-1)][1];let peak=e;for(let i=delay+1;i<=Math.min(30,r.k.length-1);i++){const hi=+r.k[i][2],lo=+r.k[i][3],cl=+r.k[i][4];peak=Math.max(peak,hi);if(lo<=e*.99)return -.01-cost;if(hi>=e*1.03)return .03-cost;if(i>=15&&peak>=e*1.015&&lo<=peak*.99)return peak*.99/e-1-cost;if(i===30)return cl/e-1-cost}return +r.k[Math.min(30,r.k.length-1)][4]/e-1-cost}
function stats(rows,score,cut,cost=.004,delay=5){const s=rows.filter(r=>score(r)>=cut),rets=s.map(r=>tradeReturn(r,delay,cost));const gains=rets.filter(x=>x>0).reduce((a,b)=>a+b,0),loss=-rets.filter(x=>x<0).reduce((a,b)=>a+b,0);let eq=1,peak=1,dd=0;for(const x of rets){eq*=1+x;peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1)}return{n:rows.length,selected_n:s.length,coverage:s.length/Math.max(1,rows.length),early_cont_rate:mean(s.map(r=>earlyLabel(r)===1?1:0)),full_cont_rate:mean(s.map(r=>r.y.cont?1:0)),avg_net:mean(rets),median_net:median(rets),positive:mean(rets.map(x=>x>0?1:0)),profit_factor:loss?gains/loss:null,compound:eq-1,max_drawdown:dd,symbols:new Set(s.map(r=>r.s)).size}}
function chooseCut(train,val,score){const qs=[.60,.70,.75,.80,.85],cand=qs.map(q=>{const cut=quant(train.map(score),q);return{q,cut,tr:stats(train,score,cut),va:stats(val,score,cut)}}).filter(x=>x.tr.selected_n>=12&&x.va.selected_n>=6);cand.sort((a,b)=>{const ra=Math.min(a.tr.avg_net,a.va.avg_net),rb=Math.min(b.tr.avg_net,b.va.avg_net);return rb-ra});return cand[0]||null}
function bootstrap(rows,score,cut,B=800){let seed=99173;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};const vals=[];for(let b=0;b<B;b++){const z=[];for(let i=0;i<rows.length;i++)z.push(rows[Math.floor(rnd()*rows.length)]);vals.push(stats(z,score,cut).avg_net)}vals.sort((a,b)=>a-b);return{mean:mean(vals),ci95:[quant(vals,.025),quant(vals,.975)],p_le_0:vals.filter(x=>x<=0).length/vals.length}}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const rows=[],errors={};for(const x of issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300)){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const k=await klines(s,t);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,k,f:{1:feat(k,p0,1),2:feat(k,p0,2),3:feat(k,p0,3),5:feat(k,p0,5)},y:pathLabel(k,p0)})}catch(e){errors[String(e.message||e)]=(errors[String(e.message||e)]||0)+1}await sleep(12)}
 rows.sort((a,b)=>a.t-b.t);const finalHoldout=rows.slice(-43),dev=rows.slice(0,-43);if(dev.length<180)throw Error('insufficient development universe '+dev.length);
 const folds=[];const initial=110, valSize=25, testSize=25, purge=5;let cursor=initial;
 while(cursor+purge+valSize+purge+testSize<=dev.length){
   const train=dev.slice(0,cursor),val=dev.slice(cursor+purge,cursor+purge+valSize),test=dev.slice(cursor+purge+valSize+purge,cursor+purge+valSize+purge+testSize);
   const eligible=train.filter(r=>earlyLabel(r)!==null); if(eligible.length<45){cursor+=25;continue}
   const score=fitLogistic(train), chosen=chooseCut(train,val,score); if(!chosen){cursor+=25;continue}
   folds.push({train_n:train.length,val_n:val.length,test_n:test.length,purge,auc_val:auc(val,score),auc_test:auc(test,score),chosen:{q:chosen.q,cut:chosen.cut,train:chosen.tr,val:chosen.va},test:stats(test,score,chosen.cut),stress:{cost06:stats(test,score,chosen.cut,.006,5),cost08:stats(test,score,chosen.cut,.008,5),delay10:stats(test,score,chosen.cut,.004,10)},bootstrap:bootstrap(test,score,chosen.cut)});
   cursor+=25;
 }
 const pooled={selected:0,n:0,weighted_net:0,positive_folds:0,pf_positive_folds:0};for(const f of folds){pooled.n+=f.test.selected_n;pooled.selected+=f.test.selected_n;pooled.weighted_net+=f.test.avg_net*f.test.selected_n;if(f.test.avg_net>0)pooled.positive_folds++;if((f.test.profit_factor||0)>1)pooled.pf_positive_folds++}pooled.avg_net=pooled.n?pooled.weighted_net/pooled.n:null;
 const report={ok:true,research_only:true,hypothesis_id:'H-FRONTLOADED-WF-001',family:'frontloaded_competing_hazard',hypothesis:'Relative 6-30 minute continuation-vs-failure hazard transports under expanding purged walk-forward and yields selective positive net expectancy.',acquisition:{source:'BINANCE_VISION_DATA_API',candidates:300,usable:rows.length,errors},development_n:dev.length,final_holdout_n:finalHoldout.length,final_holdout_status:'UNTOUCHED_NOT_EVALUATED',method:{expanding:true,purge_signals:purge,val_size:valSize,test_size:testSize,decision_minute:5,event_window:'6-30m',thresholds_chosen_per_fold_on_train_validation_only:true},folds,pooled,guard:'FINAL HOLDOUT CLOSED / NO ORDERS / NO PRODUCTION WRITES'};
 const stable=folds.length>=3&&pooled.n>=18&&pooled.avg_net>0&&pooled.positive_folds/folds.length>=.6&&pooled.pf_positive_folds/folds.length>=.5;
 report.decision=stable?'SURVIVES_FOR_RED_TEAM':'REJECTED_OR_INCONCLUSIVE';
 report.next_hypothesis=stable?'Red-team the frozen front-loaded policy with leave-one-symbol/month, doubled costs, delayed entry, remove-best-trades, then consider FINAL HOLDOUT only if all survive.':'Investigate state-transition/order-of-events representation rather than static early-window features; front-loaded hazard did not transport economically.';
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
