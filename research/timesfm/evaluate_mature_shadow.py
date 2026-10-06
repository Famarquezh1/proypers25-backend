import json, os, urllib.parse, urllib.request
from datetime import datetime, timezone

BASE="https://data-api.binance.vision"
SYMBOL=os.environ["SIGNAL_SYMBOL"]
PRICE=float(os.environ["SIGNAL_PRICE"])
CREATED=os.environ["SIGNAL_CREATED_AT"]
EDGE=float(os.environ["FORECAST_EDGE_PCT"])
SELECTED=os.environ.get("SELECTED_SHADOW_BUY","false").lower()=="true"
ISSUE_RAW=os.environ.get("SIGNAL_ISSUE","").strip()
ISSUE=int(ISSUE_RAW) if ISSUE_RAW else None
OUT="core-timesfm-mature-evaluation.json"

def get_json(url):
    req=urllib.request.Request(url,headers={"User-Agent":"proypers25-timesfm-evaluator/1.0"})
    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)

ts=int(datetime.fromisoformat(CREATED.replace("Z","+00:00")).timestamp()*1000)
if int(datetime.now(timezone.utc).timestamp()*1000) < ts+4*3600*1000:
    raise RuntimeError("signal_not_mature_4h")
q=urllib.parse.urlencode({"symbol":SYMBOL,"interval":"1m","startTime":ts,"endTime":ts+4*3600*1000,"limit":300})
future=get_json(f"{BASE}/api/v3/klines?{q}")
rows=[v for v in future if ts <= int(v[0]) <= ts+4*3600*1000]
if not rows: raise RuntimeError("no_future_bars")
close=float(rows[-1][4]); high=max(float(v[2]) for v in rows); low=min(float(v[3]) for v in rows)
ret=(close/PRICE-1)*100; mfe=(high/PRICE-1)*100; mae=(low/PRICE-1)*100
result={"research_only":True,"shadow_only":True,"issue":ISSUE,"symbol":SYMBOL,"signal_price":PRICE,"signal_created_at":CREATED,
"forecast_edge_pct":EDGE,"selected_shadow_buy":SELECTED,"bars":len(rows),"return_4h_pct":ret,"mfe_4h_pct":mfe,"mae_4h_pct":mae,
"avoided_loss_if_rejected":(not SELECTED) and ret<0,"missed_gain_if_rejected":(not SELECTED) and ret>0,
"evaluated_at":datetime.now(timezone.utc).isoformat().replace("+00:00","Z")}
json.dump(result,open(OUT,"w"),indent=2); print(json.dumps(result,indent=2))
