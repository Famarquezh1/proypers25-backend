'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');

const src=fs.readFileSync(path.join(__dirname,'..','scripts','github-spot-v22-iceberg-shadow.js'),'utf8');

for(const lane of ['CORE_ALL','STRICT_V21','BALANCED','EXPLORATORY']){
  assert(src.includes(lane),`missing iceberg lane ${lane}`);
}
assert(src.includes("STRICT_V21:{mode:'CONFIRM',retScale:1,closeDelta:0,minVol:.70}"),'strict lane must preserve V21 confirmation');
assert(src.includes("BALANCED:{mode:'CONFIRM',retScale:.75,closeDelta:-.05,minVol:.55}"),'balanced lane parameters changed unexpectedly');
assert(src.includes("EXPLORATORY:{mode:'CONFIRM',retScale:.25,closeDelta:-.15,minVol:.35}"),'exploratory lane parameters changed unexpectedly');
assert(src.includes("CORE_ALL:{mode:'IMMEDIATE'}"),'CORE control must remain immediate');
assert(src.includes("const COST=.004"),'economic comparison must keep 0.4% roundtrip cost');
assert(src.includes("const EXIT={hardStop:.04,takeProfit:.06,timeoutMinutes:8*60}"),'all iceberg lanes must share +6/-4/8h exit');
assert(!/BINANCE_(API|SECRET)_KEY|firebase-admin|firestore|api\/v3\/order|placeOrder|createOrder|withdraw/.test(src),'V22 must remain execution-free');
assert(src.includes("production_action:'NONE'"),'V22 must declare no production action');
assert(src.includes('no_order_created:true'),'V22 must preserve no-order invariant');

console.log('githubSpotV22IcebergShadow tests: PASS');
