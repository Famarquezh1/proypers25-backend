'use strict';
const fs=require('fs'),path=require('path');
const file=process.argv[2]; if(!file) throw Error('hazard result path required');
const r=JSON.parse(fs.readFileSync(file,'utf8'));
if(!r.ok||r.hypothesis_id!=='H-COMPETING-HAZARD-001') throw Error('invalid hazard result');
const now=new Date().toISOString(),root=process.cwd(),ledger=path.join(root,'research','experiment-ledger.jsonl');
fs.mkdirSync(path.dirname(ledger),{recursive:true});
const entry={
 id:'AUTO-'+now.replace(/[-:.TZ]/g,'').slice(0,14),
 date:now,
 branch:'research/post-signal-continuation-autopsy',
 execution_environment:process.env.RESEARCH_EXECUTION_ENV||'unknown',
 universe:r.acquisition?.usable??null,
 hypothesis_id:r.hypothesis_id,
 family:'competing_risks_hazard',
 status:r.decision,
 split:r.split_raw,
 risk_set:r.risk_set,
 final_holdout_status:r.final_holdout_status,
 test:r.test,
 adversarial:r.adversarial,
 next_hypothesis:r.next_hypothesis,
 guard:'RESEARCH ONLY; no production, no orders, no V23 changes'
};
fs.appendFileSync(ledger,JSON.stringify(entry)+'\n');
const pct=x=>Number.isFinite(x)?(x*100).toFixed(3)+'%':'n/a';
const state=[
'# Proypers25 Autonomous Research State','',
'Updated: '+now,'',
'Branch: research/post-signal-continuation-autopsy',
'Execution environment: '+entry.execution_environment,'',
'## Latest valid batch',
'- Universe: '+entry.universe,
'- Hypothesis: '+r.hypothesis_id,
'- Decision: '+r.decision,
'- Raw split: '+JSON.stringify(r.split_raw),
'- Risk set: '+JSON.stringify(r.risk_set),
'- Hazard TEST AUC: '+(r.test?.hazard?.auc??'n/a'),
'- Static meta TEST AUC: '+(r.test?.meta?.auc??'n/a'),
'- AUC delta: '+(r.test?.auc_delta??'n/a'),
'- Hazard BUY continuation: '+pct(r.test?.hazard?.selected_cont),
'- Meta BUY continuation: '+pct(r.test?.meta?.selected_cont),
'- Hazard BUY net 4h: '+pct(r.test?.economics_hazard?.base?.avg),
'- Meta BUY net 4h: '+pct(r.test?.economics_meta?.base?.avg),
'- FINAL HOLDOUT: '+r.final_holdout_status,'',
'## Next hypothesis',
r.next_hypothesis,'',
'## Guardrails',
'Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.',''
].join('\n');
fs.writeFileSync(path.join(root,'research','RESEARCH_STATE.md'),state);
console.log(JSON.stringify(entry,null,2));
