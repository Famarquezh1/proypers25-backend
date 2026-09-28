'use strict';
const fs=require('fs'),path=require('path'),f=process.argv[2],raw=fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'');
const r=JSON.parse(raw),now=new Date().toISOString(),root=process.cwd();
if(r.final_holdout_status!=='UNTOUCHED_NOT_EVALUATED')throw Error('holdout guard');
const entry={id:'AUTO-'+now.replace(/[-:.TZ]/g,'').slice(0,14),date:now,branch:'research/post-signal-continuation-autopsy',execution_environment:process.env.RESEARCH_EXECUTION_ENV||'unknown',hypothesis_id:r.hypothesis_id,family:'causal_factor_atlas',status:r.decision,usable:r.usable,development:r.development,final_holdout:r.final_holdout,final_holdout_status:r.final_holdout_status,ranking:r.ranking,data_gaps:r.data_gaps,next_hypothesis:r.next,guard:'RESEARCH ONLY'};
fs.appendFileSync(path.join(root,'research','experiment-ledger.jsonl'),JSON.stringify(entry)+'\n','utf8');
const top=r.ranking?.[0]||{};
const state=['# Proypers25 Autonomous Research State','',
'Updated: '+now,'','Branch: research/post-signal-continuation-autopsy','',
'## Scientific split status','- Usable universe: '+r.usable,'- Development block: '+r.development,'- FINAL HOLDOUT: '+r.final_holdout+' — '+r.final_holdout_status,'',
'## Latest experiment','- Hypothesis: '+r.hypothesis_id,'- Decision: '+r.decision,'- Top family: '+(top.name||'n/a'),'- Top pooled net: '+(top.net==null?'n/a':(top.net*100).toFixed(3)+'%'),'- Top median AUC: '+String(top.med_auc??'n/a'),'- Top min AUC: '+String(top.min_auc??'n/a'),'- Selected: '+String(top.selected??0),'',
'## Ranked families',...(r.ranking||[]).slice(0,8).map(x=>'- '+x.name+': net '+(x.net==null?'n/a':(x.net*100).toFixed(3)+'%')+', medAUC '+String(x.med_auc)+', minAUC '+String(x.min_auc)+', n '+String(x.selected)),'',
'## Data gaps',...(r.data_gaps||[]).map(x=>'- '+x),'',
'## Next hypothesis',r.next||'n/a','',
'## Guardrails','Research/shadow/offline only. No production, V23, real orders or trading credentials.',''].join('\n');
fs.writeFileSync(path.join(root,'research','RESEARCH_STATE.md'),state,'utf8');
console.log(JSON.stringify(entry,null,2));