import json, os, sys, time, urllib.parse, urllib.request
import numpy as np
import torch, timesfm

BASE="https://data-api.binance.vision"
IN=os.environ.get("CORE_INPUT","core-timesfm-input.json")
SHARD_INDEX=int(os.environ.get("CORE_SHARD_INDEX","0"))
SHARD_COUNT=max(1,int(os.environ.get("CORE_SHARD_COUNT","1")))
OUT=os.environ.get("CORE_OUTPUT","core-timesfm-results.json")
CONTEXT=512
HORIZON=60

def get_json(url):
    last=None
    for i in range(5):
        try:
            req=urllib.request.Request(url,headers={"User-Agent":"proypers25-timesfm/1.0"})
            with urllib.request.urlopen(req,timeout=30) as r: return json.load(r)
        except Exception as e:
            last=e; time.sleep(.4*(i+1))
    raise last

def candles(symbol,ts):
    end=int(ts)-1
    start=end-(CONTEXT+20)*60000
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"1m","startTime":start,"endTime":end,"limit":CONTEXT+20})
    k=get_json(f"{BASE}/api/v3/klines?{q}")
    closes=[float(x[4]) for x in k if int(x[0])<=end]
    return closes[-CONTEXT:]

data=json.load(open(IN,encoding="utf-8"))
model=timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch",cache_dir=os.environ.get("HF_HOME"),force_download=False)
model.compile(timesfm.ForecastConfig(max_context=CONTEXT,max_horizon=HORIZON,per_core_batch_size=8,normalize_inputs=True,use_continuous_quantile_head=True,force_flip_invariance=True,infer_is_positive=True,fix_quantile_crossing=True))
rows=[]; prepared=[]
signals=[s for i,s in enumerate(data.get("signals",[])) if i % SHARD_COUNT == SHARD_INDEX]
for idx,s in enumerate(signals,1):
    row=dict(s); rows.append(row)
    try:
        ts=int(__import__("datetime").datetime.fromisoformat(s["created_at"].replace("Z","+00:00")).timestamp()*1000)
        x=candles(s["symbol"],ts)
        if len(x)<CONTEXT: raise RuntimeError(f"insufficient_context:{len(x)}")
        prepared.append((idx-1,np.asarray(x,dtype=np.float32),float(x[-1])))
    except Exception as e:
        row.update({"status":"ERROR","error":repr(e)})
BATCH=8
for off in range(0,len(prepared),BATCH):
    batch=prepared[off:off+BATCH]
    try:
        point,q=model.forecast(horizon=HORIZON,inputs=[x for _,x,_ in batch])
        for j,(ri,x,ref) in enumerate(batch):
            p=np.asarray(point[j],dtype=float); qq=np.asarray(q[j],dtype=float)
            upside=float(np.max(p)/ref-1); downside=float(np.min(p)/ref-1)
            rows[ri].update({"status":"FORECASTED","context_bars":len(x),"context_last_close":ref,"forecast_horizon_min":HORIZON,
              "forecast_upside_pct":upside*100,"forecast_downside_pct":downside*100,
              "forecast_edge_pct":(upside+downside)*100,"forecast_terminal_pct":(float(p[-1])/ref-1)*100,
              "forecast_point_min":float(np.min(p)),"forecast_point_max":float(np.max(p)),
              "quantile_shape":list(qq.shape)})
    except Exception as e:
        for ri,_,_ in batch: rows[ri].update({"status":"ERROR","error":repr(e)})
    print(f"[{min(off+BATCH,len(prepared))}/{len(prepared)}] forecast batch",flush=True)
result={"ok":True,"research_only":True,"shadow_only":True,"no_order_created":True,"model":"google/timesfm-2.5-200m-pytorch",
 "context_bars":CONTEXT,"horizon_min":HORIZON,"shard_index":SHARD_INDEX,"shard_count":SHARD_COUNT,"definition":"Forecast inputs end before signal timestamp; outcome labels are never model inputs.",
 "rows":rows,"coverage":{"total":len(rows),"forecasted":sum(r["status"]=="FORECASTED" for r in rows),"errors":sum(r["status"]=="ERROR" for r in rows)}}
json.dump(result,open(OUT,"w",encoding="utf-8"),indent=2)
print(json.dumps(result["coverage"],indent=2))
