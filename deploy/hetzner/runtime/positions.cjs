'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {atomic} = require('./journal.cjs');
function readRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^[a-f0-9]{32}\.json$/.test(n))
    .map(n => JSON.parse(fs.readFileSync(path.join(dir,n),'utf8')));
}
function updatePositions(state, audit, now=Date.now()) {
  const file=path.join(state,'positions.json');
  const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,positions:{},events:[]};
  if(previous.version!==1||!previous.positions||!Array.isArray(previous.events))throw new Error('POSITION_LEDGER_REVIEW_REQUIRED');
  if(!Array.isArray(audit.positions)||!Number.isFinite(Date.parse(audit.at)))throw new Error('POSITION_AUDIT_REQUIRED');
  const entries=readRecords(path.join(state,'execution-state'));
  const positions={...previous.positions},events=[...previous.events];
  const at=new Date(now).toISOString(), seen=new Set();
  for(const row of audit.positions) {
    const id=row.symbol||`asset:${row.asset}`;
    if((!row.symbol&&!row.asset)||(row.quantity!==undefined&&!Number.isFinite(Number(row.quantity))))throw new Error('POSITION_QUANTITY_INVALID');
    seen.add(id);
    const managed=entries.filter(e=>e.symbol===row.symbol&&Number(e.buy?.executedQty)>0);
    const before=positions[id];
    const current={...before,...row,lastSeenAt:at,missingSince:null,closedAt:null,
      firstSeenAt:before?.firstSeenAt||at,origin:managed.length?'LOCAL_CONFIRMED_BUY':'EXTERNAL_BALANCE_OBSERVED',
      managedBuyIds:[...new Set(managed.map(e=>e.buy.orderId))]};
    if(!before||before.status!==current.status||before.quantity!==current.quantity||before.closedAt)
      events.push({at,id,status:current.status,quantity:current.quantity??null,origin:current.origin});
    positions[id]=current;
  }
  for(const [id,row] of Object.entries(positions))if(!seen.has(id)&&!row.closedAt) {
    // Two independent snapshots must observe absence; an external balance disappearance is not labeled a SELL.
    if(row.missingSince){positions[id]={...row,closedAt:at,status:'BALANCE_NO_LONGER_PRESENT'};events.push({at,id,status:'BALANCE_NO_LONGER_PRESENT'});}
    else positions[id]={...row,missingSince:at,status:'ABSENCE_PENDING_CONFIRMATION'};
  }
  const result={version:1,updatedAt:at,auditAt:audit.at,positions,events:events.slice(-500),tradingActivated:false};
  atomic(file,result);return result;
}
function localManagedIssues(state, now=Date.now()) {
  const file=path.join(state,'positions.json');
  const ledger=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(ledger&&(ledger.version!==1||!ledger.positions))throw new Error('POSITION_LEDGER_REVIEW_REQUIRED');
  return readRecords(path.join(state,'execution-state')).filter(r=>Number(r.buy?.executedQty)>0&&r.state!=='CLOSED'&&!ledger?.positions[r.symbol]?.closedAt).map(r=>({
    number:0,title:`[SPOT SIGNAL] ${r.symbol}`,state:'closed',state_reason:'completed',
    // Refresh only the exit-scope adapter date. The original entry time is still read from Binance orders.
    created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString(),
    body:`Local confirmed BUY; orderId=${r.buy.orderId}; lane=${r.lane}; originalSignalAt=${r.createdAt}`
  }));
}
module.exports={updatePositions,localManagedIssues};
