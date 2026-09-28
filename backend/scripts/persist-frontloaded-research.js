'use strict';
const fs=require('fs'),path=require('path');
const input=process.argv[2]; if(!input)throw Error('result path required');
const raw=fs.readFileSync(input,'utf8').replace(/^\uFEFF/,'');
const r=JSON.parse(raw),now=new Date().toISOString(),root=process.cwd();
if(r.final_holdout_status!=='UNTOUCHED_NOT_EVALUATED')throw Error('FINAL HOLDOUT GUARD VIOLATION');
const entry={id:'AUTO-'+now.replace(/[-:.TZ]/g,'').slice(0,14),date:now,branch:'research/post-signal-continuation-autopsy',execution_environment:process.env.RESEARCH_EXECUTION_ENV||'unknown',universe:r.acquisition?.usable??null,hypothesis_id:r.hypothesis_id,family:r.family,status:r.decision,development_n:r.development_n,final_holdout_n:r.final_holdout_n,final_holdout_status:r.final_holdout_status,method:r.method,folds:r.folds,pooled:r.pooled,next_hypothesis:r.next_hypothesis,guard:r.guard};
const ledger=path.join(root,'research','experiment-ledger.jsonl');fs.mkdirSync(path.dirname(ledger),{recursive:true});fs.appendFileSync(ledger,JSON.stringify(entry)+'\n','utf8');
const pf=r.folds?.map((f,i)=>('- Fold '+(i+1)+': AUC test '+String(f.auc_test)+', selected '+f.test.selected_n+', avg net '+(100*f.test.avg_net).toFixed(3)+'%, PF '+String(f.test.profit_factor))).join('\n')||'- no valid folds';
const state=['# Proypers25 Autonomous Research State','',
'Updated: '+now,'',
'Branch: research/post-signal-continuation-autopsy','',
'## Scientific split status',
'- Usable universe: '+String(r.acquisition?.usable??'n/a'),
'- Development block: first '+String(r.development_n)+' signals',
'- Previous fixed TEST: CONSUMED FOR ARCHITECTURE DEVELOPMENT; not reused as fresh holdout',
'- FINAL HOLDOUT: last '+String(r.final_holdout_n)+' signals — '+r.final_holdout_status,'',
'## Latest experiment',
'- Hypothesis: '+r.hypothesis_id,
'- Family: '+r.family,
'- Decision: '+r.decision,
'- Walk-forward folds: '+String(r.folds?.length??0),
'- Pooled selected trades: '+String(r.pooled?.n??0),
'- Pooled avg net: '+(r.pooled?.avg_net==null?'n/a':(100*r.pooled.avg_net).toFixed(3)+'%'),
'- Positive folds: '+String(r.pooled?.positive_folds??0)+'/'+String(r.folds?.length??0),
'- PF>1 folds: '+String(r.pooled?.pf_positive_folds??0)+'/'+String(r.folds?.length??0),'',
'## Fold evidence',pf,'',
'## Next hypothesis',r.next_hypothesis||'Generate a distinct hypothesis from failure modes.','',
'## Guardrails','Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.',''].join('\n');
fs.writeFileSync(path.join(root,'research','RESEARCH_STATE.md'),state,'utf8');
console.log(JSON.stringify(entry,null,2));
