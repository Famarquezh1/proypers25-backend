'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic}=require('./journal.cjs');
const {localManagedIssues}=require('./positions.cjs');
function localContext(url,init={}){
  if(url.pathname!=='/repos/Famarquezh1/proypers25-backend/issues'&&!/^\/repos\/Famarquezh1\/proypers25-backend\/issues\/\d+$/.test(url.pathname))throw new Error('LOCAL_CONTEXT_ROUTE_REFUSED');
  const state=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25';
  const file=path.join(state,'local-issues.json');
  const local=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
  if(!Array.isArray(local))throw new Error('LOCAL_CONTEXT_INVALID');
  const method=init.method||'GET';
  if(method==='GET'){
    const historical=JSON.parse(fs.readFileSync(process.env.PROYPERS_MANAGED_CONTEXT,'utf8')).issues;
    if(!Array.isArray(historical))throw new Error('LOCAL_CONTEXT_INVALID');
    const filter=url.searchParams.get('state')||'open';
    return Response.json([...localManagedIssues(state),...local,...historical].filter(i=>filter==='all'||i.state===filter));
  }
  if(!['POST','PATCH'].includes(method))throw new Error('LOCAL_CONTEXT_WRITE_REFUSED');
  const data=JSON.parse(init.body||'{}');
  if(typeof data.body!=='string'||data.body.length>65536||method==='POST'&&typeof data.title!=='string')throw new Error('LOCAL_CONTEXT_WRITE_INVALID');
  const number=method==='PATCH'?Number(url.pathname.split('/').at(-1)):
    parseInt(crypto.createHash('sha256').update(`${data.title}:${data.body}`).digest('hex').slice(0,10),16);
  const index=local.findIndex(i=>i.number===number);
  if(method==='PATCH'&&index<0)throw new Error('LOCAL_CONTEXT_ISSUE_NOT_FOUND');
  const at=new Date().toISOString();
  const record={...(index>=0?local[index]:{number,state:'open',created_at:at}),...data,updated_at:at,localOnly:true};
  if(index>=0)local[index]=record;else local.unshift(record);
  atomic(file,local.slice(0,500));return Response.json(record,{status:method==='POST'?201:200});
}
module.exports={localContext};
