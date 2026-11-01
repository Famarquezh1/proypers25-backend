'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createSafety,lock}=require('./execution-safety.cjs');
const {createExitSafety}=require('./exit-safety.cjs');
const {createTransitions}=require('./protection-transition.cjs');
async function main(){
  const repo=process.env.PROYPERS_REPO||'/opt/proypers25/repo';
  const dir=path.join(process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25','execution-state');
  const release=lock(dir);process.once('exit',release);
  const context=process.argv.includes('--recover-only')?null:{symbol:process.env.SIGNAL_SYMBOL,lane:process.env.SIGNAL_LANE||'CORE',createdAt:process.env.SIGNAL_CREATED_AT};
  if(context&&(!/^[A-Z0-9._-]+USDT$/.test(context.symbol)||!Number.isFinite(Date.parse(context.createdAt))))throw new Error('SIGNAL_CONTEXT_INVALID');
  const safety=createSafety({transport:global.fetch,dir,repo,key:process.env.BINANCE_API_KEY,secret:process.env.BINANCE_SECRET_KEY,context});
  const exitSafety=createExitSafety({transport:global.fetch,dir:path.join(process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25','exit-state'),key:process.env.BINANCE_API_KEY,secret:process.env.BINANCE_SECRET_KEY});
  if((await exitSafety.recover()).pending)throw new Error('SELL_RECOVERY_PENDING_NEW_BUYS_BLOCKED');
  const transitions=createTransitions({transport:global.fetch,dir:path.join(process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25','transition-state'),key:process.env.BINANCE_API_KEY,secret:process.env.BINANCE_SECRET_KEY,resumeSell:exitSafety.resumeConfirmedSell});
  if((await transitions.recover()).pending)throw new Error('TRANSITION_RECOVERY_PENDING_NEW_BUYS_BLOCKED');
  const recovery=await safety.recover();
  if(recovery.pending)throw new Error('PROTECTION_OR_ORDER_RECOVERY_PENDING_NEW_BUYS_BLOCKED');
  if(!context){console.log(JSON.stringify({event:'ORDER_RECOVERY_CHECK',pending:0}));return;}
  const prior=safety.current();
  if(prior){
    const outcome=['PROTECTED','CLOSED'].includes(prior.state)?'executed':'declined';
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`outcome=${outcome}\nreason=Existing intent reconciled; no duplicate BUY\norder_id=${prior.buy?.orderId||''}\nsymbol=${context.symbol}\n`);
    console.log(JSON.stringify({event:'ENTRY_REPLAY_SUPPRESSED',state:prior.state}));return;
  }
  global.fetch=safety.fetch;
  require(path.join(repo,'backend/scripts/github-spot-manual-execution-v10-aware.js'));
}
main().catch(()=>{console.error('ENTRY_SAFETY_BLOCKED');process.exitCode=2;});
