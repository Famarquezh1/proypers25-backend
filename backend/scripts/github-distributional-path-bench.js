'use strict';

/*
 * H-DISTRIBUTIONAL-PATH-001
 * Predicts three post-minute-5 path quantities jointly with small ridge models:
 * terminal 4h return, MFE, and MAE. Selection uses only TRAIN/VALIDATION;
 * TEST is evaluation only; FINAL HOLDOUT remains untouched.
 */
const GH='https://api.github.com', BIN='https://data-api.binance.vision', TOKEN=process.env.GITHUB_TOKEN;
const H=240,D=5,COST=.004;
const COMBOS=[
 {name:'terminal_only',w:[1,0,0]},
 {name:'balanced_path',w:[1,.5,1]},
 {name:'downside_heavy',w:[1,.75,1.5]}
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Distributional-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw Error(r.status+' '+url)}throw Error('fetch failed')}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function feat(k,p0,m){const z=k.slice(0,m+1),cl=+z.at(-1)[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,down=0,vol=0,vprev=0,body=0;for(let i=1;i<z.length;i++){const c=+z[i][4],pc=+z[i-1][4];if(c>pc)up++;if(c<pc)down++;vol+=+z[i][5];vprev+=+z[i-1][5];body+=Math.abs(c-(+z[i][1]))/Math.max(1e-12,+z[i][1])}return{ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),downFrac:down/Math.max(1,m),volRatio:vol/Math.max(1e-12,vprev),body:body/Math.max(1,m)}}
function target(k){const entry=+k[D][4];let hi=entry,lo=entry;for(let i=D+1;i<=H;i++){hi=Math.max(hi,+k[i][2]);lo=Math.min(lo,+k[i][3])}return{terminal:+k[H][4]/entry-1,mfe:hi/entry-1,mae:lo/entry-1}}
function continuation(k,p0){let a=Infinity,b=Infinity;for(let i=1;i<=H;i++){if(a===Infinity&&+k[i][2]/p0-1>=.03)a=i;if(b===Infinity&&+k[i][3]/p0-1<=-.01)b=i}return a<b}
function vec(r){const a=r.f5,b=r.f2,c=r.f1;return[a.ret,a.adverse,a.range,a.closePos,a.upFrac,a.downFrac,Math.log(Math.max(.01,a.volRatio)),a.body,b.ret,b.adverse,b.closePos,c.ret,a.ret-b.ret,b.ret-c.ret]}
function scaler(rows){const X=rows.map(vec),d=X[0].length,mu=[],sd=[];for(let j=0;j<d;j++){const z=X.map(x=>x[j]),m=mean(z),s=Math.sqrt(mean(z.map(v=>(v-m)**2)))||1;mu.push(m);sd.push(s)}return x=>[1,...x.map((v,j)=>(v-mu[j])/sd[j])]}
function yscale(rows,key){const a=rows.map(r=>r.y[key]),m=mean(a),s=Math.sqrt(mean(a.map(v=>(v-m)**2)))||1;return{enc:v=>(v-m)/s,dec:v=>v*s+m,mean:m,sd:s}}
function ridgeGD(X,y,lambda=.12,iters=1800,lr=.025){const d=X[0].length,w=Array(d).fill(0),n=X.length;for(let it=0;it<iters;it++){const g=Array(d).fill(0);for(let i=0;i<n;i++){let p=0;for(let j=0;j<d;j++)p+=w[j]*X[i][j];let e=p-y[i];const cap=3;e=Math.max(-cap,Math.min(cap,e));for(let j=0;j<d;j++)g[j]+=e*X[i][j]}for(let j=0;j<d;j++){g[j]/=n;if(j>0)g[j]+=lambda*w[j];w[j]-=lr*g[j]}}return w}
function dot(w,x){return w.reduce((s,v,i)=>s+v*x[i],0)}
function fit(train){const sx=scaler(train),X=train.map(r=>sx(vec(r))),out={sx,heads:{}};for(const key of ['terminal','mfe','mae']){const sy=yscale(train,key),w=ridgeGD(X,train.map(r=>sy.enc(r.y[key])));out.heads[key]={sy,w}}return out}
function pred(r,M){const x=M.sx(vec(r)),o={};for(const [k,h] of Object.entries(M.heads))o[k]=h.sy.dec(dot(h.w,x));return o}
function score(r,M,C){const p=pred(r,M);return C.w[0]*p.terminal+C.w[1]*p.mfe+C.w[2]*p.mae}
function pf(a){const gp=a.filter(x=>x>0).reduce((s,x)=>s+x,0),gl=-a.filter(x=>x<0).reduce((s,x)=>s+x,0);return gl?gp/gl:null}
function metrics(rows,get,cut,cost=COST,delay=D){const s=rows.filter(r=>get(r)>=cut),rets=s.map(r=>+r.k[H][4]/(+r.k[delay][4])-1-cost);let peak=1,eq=1,dd=0;for(const x of rets){eq*=1+x;peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1)}return{n:rows.length,selected_n:s.length,coverage:s.length/Math.max(1,rows.length),avg_net:mean(rets),median_net:quant(rets,.5),positive:mean(rets.map(x=>x>0?1:0)),profit_factor:pf(rets),compound:eq-1,max_drawdown:dd,continuation_rate:mean(s.map(r=>r.cont?1:0)),avg_mfe:mean(s.map(r=>r.y.mfe)),avg_mae:mean(s.map(r=>r.y.mae)),symbols:new Set(s.map(r=>r.s)).size}}
function corr(a,b){const ma=mean(a),mb=mean(b),sa=Math.sqrt(mean(a.map(x=>(x-ma)**2))),sb=Math.sqrt(mean(b.map(x=>(x-mb)**2)));return sa&&sb?mean(a.map((x,i)=>(x-ma)*(b[i]-mb)))/(sa*sb):0}
function choose(train,val,M){const rows=[];for(const C of COMBOS){const get=r=>score(r,M,C),cuts=[.65,.70,.75].map(q=>({q,cut:quant(val.map(get),q)}));for(const z of cuts){const tr=metrics(train,get,z.cut),va=metrics(val,get,z.cut);rows.push({combo:C.name,q:z.q,cut:z.cut,train:tr,val:va,eligible:tr.avg_net>0&&va.avg_net>0&&tr.profit_factor>1&&va.profit_factor>1&&tr.selected_n>=15&&va.selected_n>=8})}}const good=rows.filter(x=>x.eligible).sort((a,b)=>(b.val.avg_net+b.train.avg_net)-(a.val.avg_net+a.train.avg_net));return{all:rows,chosen:good[0]||null}}
function bootstrap(rows,get,cut,B=1200){let seed=8128;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296},a=[];for(let b=0;b<B;b++){const z=[];for(let i=0;i<rows.length;i++)z.push(rows[Math.floor(rnd()*rows.length)]);a.push(metrics(z,get,cut).avg_net)}a.sort((x,y)=>x-y);return{n:a.length,mean:mean(a),ci95:[quant(a,.025),quant(a,.975)],p_le_0:a.filter(x=>x<=0).length/a.length}}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const candidates=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300),errors={},rows=[];
 for(const x of candidates){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,k,cont:continuation(k,p0),f1:feat(k,p0,1),f2:feat(k,p0,2),f5:feat(k,p0,5),y:target(k)})}catch(e){const z=String(e?.message||e).split(' ')[0];errors[z]=(errors[z]||0)+1}await sleep(15)}
 if(rows.length<100)throw Error('INSUFFICIENT_CAUSAL_UNIVERSE '+rows.length);
 rows.sort((a,b)=>a.t-b.t);const n=rows.length,i1=Math.floor(n*.50),i2=Math.floor(n*.70),i3=Math.floor(n*.85),train=rows.slice(0,i1),val=rows.slice(i1,i2),test=rows.slice(i2,i3),final=rows.slice(i3);
 const M=fit(train),choice=choose(train,val,M);
 const calibration={};for(const key of ['terminal','mfe','mae']){const pp=val.map(r=>pred(r,M)[key]),yy=val.map(r=>r.y[key]);calibration[key]={corr:corr(pp,yy),pred_mean:mean(pp),actual_mean:mean(yy)}}
 const report={ok:true,research_only:true,hypothesis_id:'H-DISTRIBUTIONAL-PATH-001',hypothesis:'Joint prediction of terminal return, MFE and MAE at minute 5 identifies paths whose reward potential survives execution costs.',acquisition:{source:'BINANCE_VISION_DATA_API',candidates:candidates.length,usable:n,errors},split:{train:train.length,val:val.length,test:test.length,final_holdout:final.length},model:{type:'three_head_huberized_ridge',lambda:.12,features:vec(train[0]).length,calibration_validation:calibration},candidate_selection:choice.all,chosen:choice.chosen?{combo:choice.chosen.combo,q:choice.chosen.q,cut:choice.chosen.cut}:null,final_holdout_status:'UNTOUCHED_NOT_EVALUATED',guard:'NO ORDERS / NO PRODUCTION WRITES'};
 if(choice.chosen){const C=COMBOS.find(x=>x.name===choice.chosen.combo),get=r=>score(r,M,C),cut=choice.chosen.cut;report.test={base:metrics(test,get,cut),cost06:metrics(test,get,cut,.006),cost08:metrics(test,get,cut,.008),delay10:metrics(test,get,cut,.004,10),delay15:metrics(test,get,cut,.004,15),bootstrap:bootstrap(test,get,cut)};const sel=test.filter(r=>get(r)>=cut),syms=[...new Set(sel.map(r=>r.s))];report.red_team={leave_one_symbol_out:syms.map(s=>({excluded:s,...metrics(test.filter(r=>r.s!==s),get,cut)})).filter(x=>x.selected_n>=5),temporal_halves:[test.slice(0,Math.floor(test.length/2)),test.slice(Math.floor(test.length/2))].map((z,i)=>({half:i+1,...metrics(z,get,cut)})),remove_best_trade:(()=>{const ss=[...sel].map(r=>({r,v:+r.k[H][4]/(+r.k[D][4])-1-COST})).sort((a,b)=>b.v-a.v).slice(1).map(x=>x.r);const vals=ss.map(r=>+r.k[H][4]/(+r.k[D][4])-1-COST);return{n:ss.length,avg_net:mean(vals),profit_factor:pf(vals)}})(),concentration:(()=>{const m={};for(const r of sel)m[r.s]=(m[r.s]||0)+1;const a=Object.values(m).sort((x,y)=>y-x);return{symbols:Object.keys(m).length,top_symbol_share:sel.length?(a[0]||0)/sel.length:0,top3_share:sel.length?a.slice(0,3).reduce((x,y)=>x+y,0)/sel.length:0}})()};report.decision=(report.test.base.avg_net>0&&report.test.base.profit_factor>1&&report.test.cost06.avg_net>0&&report.test.bootstrap.ci95[0]>-.01&&report.red_team.remove_best_trade.avg_net>0&&report.red_team.concentration.top_symbol_share<=.40)?'SURVIVES_FOR_FURTHER_TESTING':'REJECTED_OR_INCONCLUSIVE'}
 else {report.test=null;report.red_team=null;report.decision='REJECTED_OR_INCONCLUSIVE'}
 report.next_hypothesis=report.decision==='SURVIVES_FOR_FURTHER_TESTING'?'Purged walk-forward and calibration stress the frozen distributional selector; if stable, test dynamic exit conditional on predicted path species before any final holdout.':'Search for latent path species / state transitions rather than a single smooth distributional score.';
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
