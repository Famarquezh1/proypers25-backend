'use strict';

/**
 * Cohort 5 — delayed pullback/reclaim entry study.
 * One decisive question: after an existing production signal, is it better to
 * enter immediately or wait briefly for a controlled pullback + reclaim?
 *
 * Public Binance 1m candles only. No credentials. No orders.
 * Candidate timing rules are selected on discovery+validation; holdout opens once.
 */

const GH='https://api.github.com', BIN='https://api.binance.com';
const TOKEN=process.env.GITHUB_TOKEN;
const H=240, COST=.004, MAX_SIGNALS=420;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}){
  for(let i=0;i<5;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-ReclaimEntry/1.0',...headers}});
    if(r.ok)return r.json();
    if(r.status===429||r.status>=500){await sleep(300*(i+1));continue;}
    throw Error(r.status+' '+url);
  }
  throw Error('fetch failed '+url);
}
const ghHeaders=()=>({Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});
function symbolOf(x){return ((String(x.title||'')+'\n'+String(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)||[])[1]||null}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function med(a){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}

async function loadSignals(){
  let issues=[];
  for(let p=1;p<=12;p++){
    const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',ghHeaders());
    issues.push(...a.filter(x=>!x.pull_request));
    if(a.length<100)break;
  }
  return issues
    .filter(x=>/\[SPOT SIGNAL\]/i.test(String(x.title||''))||/SPOT SIGNAL/i.test(String(x.body||'')))
    .map(x=>({issue:x.number,symbol:symbolOf(x),t:Date.parse(x.created_at),created_at:x.created_at}))
    .filter(x=>x.symbol&&Number.isFinite(x.t))
    .sort((a,b)=>b.t-a.t).slice(0,MAX_SIGNALS).sort((a,b)=>a.t-b.t);
}
async function klines(symbol,start,end){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit:500}))u.searchParams.set(k,v);
  return json(u);
}
function firstTouch(all,startIndex,entry){
  let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null,first5=null;
  for(let i=startIndex+1;i<all.length;i++){
    const hi=+all[i][2]/entry-1, lo=+all[i][3]/entry-1;
    mfe=Math.max(mfe,hi); mae=Math.min(mae,lo);
    const rel=i-startIndex;
    if(first3===null&&hi>=.03)first3=rel;
    if(first5===null&&hi>=.05)first5=rel;
    if(firstNeg1===null&&lo<=-.01)firstNeg1=rel;
  }
  const close=+all[Math.min(startIndex+H,all.length-1)][4];
  const win=first3!==null&&(firstNeg1===null||first3<firstNeg1);
  const loss=firstNeg1!==null&&(first3===null||firstNeg1<first3);
  const fixed=win?.03-COST:loss?-.01-COST:(close/entry-1-COST);
  return {win,loss,hit5:first5!==null&&(firstNeg1===null||first5<firstNeg1),mfe,mae,fixed_return:fixed};
}
function immediate(all){
  const entry=+all[0][1];
  if(!(entry>0))return null;
  return {entered:true,entry_index:0,entry_price:entry,...firstTouch(all,0,entry)};
}
function reclaim(all,rule){
  const signal=+all[0][1];
  if(!(signal>0)||all.length<=rule.wait+1)return {entered:false};
  const obs=all.slice(0,rule.wait);
  const lows=obs.map(r=>+r[3]), highs=obs.map(r=>+r[2]);
  const low=Math.min(...lows), high=Math.max(...highs);
  const pullback=low/signal-1;
  const entry=+all[rule.wait][1];
  const prevClose=+all[rule.wait-1][4];
  const reclaimFromLow=entry/low-1;
  const chase=entry/signal-1;
  const heldStructure=low/signal-1>=rule.maxDip;
  const hadPullback=pullback<=rule.minDip;
  const reclaimed=reclaimFromLow>=rule.minReclaim && entry>=prevClose;
  const notChased=chase<=rule.maxChase;
  if(!(heldStructure&&hadPullback&&reclaimed&&notChased))return {entered:false,pullback,reclaim_from_low:reclaimFromLow,chase};
  return {entered:true,entry_index:rule.wait,entry_price:entry,pullback,reclaim_from_low:reclaimFromLow,chase,...firstTouch(all,rule.wait,entry)};
}
function summarize(rows,key){
  const entered=rows.map(x=>x[key]).filter(x=>x&&x.entered);
  const wins=entered.filter(x=>x.win);
  return {
    signals:rows.length,entered:entered.length,coverage:rows.length?entered.length/rows.length:null,
    wins:wins.length,win_rate:entered.length?wins.length/entered.length:null,
    hit5_rate:entered.length?entered.filter(x=>x.hit5).length/entered.length:null,
    avg_fixed_return:avg(entered.map(x=>x.fixed_return)),
    median_fixed_return:med(entered.map(x=>x.fixed_return)),
    avg_mfe:avg(entered.map(x=>x.mfe)),
    avg_mae:avg(entered.map(x=>x.mae))
  };
}
function improvement(base,cand){
  return {
    delta_win_rate:cand.win_rate-base.win_rate,
    delta_fixed_return:cand.avg_fixed_return-base.avg_fixed_return,
    delta_hit5:cand.hit5_rate-base.hit5_rate
  };
}

(async()=>{
  if(!TOKEN)throw Error('GITHUB_TOKEN required');
  const signals=await loadSignals();
  const rows=[];
  for(const s of signals){
    try{
      const all=await klines(s.symbol,s.t,s.t+(H+12)*60000);
      if(!Array.isArray(all)||all.length<90)continue;
      rows.push({...s,all,immediate:immediate(all)});
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(15);
  }
  if(rows.length<180)throw Error('insufficient rows '+rows.length);
  rows.sort((a,b)=>a.t-b.t);
  const a=Math.floor(rows.length*.60), b=Math.floor(rows.length*.80);
  const discovery=rows.slice(0,a), validation=rows.slice(a,b), holdout=rows.slice(b);

  const rules=[];
  for(const wait of [1,2,3,4,5]){
    for(const minDip of [-.001,-.0025,-.005,-.0075]){
      for(const minReclaim of [.001,.0025,.005]){
        for(const maxChase of [.005,.01,.02]){
          rules.push({wait,minDip,minReclaim,maxChase,maxDip:-.015,label:`w${wait}_dip${minDip}_reclaim${minReclaim}_chase${maxChase}`});
        }
      }
    }
  }
  for(const row of rows){
    row.candidates={};
    for(const rule of rules)row.candidates[rule.label]=reclaim(row.all,rule);
  }

  const dBase=summarize(discovery,'immediate'), vBase=summarize(validation,'immediate'), hBase=summarize(holdout,'immediate');
  const candidates=rules.map(rule=>{
    const dk='candidates.'+rule.label;
    const get=(set)=>set.map(r=>({...r,tmp:r.candidates[rule.label]}));
    const dRows=get(discovery),vRows=get(validation);
    const summarizeTmp=(set)=> {
      const entered=set.map(x=>x.tmp).filter(x=>x&&x.entered);
      return {
        signals:set.length,entered:entered.length,coverage:set.length?entered.length/set.length:null,
        wins:entered.filter(x=>x.win).length,
        win_rate:entered.length?entered.filter(x=>x.win).length/entered.length:null,
        hit5_rate:entered.length?entered.filter(x=>x.hit5).length/entered.length:null,
        avg_fixed_return:avg(entered.map(x=>x.fixed_return)),
        median_fixed_return:med(entered.map(x=>x.fixed_return)),
        avg_mfe:avg(entered.map(x=>x.mfe)),
        avg_mae:avg(entered.map(x=>x.mae))
      };
    };
    const d=summarizeTmp(dRows),v=summarizeTmp(vRows);
    const di=improvement(dBase,d),vi=improvement(vBase,v);
    const eligible=Boolean(
      d.entered>=30 && v.entered>=12 &&
      d.coverage>=.15 && v.coverage>=.15 &&
      d.avg_fixed_return>dBase.avg_fixed_return &&
      v.avg_fixed_return>vBase.avg_fixed_return &&
      d.win_rate>dBase.win_rate &&
      v.win_rate>vBase.win_rate
    );
    const score=eligible
      ? vi.delta_fixed_return*4 + vi.delta_win_rate + Math.max(0,vi.delta_hit5)*.25 + v.coverage*.10
      : -Infinity;
    return {rule,discovery:d,validation:v,discovery_improvement:di,validation_improvement:vi,eligible,score};
  }).sort((x,y)=>y.score-x.score);

  const selected=candidates.find(x=>x.eligible)||null;
  let holdoutResult=null,promote=false;
  if(selected){
    const entered=holdout.map(r=>r.candidates[selected.rule.label]).filter(x=>x&&x.entered);
    const h={
      signals:holdout.length,entered:entered.length,coverage:holdout.length?entered.length/holdout.length:null,
      wins:entered.filter(x=>x.win).length,
      win_rate:entered.length?entered.filter(x=>x.win).length/entered.length:null,
      hit5_rate:entered.length?entered.filter(x=>x.hit5).length/entered.length:null,
      avg_fixed_return:avg(entered.map(x=>x.fixed_return)),
      median_fixed_return:med(entered.map(x=>x.fixed_return)),
      avg_mfe:avg(entered.map(x=>x.mfe)),
      avg_mae:avg(entered.map(x=>x.mae))
    };
    const hi=improvement(hBase,h);
    promote=Boolean(
      h.entered>=12 && h.coverage>=.15 &&
      h.avg_fixed_return>hBase.avg_fixed_return &&
      h.win_rate>hBase.win_rate &&
      h.avg_fixed_return>0
    );
    holdoutResult={rule:selected.rule,baseline:hBase,reclaim:h,improvement:hi,pass:promote};
  }

  console.log(JSON.stringify({
    ok:true,research_only:true,no_order_created:true,
    family:'DELAYED_PULLBACK_RECLAIM_ENTRY_COHORT_5',
    objective:'improve realized-style +3/-1 payoff by changing entry timing after an existing signal',
    rows:rows.length,
    blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    baseline:{discovery:dBase,validation:vBase,holdout:hBase},
    candidate_count:candidates.length,
    top_validation_candidates:candidates.slice(0,12),
    selected_rule:selected,
    holdout_result:holdoutResult,
    production_decision:promote?'PROMOTE_RECLAIM_ENTRY_TO_SHADOW':'DO_NOT_PROMOTE',
    promote_to_shadow:promote
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});