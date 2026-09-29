#!/usr/bin/env python3
import json, math, sys
from pathlib import Path
import numpy as np

SCAN=Path(sys.argv[1] if len(sys.argv)>1 else "v10-hunter-scan.json")
MODEL=Path(sys.argv[2] if len(sys.argv)>2 else "backend/config/qpu-v09-consensus-frozen.json")
OUT=Path(sys.argv[3] if len(sys.argv)>3 else "qpu-v09-shadow-decision.json")

def ry(t):
    c,s=math.cos(t/2.0),math.sin(t/2.0)
    return np.asarray([[c,-s],[s,c]],dtype=np.complex128)
def rz(t):
    return np.asarray([[np.exp(-0.5j*t),0],[0,np.exp(0.5j*t)]],dtype=np.complex128)
H=np.asarray([[1,1],[1,-1]],dtype=np.complex128)/math.sqrt(2.0)

def q_features(feats,qubits,seed):
    names=sorted(feats)
    raw=np.asarray([float(feats[n]) for n in names],dtype=float)
    bounded=np.asarray([v/(1.0+abs(v)) for v in raw],dtype=float)
    expanded=np.resize(bounded,qubits)
    angles=(expanded+1.0)*(math.pi/2.0)
    st=np.zeros(1<<qubits,dtype=np.complex128);st[0]=1.0
    rng=np.random.default_rng(seed);phase=rng.uniform(-0.25,0.25,size=qubits)
    def one(g,q):
        step=1<<q;span=step<<1
        for base in range(0,1<<qubits,span):
            for off in range(step):
                i0,i1=base+off,base+off+step
                a,b=st[i0],st[i1]
                st[i0]=g[0,0]*a+g[0,1]*b
                st[i1]=g[1,0]*a+g[1,1]*b
    def cz(q1,q2):
        m1,m2=1<<q1,1<<q2
        for i in range(1<<qubits):
            if i&m1 and i&m2: st[i]*=-1.0
    for q in range(qubits):
        one(H,q);one(ry(float(angles[q])),q);one(rz(float(angles[q]*0.5+phase[q])),q)
    for q in range(qubits-1):cz(q,q+1)
    if qubits>2:cz(qubits-1,0)
    for q in range(qubits):one(ry(float(angles[(q+1)%qubits]*0.5)),q)
    probs=np.abs(st)**2
    out={}
    for q in range(qubits):
        signs=np.fromiter(((-1.0 if i&(1<<q) else 1.0) for i in range(st.size)),dtype=float)
        out[f"q_z_{q}"]=float(np.dot(probs,signs))
    for q in range(min(qubits-1,4)):
        signs=np.fromiter(((-1.0 if bool(i&(1<<q))^bool(i&(1<<(q+1))) else 1.0) for i in range(st.size)),dtype=float)
        out[f"q_zz_{q}_{q+1}"]=float(np.dot(probs,signs))
    out["q_entropy"]=-float(np.sum(probs*np.log2(probs+1e-15)))/qubits
    out["q_p0"]=float(probs[0])
    return out

def sigmoid(x):
    if x>=0:return 1.0/(1.0+math.exp(-x))
    e=math.exp(x);return e/(1.0+e)

def probability(x,spec):
    x=np.asarray(x,dtype=float)
    mean=np.asarray(spec["mean"],dtype=float);scale=np.asarray(spec["scale"],dtype=float)
    coef=np.asarray(spec["coef"],dtype=float)
    z=(x-mean)/scale
    return sigmoid(float(spec["intercept"]+np.dot(coef,z)))

scan=json.loads(SCAN.read_text(encoding="utf-8"))
model=json.loads(MODEL.read_text(encoding="utf-8"))
result={
  "ok":True,"research_only":True,"shadow_only":True,"no_order_created":True,
  "model_version":model["version"],"source_notify":bool(scan.get("notify",False)),
  "symbol":scan.get("symbol"),"target":scan.get("target"),"price":scan.get("price"),
}
flow=scan.get("qpu_shadow_flow")
if not scan.get("notify") or not isinstance(flow,dict):
    result.update({"scored":False,"reason":scan.get("reason") or "NO_V10_SIGNAL_OR_FLOW"})
else:
    names=model["flow_features"]
    missing=[n for n in names if n not in flow]
    if missing: raise SystemExit("missing flow inputs: "+",".join(missing))
    raw=[float(flow[n]) for n in names]
    qvec=[]
    for block in model["qpu"]["blocks"]:
        acc=None
        for seed in model["qpu"]["seeds"]:
            q=q_features({n:float(flow[n]) for n in block},int(model["qpu"]["qubits"]),int(seed))
            vec=np.asarray([q[n] for n in sorted(q)],dtype=float)
            acc=vec if acc is None else acc+vec
        qvec.extend((acc/len(model["qpu"]["seeds"])).tolist())
    pc=probability(raw,model["classical"])
    pa=probability(raw+qvec,model["augmented"])
    th=float(model["decision"]["threshold"])
    result.update({
      "scored":True,"classical_probability":pc,"augmented_probability":pa,
      "classical_positive":pc>=th,"augmented_positive":pa>=th,
      "consensus_accept":pc>=th and pa>=th,
      "flow_inputs":{n:float(flow[n]) for n in names}
    })
OUT.write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
print(json.dumps(result))
