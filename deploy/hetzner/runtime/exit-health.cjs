'use strict';
const fs=require('node:fs'),path=require('node:path');
function exitHealthy(state,now=Date.now()){
  try{
    const r=JSON.parse(fs.readFileSync(path.join(state,'github-spot-auto-exit.js.last.json'),'utf8'));
    const age=now-Date.parse(r.at);
    return r.code===0&&r.timedOut===false&&Number.isFinite(age)&&age>=0&&age<=15*60000;
  }catch{return false;}
}
module.exports={exitHealthy};
