'use strict';
const fs=require('fs'),path=require('path');
const root=process.cwd(),dir=path.join(root,'research','results');
fs.mkdirSync(dir,{recursive:true});
const now=new Date().toISOString(), files=process.argv.slice(2);
const parsed={};
for(const f of files){try{parsed[path.basename(f,'.json')]=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){parsed[path.basename(f,'.json')]={ok:false,error:String(e)}}}
const sel=parsed.selective_disagreement||{};
const exit=parsed.exit_policy||{};
const multi=parsed.multiagent||{};
const entry={
 id:'AUTO-'+now.replace(/[-:.TZ]/g,'').slice(0,14),
 date:now,
 branch:'research/post-signal-continuation-autopsy',
 universe:{multiagent:multi.n??null,exit_policy:exit.n??null,selective:sel.universe??null},
 experiments:[
  {id:'BASE-MULTIAGENT',family:'meta_agent',status:'REFERENCE_REFRESH',test:multi.decision?.test??null},
  {id:'EXIT-POLICY-BENCH',family:'money_layer',status:exit.FINAL_UNTOUCHED_TEST?'HOLDOUT_ALREADY_CONSUMED_REFERENCE':'INCONCLUSIVE',chosen:exit.chosen??null,result:exit.FINAL_UNTOUCHED_TEST??null},
  {id:sel.hypothesis_id||'H-SELECTIVE-DISAGREE-001',family:'selective_prediction',status:sel.decision||'FAILED_TO_RUN',test:sel.test??null,final_holdout_status:sel.final_holdout_status??null}
 ],
 next_hypothesis:sel.next_hypothesis||'Inspect failures and formulate a scientifically distinct causal hypothesis.',
 guard:'RESEARCH ONLY; no production, no orders, no V23 changes'
};
const ledger=path.join(root,'research','experiment-ledger.jsonl');
fs.mkdirSync(path.dirname(ledger),{recursive:true});
fs.appendFileSync(ledger,JSON.stringify(entry)+'\n');
const state=[
 '# Proypers25 Autonomous Research State','',
 'Updated: '+now,'',
 'Branch: research/post-signal-continuation-autopsy','',
 '## Latest batch',
 '- Multi-agent universe: '+(multi.n??'n/a'),
 '- Selective-disagreement universe: '+(sel.universe??'n/a'),
 '- Selective-disagreement decision: '+(sel.decision??'FAILED_TO_RUN'),
 '- Final holdout: '+(sel.final_holdout_status??'not evaluated'),
 '- Exit-policy reference chosen: '+(exit.chosen??'n/a'),
 '',
 '## Next hypothesis',
 sel.next_hypothesis||'Inspect failures and generate a distinct hypothesis.',
 '',
 '## Guardrails',
 'Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.',
 ''
].join('\n');
fs.writeFileSync(path.join(root,'research','RESEARCH_STATE.md'),state);
console.log(JSON.stringify(entry,null,2));
