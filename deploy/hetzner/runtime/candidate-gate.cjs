'use strict';
const fs=require('node:fs'),path=require('node:path');
function authorization(){
  const dir=process.env.CREDENTIALS_DIRECTORY;
  if(!dir)throw new Error('OWNER_AUTHORIZATION_REQUIRED');
  const a=JSON.parse(fs.readFileSync(path.join(dir,'live-authorization'),'utf8'));
  const release=path.basename(path.dirname(__dirname));
  if(a.version!==1||a.mode!=='LIVE_CORE_ONLY'||a.release!==release||a.strategy!=='8d88021dea30eb87f786b5685818d01204d132a3')throw new Error('OWNER_AUTHORIZATION_MISMATCH');
  return a;
}
function assertExecutionLock(){
  const state=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25';
  const lock=JSON.parse(fs.readFileSync(path.join(state,'execution-state/execution.lock'),'utf8'));
  const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  if(lock.pid!==process.pid||lock.boot!==boot)throw new Error('EXCLUSIVE_EXECUTION_LOCK_REQUIRED');
}
module.exports={authorization,assertExecutionLock};
