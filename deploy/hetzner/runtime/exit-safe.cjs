'use strict';
// Preserve the original chain and labels; put each child behind the shared execution lock.
const cp=require('node:child_process');
const path=require('node:path');
const originalSpawn=cp.spawnSync;
const worker=path.join(__dirname,'exit-worker.cjs');
cp.spawnSync=function(command,args,options){
  if(command!==process.execPath||!Array.isArray(args)||args.length!==1)throw new Error('EXIT_CHILD_REFUSED');
  return originalSpawn(command,[worker,path.basename(args[0])],options);
};
require(path.join(process.env.PROYPERS_REPO||'/opt/proypers25/repo','backend/scripts/github-spot-auto-exit.js'));
