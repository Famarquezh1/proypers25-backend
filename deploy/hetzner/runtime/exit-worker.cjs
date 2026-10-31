'use strict';
const path=require('node:path');
const {lock}=require('./execution-safety.cjs');
const {createExitSafety}=require('./exit-safety.cjs');
const LEAVES=new Set(['github-xec-historical-protection.js','github-spot-v61-protect.js',
  'github-spot-auto-exit-legacy-v10-aware.js','github-spot-orphan-protect.js','github-spot-orphan-audit.js']);
async function main(){
  const script=process.argv[2];if(!LEAVES.has(script))throw new Error('EXIT_SCRIPT_REFUSED');
  const state=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25';
  const release=lock(path.join(state,'execution-state'));process.once('exit',release);
  const safety=createExitSafety({transport:global.fetch,dir:path.join(state,'exit-state'),
    key:process.env.BINANCE_API_KEY,secret:process.env.BINANCE_SECRET_KEY});
  if((await safety.recover()).pending)throw new Error('EXIT_RECOVERY_PENDING');
  global.fetch=safety.fetch;
  require(path.join(process.env.PROYPERS_REPO||'/opt/proypers25/repo','backend/scripts',script));
}
main().catch(()=>{console.error('EXIT_SAFETY_BLOCKED');process.exitCode=2;});
