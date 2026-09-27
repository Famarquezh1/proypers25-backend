'use strict';
const GH='https://api.github.com',BIN='https://api.binance.com',TOKEN=process.env.GITHUB_TOKEN,COST=.004,H=240,START=500,SEED=.25,SCALE_RET=.004914004914004844,SCALE_MIN=5;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(250*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function feat(k,p0,m){const z=k.slice(0,m+1),last=z[z.length-1],cl=+last[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,vol=0,vprev=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;vol+=+z[i][5];vprev+=+z[i-1][5]}return {ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),volRatio:vol/Math.max(1e-12,vprev)}}
function outcome(k,p0){let hit3=Infinity,hitm1=Infinity,mfe=-Infinity,mae=Infinity;for(let i=1;i<=Math.min(H,k.length-1);i++){const hi=+k[i][2]/p0-1,lo=+k[i][3]/p0-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(hit3===Infinity&&hi>=.03)hit3=i;if(hitm1===Infinity&&lo<=-.01)hitm1=i}return {cont:hit3<hitm1,mfe,mae,net4h:+k[Math.min(H,k.length-1)][4]/p0-1-COST}}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function summary(a){return {n:a.length,continuation_rate:avg(a.map(x=>x.y.cont?1:0)),avg_net4h:avg(a.map(x=>x.y.net4h)),avg_mfe:avg(a.map(x=>x.y.mfe)),avg_mae:avg(a.map(x=>x.y.mae))}}
function candidates(rows,m){const F=['ret','adverse','range','closePos','upFrac','volRatio'],out=[];for(const f of F){const vals=rows.map(r=>r.f[m][f]).filter(Number.isFinite).sort((a,b)=>a-b);for(const q of [.2,.35,.5,.65,.8]){const t=vals[Math.floor((vals.length-1)*q)];for(const dir of ['ge','le'])out.push({f,t,dir,test:r=>dir==='ge'?r.f[m][f]>=t:r.f[m][f]<=t})}}return out}
(async()=>{let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
const rows=[];for(const x of issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300)){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,p0,k5open:+k[5][1],k6open:+k[Math.min(6,k.length-1)][1],k5close:+k[5][4],exit:+k[Math.min(H,k.length-1)][4],path:k.slice(0,H+1).map(z=>({o:+z[1],h:+z[2],l:+z[3],c:+z[4]})),f:{1:feat(k,p0,1),2:feat(k,p0,2),3:feat(k,p0,3),5:feat(k,p0,5)},y:outcome(k,p0)});}catch(e){}await sleep(15)}
rows.sort((a,b)=>a.t-b.t);const n=rows.length,a=Math.floor(n*.55),b=Math.floor(n*.75),train=rows.slice(0,a),val=rows.slice(a,b),test=rows.slice(b);
const results={};for(const m of [1,2,3,5]){const baseT=summary(train),baseV=summary(val),baseX=summary(test);let scored=[];for(const c of candidates(train,m)){const tr=train.filter(c.test),va=val.filter(c.test),te=test.filter(c.test);if(tr.length<25||va.length<10||te.length<10)continue;const st=summary(tr),sv=summary(va),sx=summary(te);const gainTr=st.continuation_rate-baseT.continuation_rate,gainV=sv.continuation_rate-baseV.continuation_rate,gainX=sx.continuation_rate-baseX.continuation_rate;scored.push({feature:c.f,dir:c.dir,threshold:c.t,train:st,val:sv,test:sx,gains:[gainTr,gainV,gainX],robust:Math.min(gainTr,gainV,gainX)});}scored.sort((x,y)=>y.robust-x.robust);results[m+'m']=scored.slice(0,5)}
function portfolio(data,staged){
  let cash=START, peak=START, maxDD=0, wins=0, trades=0, scaled=0;
  for(const r of data){
    const equity=cash, seed=staged?equity*SEED:equity;
    const seedRet=r.exit/r.p0-1-COST;
    let pnl=seed*seedRet, deployed=seed;
    if(staged&&r.f[5].ret>=SCALE_RET){
      const add=equity*(1-SEED), addRet=r.exit/r.k6open-1-COST;
      pnl+=add*addRet; deployed+=add; scaled++;
    }
    cash+=pnl; trades++; if(pnl>0)wins++;
    peak=Math.max(peak,cash); maxDD=Math.min(maxDD,cash/peak-1);
  }
  return {start:START,end:cash,return_pct:(cash/START-1)*100,max_drawdown_pct:maxDD*100,trades,win_rate:wins/Math.max(1,trades),scaled};
}
function exitPolicy(r,kind){
  const p=r.path, entry=r.p0; let peak=entry, stop=null, exit=p[p.length-1].c, minute=p.length-1, reason='TIME';
  for(let i=1;i<p.length;i++){
    const z=p[i]; peak=Math.max(peak,z.h); const gain=peak/entry-1;
    if(kind==='ratchet'){
      if(gain>=.05) stop=Math.max(stop||0,entry*1.03);
      else if(gain>=.03) stop=Math.max(stop||0,entry*1.015);
      else if(gain>=.02) stop=Math.max(stop||0,entry*1.005);
      if(gain>=.04) stop=Math.max(stop||0,peak*(1-.015));
    } else if(kind==='trail2'){
      if(gain>=.02) stop=Math.max(stop||0,peak*(1-.02));
    } else if(kind==='trail15'){
      if(gain>=.02) stop=Math.max(stop||0,peak*(1-.015));
    }
    if(stop&&z.l<=stop){exit=stop;minute=i;reason='STOP';break}
  }
  return {exit,minute,reason};
}
function portfolioExit(data,kind){
  let cash=START,peakEq=START,maxDD=0,wins=0,scaled=0;
  for(const r of data){
    const equity=cash, seed=equity*SEED; let pnl=0;
    const ep=exitPolicy(r,kind); const seedRet=ep.exit/r.p0-1-COST; pnl+=seed*seedRet;
    if(r.f[5].ret>=SCALE_RET && ep.minute>5){
      const add=equity*(1-SEED), addRet=ep.exit/r.k6open-1-COST; pnl+=add*addRet;scaled++;
    }
    cash+=pnl;if(pnl>0)wins++;peakEq=Math.max(peakEq,cash);maxDD=Math.min(maxDD,cash/peakEq-1);
  }
  return {end:cash,return_pct:(cash/START-1)*100,max_drawdown_pct:maxDD*100,win_rate:wins/Math.max(1,data.length),scaled};
}
function failureExit(r,mode){
  const p=r.path; let exit=null,minute=null,reason=null;
  for(let i=1;i<=Math.min(10,p.length-1);i++){
    const z=p[i], ret=z.c/r.p0-1, low=z.l/r.p0-1;
    if(mode==='hard1' && low<=-.01){exit=r.p0*.99;minute=i;reason='FAIL_-1';break}
    if(mode==='weak5' && i>=5 && ret<=-.005){exit=z.c;minute=i;reason='FAIL_WEAK5';break}
    if(mode==='hybrid' && (low<=-.01 || (i>=5&&ret<=-.005))){exit=low<=-.01?r.p0*.99:z.c;minute=i;reason='FAIL_HYBRID';break}
  }
  return exit?{exit,minute,reason}:null;
}
function portfolioFull(data,failMode){
  let cash=START,peakEq=START,maxDD=0,wins=0,scaled=0,early=0;
  for(const r of data){
    const equity=cash, seed=equity*SEED; const fe=failureExit(r,failMode);
    let pnl=0;
    if(fe){pnl=seed*(fe.exit/r.p0-1-COST);early++;}
    else {
      const ep=exitPolicy(r,'trail15'); pnl=seed*(ep.exit/r.p0-1-COST);
      if(r.f[5].ret>=SCALE_RET && ep.minute>5){const add=equity*(1-SEED);pnl+=add*(ep.exit/r.k6open-1-COST);scaled++;}
    }
    cash+=pnl;if(pnl>0)wins++;peakEq=Math.max(peakEq,cash);maxDD=Math.min(maxDD,cash/peakEq-1);
  }
  return {end:cash,return_pct:(cash/START-1)*100,max_drawdown_pct:maxDD*100,win_rate:wins/Math.max(1,data.length),scaled,early_fail_exits:early};
}
function portfolioSeed(data,seedFrac){
  let cash=START,peakEq=START,maxDD=0,wins=0,scaled=0,early=0;
  for(const r of data){
    const equity=cash, seed=equity*seedFrac; const fe=failureExit(r,'weak5'); let pnl=0;
    if(fe){pnl=seed*(fe.exit/r.p0-1-COST);early++;}
    else{
      const ep=exitPolicy(r,'trail15'); pnl=seed*(ep.exit/r.p0-1-COST);
      if(r.f[5].ret>=SCALE_RET && ep.minute>5){const add=equity*(1-seedFrac);pnl+=add*(ep.exit/r.k6open-1-COST);scaled++;}
    }
    cash+=pnl;if(pnl>0)wins++;peakEq=Math.max(peakEq,cash);maxDD=Math.min(maxDD,cash/peakEq-1);
  }
  return {seed_fraction:seedFrac,end:cash,return_pct:(cash/START-1)*100,max_drawdown_pct:maxDD*100,win_rate:wins/Math.max(1,data.length),scaled,early_fail_exits:early};
}
function concurrentPortfolio(data,seedFrac){
  const events=[...data].sort((a,b)=>a.t-b.t); let cash=START,peak=START,maxDD=0,wins=0,scaled=0,skipped=0;
  const active=[]; const MAX_DEPLOY=.65, RESERVE=.20;
  function settleUntil(ts){active.sort((a,b)=>a.end-b.end);while(active.length&&active[0].end<=ts){const x=active.shift();cash+=x.proceeds;if(x.pnl>0)wins++;const eq=cash+active.reduce((q,y)=>q+y.cost,0);peak=Math.max(peak,eq);maxDD=Math.min(maxDD,eq/peak-1);}}
  for(const r of events){
    settleUntil(r.t); const equity=cash+active.reduce((q,y)=>q+y.cost,0), reserve=Math.max(50,equity*RESERVE), deployed=active.reduce((q,y)=>q+y.cost,0), capacity=Math.max(0,equity*MAX_DEPLOY-deployed);
    const seed=Math.min(equity*seedFrac,capacity,Math.max(0,cash-reserve)); if(seed<1){skipped++;continue}
    const fe=failureExit(r,'weak5'); let proceeds=0,cost=seed,pnl=0,end=r.t+H*60000;
    if(fe){const ret=fe.exit/r.p0-1-COST;pnl=seed*ret;proceeds=seed+pnl;end=r.t+fe.minute*60000;}
    else{
      const ep=exitPolicy(r,'trail15'); let ret=ep.exit/r.p0-1-COST;pnl=seed*ret;proceeds=seed+pnl;end=r.t+ep.minute*60000;
      if(r.f[5].ret>=SCALE_RET&&ep.minute>5){
        const addCap=Math.min(Math.max(0,equity*(1-seedFrac)),Math.max(0,capacity-seed),Math.max(0,cash-seed-reserve));
        if(addCap>=1){const ar=ep.exit/r.k6open-1-COST;pnl+=addCap*ar;proceeds+=addCap*(1+ar);cost+=addCap;scaled++;}
      }
    }
    cash-=cost;active.push({end,cost,proceeds,pnl});
  }
  settleUntil(Infinity);return {start:START,end:cash,return_pct:(cash/START-1)*100,max_drawdown_pct:maxDD*100,wins,scaled,skipped,max_deploy_pct:MAX_DEPLOY*100,reserve_pct:RESERVE*100};
}
function concurrentPriority(data){
  const buckets=new Map(); for(const r of data){const key=Math.floor(r.t/60000);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(r);}
  const ordered=[]; for(const [,g] of [...buckets.entries()].sort((a,b)=>a[0]-b[0])){g.sort((a,b)=>{
    const fa=a.f[1]||{},fb=b.f[1]||{};
    const sa=(fa.closePos||0)+(fa.upFrac||0)+Math.max(0,fa.ret||0)*20-Math.max(0,-(fa.adverse||0))*10;
    const sb=(fb.closePos||0)+(fb.upFrac||0)+Math.max(0,fb.ret||0)*20-Math.max(0,-(fb.adverse||0))*10;
    return sb-sa;
  });ordered.push(...g);}
  return concurrentPortfolio(ordered,.05);
}
function stressPortfolio(data,cost){
  const oldCost=COST; // frozen architecture replayed with explicit stressed round-trip cost
  const events=[...data].sort((a,b)=>a.t-b.t); let cash=START,peak=START,maxDD=0,scaled=0,skipped=0; const active=[];
  function settle(ts){active.sort((a,b)=>a.end-b.end);while(active.length&&active[0].end<=ts){const x=active.shift();cash+=x.proceeds;peak=Math.max(peak,cash+active.reduce((q,y)=>q+y.cost,0));maxDD=Math.min(maxDD,(cash+active.reduce((q,y)=>q+y.cost,0))/peak-1);}}
  for(const r of events){settle(r.t);const eq=cash+active.reduce((q,y)=>q+y.cost,0),reserve=Math.max(50,eq*.20),dep=active.reduce((q,y)=>q+y.cost,0),cap=Math.max(0,eq*.65-dep),seed=Math.min(eq*.05,cap,Math.max(0,cash-reserve));if(seed<1){skipped++;continue}
    const fe=failureExit(r,'weak5');let proceeds,costBasis=seed,end,pnl;
    if(fe){pnl=seed*(fe.exit/r.p0-1-cost);proceeds=seed+pnl;end=r.t+fe.minute*60000;}
    else{const ep=exitPolicy(r,'trail15');pnl=seed*(ep.exit/r.p0-1-cost);proceeds=seed+pnl;end=r.t+ep.minute*60000;if(r.f[5].ret>=SCALE_RET&&ep.minute>5){const a=Math.min(eq*.95,Math.max(0,cap-seed),Math.max(0,cash-seed-reserve));if(a>=1){const ar=ep.exit/r.k6open-1-cost;pnl+=a*ar;proceeds+=a*(1+ar);costBasis+=a;scaled++;}}}
    cash-=costBasis;active.push({end,cost:costBasis,proceeds});}
  settle(Infinity);return {cost,return_pct:(cash/START-1)*100,end:cash,max_drawdown_pct:maxDD*100,scaled,skipped};
}
function walkForwardStress(data){
 const sorted=[...data].sort((a,b)=>a.t-b.t), n=sorted.length, out={};
 for(const parts of [4,6]){out[String(parts)]=[];for(let i=0;i<parts;i++){const a=Math.floor(n*i/parts),b=Math.floor(n*(i+1)/parts);const block=sorted.slice(a,b);out[String(parts)].push({block:i+1,n:block.length,base:stressPortfolio(block,.004),stress06:stressPortfolio(block,.006),stress08:stressPortfolio(block,.008)});}}
 return out;
}
const finalRobustness={walk_forward:walkForwardStress(rows),cost_stress:{cost04:stressPortfolio(rows,.004),cost06:stressPortfolio(rows,.006),cost08:stressPortfolio(rows,.008)}};
const priorityPortfolio={train:concurrentPriority(train),val:concurrentPriority(val),test:concurrentPriority(test),all:concurrentPriority(rows)};
const concurrent={};for(const sf of [.05,.10])concurrent[String(sf)]={train:concurrentPortfolio(train,sf),val:concurrentPortfolio(val,sf),test:concurrentPortfolio(test,sf),all:concurrentPortfolio(rows,sf)};
const seedArchitecture={};
for(const sf of [.05,.10,.15,.20,.25])seedArchitecture[String(sf)]={train:portfolioSeed(train,sf),val:portfolioSeed(val,sf),test:portfolioSeed(test,sf),all:portfolioSeed(rows,sf)};
const fullPolicies={};for(const m of ['hard1','weak5','hybrid'])fullPolicies[m]={train:portfolioFull(train,m),val:portfolioFull(val,m),test:portfolioFull(test,m),all:portfolioFull(rows,m)};
const exitPolicies={};
for(const kind of ['ratchet','trail2','trail15']) exitPolicies[kind]={train:portfolioExit(train,kind),val:portfolioExit(val,kind),test:portfolioExit(test,kind),all:portfolioExit(rows,kind)};
const portfolioResults={
  train:{baseline:portfolio(train,false),staged:portfolio(train,true)},
  val:{baseline:portfolio(val,false),staged:portfolio(val,true)},
  test:{baseline:portfolio(test,false),staged:portfolio(test,true)},
  all:{baseline:portfolio(rows,false),staged:portfolio(rows,true)}
};
console.log(JSON.stringify({ok:true,research_only:true,n,split:{train:train.length,val:val.length,test:test.length},baseline:{train:summary(train),val:summary(val),test:summary(test)},results,portfolio_policy:{start_usdt:START,seed_fraction:SEED,scale_minute:SCALE_MIN,scale_return:SCALE_RET,note:'sequential historical simulation; one signal resolved before next, no concurrency'},portfolio:portfolioResults,exit_policies:exitPolicies,full_policies:fullPolicies,seed_architecture:seedArchitecture,concurrent_portfolio:concurrent,priority_portfolio:priorityPortfolio,final_robustness:finalRobustness},null,2));})().catch(e=>{console.error(e);process.exit(1)});