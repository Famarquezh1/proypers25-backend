'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
class Journal {
  constructor(dir) {this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});}
  claim(signal) {
    if (!/^[A-Z0-9._-]+USDT$/.test(signal.symbol) || !Number.isFinite(Date.parse(signal.createdAt))) throw new Error('INVALID_SIGNAL');
    const id = crypto.createHash('sha256').update(`${signal.lane||'CORE'}:${signal.symbol}:${signal.createdAt}`).digest('hex').slice(0,24);
    const file = path.join(this.dir, `${id}.json`);
    // An existing intent is never automatically replayed, including UNKNOWN after a crash.
    try {
      const fd = fs.openSync(file,'wx',0o600);
      try { fs.writeFileSync(fd, JSON.stringify({id,clientOrderId:`proypers-gh-vps-${id.slice(0,20)}`,state:'OBSERVED',signal}));fs.fsyncSync(fd); }
      finally {fs.closeSync(fd);}
      const parent=fs.openSync(this.dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    } catch(e) {if(e.code==='EEXIST')return null;throw e;}
    return {id,file,clientOrderId:`proypers-gh-vps-${id.slice(0,20)}`};
  }
  finish(intent, result) {
    const prior=JSON.parse(fs.readFileSync(intent.file,'utf8'));
    atomic(intent.file,{...prior,state:'SHADOW_VALIDATED',result,updatedAt:new Date().toISOString()});
  }
}
module.exports={atomic,Journal};
