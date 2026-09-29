'use strict';

const fs=require('fs');
const path=require('path');

const CFG_PATH=process.env.QPU_V04_CONFIG||path.join(__dirname,'..','config','qpu-v04-bidirectional-frozen.json');
const cfg=JSON.parse(fs.readFileSync(CFG_PATH,'utf8'));
const F=cfg.features, K=cfg.families;

function num(v){const x=Number(v);return Number.isFinite(x)?x:0}
function vector(row){return F.map(k=>typeof row[k]==='boolean'?(row[k]?1:0):num(row[k]))}
function zscore(x){return x.map((v,i)=>(v-cfg.scaler.mean[i])/cfg.scaler.scale[i])}
function softmax(a){const m=Math.max(...a),e=a.map(x=>Math.exp(x-m)),s=e.reduce((p,x)=>p+x,0);return e.map(x=>x/s)}

function forward(z){
  const logits=cfg.forward.coef.map((w,j)=>w.reduce((s,v,i)=>s+v*z[i],cfg.forward.intercept[j]));
  const p=softmax(logits), out={};
  for(let j=0;j<cfg.forward.classes.length;j++)out[cfg.forward.classes[j]]=p[j];
  return Object.fromEntries(K.map(k=>[k,out[k]||0]));
}

function inverse(z){
  const ll={};
  for(const k of K){
    const mu=cfg.inverse.mean[k],vr=cfg.inverse.var[k];
    let s=0;
    for(let i=0;i<z.length;i++)s+=-.5*(Math.log(2*Math.PI*vr[i])+((z[i]-mu[i])**2)/vr[i]);
    ll[k]=s;
  }
  const m=Math.max(...Object.values(ll)),w=Object.fromEntries(K.map(k=>[k,Math.exp(ll[k]-m)]));
  const sw=Object.values(w).reduce((a,b)=>a+b,0);
  return Object.fromEntries(K.map(k=>[k,w[k]/sw]));
}

function normalizeObj(o){const s=Object.values(o).reduce((a,b)=>a+b,0);return Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v/s]))}

function weightedQpu(prob,rounds=2){
  const active=K.length;
  let dim=1;while(dim<active)dim*=2;
  const vals=K.map(k=>Math.max(0,num(prob[k]))),sum=vals.reduce((a,b)=>a+b,0);
  const p=vals.map(v=>v/sum);
  const refRe=Array(dim).fill(0),refIm=Array(dim).fill(0),stRe=Array(dim).fill(0),stIm=Array(dim).fill(0);
  for(let i=0;i<active;i++){refRe[i]=Math.sqrt(p[i]);stRe[i]=refRe[i]}
  const positive=p.filter(v=>v>0),floor=Math.min(...positive)*.1;
  const logs=p.map(v=>Math.log(Math.max(v,floor)));
  const mean=logs.reduce((a,b)=>a+b,0)/active;
  const sd=Math.sqrt(logs.reduce((s,v)=>s+(v-mean)**2,0)/active);
  const norm=sd<1e-12?logs.map(()=>0):logs.map(v=>Math.tanh((v-mean)/sd));
  const ph=Array.from({length:dim},(_,i)=>i<active?Math.PI*norm[i]:0);
  for(let r=0;r<rounds;r++){
    for(let i=0;i<dim;i++){const c=Math.cos(ph[i]),s=Math.sin(ph[i]),a=stRe[i],b=stIm[i];stRe[i]=a*c-b*s;stIm[i]=a*s+b*c}
    let ovRe=0,ovIm=0;for(let i=0;i<dim;i++){ovRe+=refRe[i]*stRe[i];ovIm+=refRe[i]*stIm[i]}
    for(let i=0;i<dim;i++){stRe[i]=2*refRe[i]*ovRe-stRe[i];stIm[i]=2*refRe[i]*ovIm-stIm[i]}
  }
  const raw=K.map((k,i)=>stRe[i]**2+stIm[i]**2),mass=raw.reduce((a,b)=>a+b,0);
  return Object.fromEntries(K.map((k,i)=>[k,raw[i]/mass]));
}

function argmax(o){return Object.entries(o).sort((a,b)=>b[1]-a[1])[0][0]}

function predict(row){
  const started=process.hrtime.bigint();
  const z=zscore(vector(row));
  const f=forward(z),inv=inverse(z);
  const joint=normalizeObj(Object.fromEntries(K.map(k=>[k,Math.sqrt(Math.max(f[k],1e-15)*Math.max(inv[k],1e-15))])));
  const q=weightedQpu(joint,cfg.qpu.rounds);
  const continuation=['plus_3','plus_5','plus_10','plus_20'].reduce((s,k)=>s+q[k],0);
  const plus10=q.plus_10+q.plus_20;
  return {
    model_version:cfg.version,research_only:true,no_order_created:true,
    forward_probabilities:f,inverse_probabilities:inv,joint_probabilities:joint,qpu_probabilities:q,
    forward_decision:argmax(f),inverse_decision:argmax(inv),joint_decision:argmax(joint),qpu_decision:argmax(q),
    continuation_probability:continuation,plus10_probability:plus10,
    prediction_elapsed_ms:Number(process.hrtime.bigint()-started)/1e6
  };
}

if(require.main===module){
  const raw=process.argv[2]||fs.readFileSync(0,'utf8');
  console.log(JSON.stringify(predict(JSON.parse(raw))));
}

module.exports={predict,weightedQpu};
