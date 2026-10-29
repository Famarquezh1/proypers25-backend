'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createEvidenceClient} = require('./github_evidence');
const run = {id:1,run_attempt:1,status:'completed',conclusion:'success'};
function setup(t, fetchImpl, extra={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return createEvidenceClient({repo:'owner/repo',token:'secret',directory,fetchImpl,...extra});
}
test('reuses successful evidence but fetches reruns and live indexes again',async t=>{
  let calls=0;
  const client=setup(t,async url=>{calls++;return new Response(url.includes('/jobs?')?JSON.stringify({jobs:[{id:2,name:'plan'}]}):'{"ok":true,"value":42}');});
  const first=await client.evidence(run,'planner','plan',JSON.parse);
  assert.deepEqual(await client.evidence(run,'planner','plan',JSON.parse),first);
  assert.equal(calls,2);
  await client.evidence({...run,run_attempt:2},'planner','plan',JSON.parse);
  assert.equal(calls,4);
  await client.request('/actions/runs'); await client.request('/actions/runs');
  assert.equal(calls,6);
});
test('quota failures are explicit, not cached and not retried',async t=>{
  let calls=0;
  const client=setup(t,async()=>{calls++;return new Response('API rate limit exceeded',{status:403});});
  await assert.rejects(client.evidence(run,'planner','plan',JSON.parse),/GitHub 403/);
  await assert.rejects(client.evidence(run,'planner','plan',JSON.parse),/GitHub 403/);
  assert.equal(calls,2);
});
test('one bounded retry and request budget',async t=>{
  let calls=0,waits=[];
  const client=setup(t,async()=>new Response(++calls===1?'busy':'{}',{status:calls===1?503:200}),{sleep:async ms=>waits.push(ms),maxRequests:2});
  await client.request('/index'); assert.deepEqual(waits,[1000]);
  await assert.rejects(client.request('/index'),/budget exhausted/);
});
test('does not persist missing evidence or accept failed runs',async t=>{
  const client=setup(t,async()=>new Response('{"jobs":[]}'));
  await assert.rejects(client.evidence(run,'planner','plan',JSON.parse),/Missing evidence/);
  await assert.rejects(client.evidence({...run,conclusion:'failure'},'planner','plan',JSON.parse),/successful run/);
});
