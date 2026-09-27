'use strict';

/*
 * H-HAZARD-MONETIZE-001
 * Money-layer falsification for the already-defined competing-hazard selector.
 * Selector is fit/calibrated on TRAIN/VALIDATION only. Exit policy is selected
 * on TRAIN/VALIDATION only from a small preregistered family, then frozen on TEST.
 * FINAL HOLDOUT remains untouched.
 */
const GH='https://api.github.com', BIN='https://data-api.binance.vision', TOKEN=process.env.GITHUB_TOKEN;
const H=240, D=5;
const INTERVALS=[[6,15],[16,30],[31,60],[61,120],[121,240]];
const POLICIES=[
 {name:'tp3_stop1',stop:.01,tp:.03},
 {name:'tp5_stop1',stop:.01,tp:.05},
 {name:'trail_arm2_trail1',stop:.01,arm:.02,trail:.01},
 {name:'trail_arm3_trail15',stop:.012,arm:.03,trail:.015},
 {name:'ratchet',stop:.012,ratchet:true},
 {name:'time30_stop1',stop:.01,time:30},
 {name:'time60_stop1',stop:.01,time:60},
 {name:'time120_stop1',stop:.01,time:120}
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Hazard-Money/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw Error(r.status+' '+url)}throw Error('fetch failed')}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
const sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function feat(k,p0,m){const z=k.slice(0,m+1),cl=+z.at(-1)[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,vol=0,vprev=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;vol+=+z[i][5];vprev+=+z[i-1][5]}return{ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),volRatio:vol/Math.max(1e-12,vprev)}}
function event(k,p0){let c=Infinity,f=Infinity;for(let i=1;i<=H;i++){if(c===Infinity&&+k[i][2]/p0-1>=.03)c=i;if(f===Infinity&&+k[i][3]/p0-1<=-.01)f=i}if(c===f&&c!==Infinity)return{type:'AMBIG',time:c};if(c<f)return{type:'C',time:c};if(f<c)return{type:'F',time:f};return{type:'NONE',time:H+1}}
function baseVec(r){const a=r.f[5],b=r.f[2],c=r.f[1];return[a.ret,a.adverse,a.range,a.closePos,a.upFrac,Math.log(Math.max(.01,a.volRatio)),b.ret,c.ret,a.ret-b.ret,b.ret-c.ret]}
function fitScaler(rows){const X=rows.map(baseVec),d=X[0].length,mu=[],sd=[];for(let j=0;j<d;j++){const a=X.map(x=>x[j]),m=mean(a),s=Math.sqrt(mean(a.map(v=>(v-m)**2)))||1;mu.push(m);sd.push(s)}return x=>x.map((v,j)=>(v-mu[j])/sd[j])}
function design(z,q){return[1,...z,...INTERVALS.map((_,i)=>i===q?1:0)]}
function fitLogistic(X,y,lambda=.05,iters=1200,lr=.04){const d=X[0].length,w=Array(d).fill(0),n=X.length;for(let it=0;it<iters;it++){const g=Array(d).fill(0);for(let i=0;i<n;i++){let s=0;for(let j=0;j<d;j++)s+=w[j]*X[i][j];const e=sigmoid(s)-y[i];for(let j=0;j<d;j++)g[j]+=e*X[i][j]}for(let j=0;j<d;j++){g[j]/=n;if(j>0)g[j]+=lambda*w[j];w[j]-=lr*g[j]}}return w}
function dot(w,x){return w.reduce((s,v,i)=>s+v*x[i],0)}
function fitHazard(rows){const tr=rows.filter(r=>r.ev.time>D&&r.ev.type!=='AMBIG'),scale=fitScaler(tr),Xc=[],yc=[],Xf=[],yf=[];for(const r of tr){const z=scale(baseVec(r));for(let q=0;q<INTERVALS.length;q++){const [a,b]=INTERVALS[q];if(r.ev.time<a&&r.ev.type!=='NONE')break;const hit=r.ev.time>=a&&r.ev.time<=b,x=design(z,q);Xc.push(x);Xf.push(x);yc.push(hit&&r.ev.type==='C'?1:0);yf.push(hit&&r.ev.type==='F'?1:0);if(hit)break}}return{scale,wc:fitLogistic(Xc,yc),wf:fitLogistic(Xf,yf)}}
function score(r,M){const z=M.scale(baseVec(r));let S=1,c=0,f=0;for(let q=0;q<INTERVALS.length;q++){let hc=sigmoid(dot(M.wc,design(z,q))),hf=sigmoid(dot(M.wf,design(z,q)));const sm=hc+hf;if(sm>.95){hc*=.95/sm;hf*=.95/sm}c+=S*hc;f+=S*hf;S*=1-hc-hf}return c-f}
function simulate(r,P,cost=.004,delay=D){
 const entry=+r.k[delay][4];let peak=entry,exit=+r.k[H][4],minute=H,reason='TIME';
 for(let i=delay+1;i<=H;i++){
   const hi=+r.k[i][2],lo=+r.k[i][3],cl=+r.k[i][4];peak=Math.max(peak,hi);
   if(P.stop&&lo<=entry*(1-P.stop)){exit=entry*(1-P.stop);minute=i;reason='STOP';break}
   if(P.tp&&hi>=entry*(1+P.tp)){exit=entry*(1+P.tp);minute=i;reason='TP';break}
   if(P.ratchet){
     let st=null,g=peak/entry-1;
     if(g>=.02)st=entry*1.005;if(g>=.03)st=Math.max(st||0,entry*1.015);if(g>=.05)st=Math.max(st||0,entry*1.03);if(g>=.04)st=Math.max(st||0,peak*.985);
     if(st&&lo<=st){exit=st;minute=i;reason='RATCHET';break}
   }
   if(P.trail&&peak>=entry*(1+P.arm)&&lo<=peak*(1-P.trail)){exit=peak*(1-P.trail);minute=i;reason='TRAIL';break}
   if(P.time&&i>=delay+P.time){exit=cl;minute=i;reason='TIME_POLICY';break}
 }
 return {ret:exit/entry-1-cost,minute,reason};
}
function stats(rows,P,cost=.004,delay=D){const a=rows.map(r=>simulate(r,P,cost,delay).ret);const eq=a.reduce((z,x)=>z*(1+x),1)-1;let peak=1,cur=1,dd=0;for(const x of a){cur*=1+x;peak=Math.max(peak,cur);dd=Math.min(dd,cur/peak-1)}return{n:a.length,avg:mean(a),median:quant(a,.5),positive:mean(a.map(x=>x>0?1:0)),profit_factor:(()=>{const gp=a.filter(x=>x>0).reduce((s,x)=>s+x,0),gl=-a.filter(x=>x<0).reduce((s,x)=>s+x,0);return gl?gp/gl:null})(),compound:eq,max_drawdown:dd}}
function choose(train,val,selector){const tr=train.filter(selector),va=val.filter(selector);const rows=POLICIES.map(P=>({P,train:stats(tr,P),val:stats(va,P)}));const eligible=rows.filter(x=>x.train.avg>0&&x.val.avg>0&&x.train.profit_factor>1&&x.val.profit_factor>1);eligible.sort((a,b)=>(b.val.avg+b.train.avg)-(a.val.avg+a.train.avg));return{all:rows,chosen:eligible[0]||null}}
function bootstrap(rows,P,B=1000){let seed=451;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296},a=[];for(let b=0;b<B;b++){const z=[];for(let i=0;i<rows.length;i++)z.push(rows[Math.floor(rnd()*rows.length)]);a.push(stats(z,P).avg)}a.sort((x,y)=>x-y);return{mean:mean(a),ci95:[quant(a,.025),quant(a,.975)],p_le_0:a.filter(x=>x<=0).length/a.length}}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const candidates=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300),errors={},rows=[];
 for(const x of candidates){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,k,p0,ev:event(k,p0),f:{1:feat(k,p0,1),2:feat(k,p0,2),5:feat(k,p0,5)}})}catch(e){const z=String(e?.message||e).split(' ')[0];errors[z]=(errors[z]||0)+1}await sleep(15)}
 if(rows.length<100)throw Error('INSUFFICIENT_CAUSAL_UNIVERSE '+rows.length);
 rows.sort((a,b)=>a.t-b.t);const n=rows.length,i1=Math.floor(n*.50),i2=Math.floor(n*.70),i3=Math.floor(n*.85),raw={train:rows.slice(0,i1),val:rows.slice(i1,i2),test:rows.slice(i2,i3),final:rows.slice(i3)};
 const eligible=z=>z.filter(r=>r.ev.time>D&&r.ev.type!=='AMBIG');
 const tr=eligible(raw.train),va=eligible(raw.val),te=eligible(raw.test),M=fitHazard(raw.train),cut=quant(va.map(r=>score(r,M)),.70),selector=r=>score(r,M)>=cut;
 const picked=choose(tr,va,selector),testSelected=te.filter(selector);
 const report={ok:true,research_only:true,hypothesis_id:'H-HAZARD-MONETIZE-001',hypothesis:'The frozen hazard selector has monetizable favorable excursions if profits are captured before 4h mean reversion.',acquisition:{source:'BINANCE_VISION_DATA_API',candidates:candidates.length,usable:n,errors},split_raw:{train:raw.train.length,val:raw.val.length,test:raw.test.length,final_holdout:raw.final.length},risk_set:{train:tr.length,val:va.length,test:te.length},selector:{decision_minute:D,validation_cut:cut,train_selected:tr.filter(selector).length,val_selected:va.filter(selector).length,test_selected:testSelected.length},policy_candidates:picked.all.map(x=>({name:x.P.name,train:x.train,val:x.val})),chosen_policy:picked.chosen?.P?.name||null,final_holdout_status:'UNTOUCHED_NOT_EVALUATED',guard:'NO ORDERS / NO PRODUCTION WRITES'};
 if(picked.chosen){const P=picked.chosen.P;report.test={base:stats(testSelected,P),cost06:stats(testSelected,P,.006),cost08:stats(testSelected,P,.008),delay10:stats(testSelected,P,.004,10),delay15:stats(testSelected,P,.004,15),bootstrap:bootstrap(testSelected,P)};const syms=[...new Set(testSelected.map(r=>r.s))];report.red_team={leave_one_symbol_out:syms.map(s=>({excluded:s,...stats(testSelected.filter(r=>r.s!==s),P)})).filter(x=>x.n>=5),remove_best_trade:(()=>{const rr=testSelected.map(r=>({r,v:simulate(r,P).ret})).sort((a,b)=>b.v-a.v).slice(1).map(x=>x.r);return stats(rr,P)})()};report.decision=(report.test.base.avg>0&&report.test.base.profit_factor>1&&report.test.cost06.avg>0&&report.test.bootstrap.ci95[0]>-.01&&report.red_team.remove_best_trade.avg>0)?'SURVIVES_FOR_FURTHER_TESTING':'REJECTED_OR_INCONCLUSIVE'}
 else {report.test=null;report.red_team=null;report.decision='REJECTED_OR_INCONCLUSIVE'}
 report.next_hypothesis=report.decision==='SURVIVES_FOR_FURTHER_TESTING'?'Purged walk-forward the frozen selector+exit pair, stress concurrency/capital allocation, then reserve a new untouched block before any final holdout.':'Model joint future MFE/MAE and terminal-return distribution; the continuation edge still did not convert robustly into money.';
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
