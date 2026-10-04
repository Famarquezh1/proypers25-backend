import json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
import numpy as np
import torch, timesfm

BASE="https://data-api.binance.vision"
SYMBOL=os.environ["SIGNAL_SYMBOL"]
PRICE=float(os.environ["SIGNAL_PRICE"])
CREATED=os.environ["SIGNAL_CREATED_AT"]
ISSUE_RAW=os.environ.get("SIGNAL_ISSUE","").strip()
ISSUE=int(ISSUE_RAW) if ISSUE_RAW else None
CONTEXT=512; HORIZON=60
OUT="core-timesfm-prospective.json"

def get_json(url):
    req=urllib.request.Request(url,headers={"User-Agent":"proypers25-timesfm-shadow/1.0"})
    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)

ts=int(datetime.fromisoformat(CREATED.replace("Z","+00:00")).timestamp()*1000)
end=ts-1; start=end-(CONTEXT+20)*60000
q=urllib.parse.urlencode({"symbol":SYMBOL,"interval":"1m","startTime":start,"endTime":end,"limit":CONTEXT+20})
k=get_json(f"{BASE}/api/v3/klines?{q}")
x=[float(v[4]) for v in k if int(v[0])<=end][-CONTEXT:]
if len(x)<CONTEXT: raise RuntimeError(f"insufficient_context:{len(x)}")
model=timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch",cache_dir=os.environ.get("HF_HOME"),force_download=False)
model.compile(timesfm.ForecastConfig(max_context=CONTEXT,max_horizon=HORIZON,per_core_batch_size=1,normalize_inputs=True,use_continuous_quantile_head=True,force_flip_invariance=True,infer_is_positive=True,fix_quantile_crossing=True))
point,quant=model.forecast(horizon=HORIZON,inputs=[np.asarray(x,dtype=np.float32)])
p=np.asarray(point[0],dtype=float); ref=float(x[-1])
up=float(np.max(p)/ref-1)*100; down=float(np.min(p)/ref-1)*100; edge=up+down
selected=edge>0
result={"research_only":True,"shadow_only":True,"no_order_created":True,"issue":ISSUE,"symbol":SYMBOL,"signal_price":PRICE,"signal_created_at":CREATED,
"model":"google/timesfm-2.5-200m-pytorch","context_bars":CONTEXT,"horizon_min":HORIZON,
"frozen_rule":"forecast_edge_pct > 0 (verified historical ranking rule; shadow only, not production approval)","forecast_upside_pct":up,"forecast_downside_pct":down,"forecast_edge_pct":edge,
"forecast_terminal_pct":(float(p[-1])/ref-1)*100,"selected_shadow_buy":selected,
"evaluation_due_at":datetime.fromtimestamp(ts/1000+4*3600,tz=timezone.utc).isoformat().replace("+00:00","Z")}
json.dump(result,open(OUT,"w"),indent=2);print(json.dumps(result,indent=2))
