import json, os, re, subprocess, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

BASE="https://data-api.binance.vision"
REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
NOW=datetime.now(timezone.utc)

def api(url):
    req=urllib.request.Request(url,headers={"User-Agent":"proypers25-timesfm-evaluator/1.0"})
    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)

def gh(args):
    p=subprocess.run(["gh"]+args,capture_output=True,text=True,check=True)
    return json.loads(p.stdout)

runs=gh(["api",f"repos/{REPO}/actions/workflows/spot-core-timesfm-prospective.yml/runs?per_page=100"])
out=[]; seen=set()
for run in runs.get("workflow_runs",[]):
    created=datetime.fromisoformat(run["created_at"].replace("Z","+00:00"))
    if NOW-created < timedelta(hours=4) or NOW-created > timedelta(days=3): continue
    jobs=gh(["api",f"repos/{REPO}/actions/runs/{run['id']}/jobs?per_page=10"]).get("jobs",[])
    if not jobs: continue
    raw=subprocess.run(["gh","api",f"repos/{REPO}/actions/jobs/{jobs[0]['id']}/logs"],capture_output=True,text=True,check=True).stdout
    def grab(pattern):
        m=re.search(pattern,raw); return m.group(1) if m else None
    symbol=grab(r'"symbol":\s*"([^"]+)"')
    price=grab(r'"signal_price":\s*([0-9.eE+-]+)')
    created_s=grab(r'"signal_created_at":\s*"([^"]+)"')
    edge=grab(r'"forecast_edge_pct":\s*([0-9.eE+-]+)')
    sel=grab(r'"selected_shadow_buy":\s*(true|false)')
    if not all([symbol,price,created_s,edge,sel]): continue
    key=(symbol,created_s)
    if key in seen: continue
    seen.add(key)
    ts=int(datetime.fromisoformat(created_s.replace("Z","+00:00")).timestamp()*1000)
    price=float(price); selected=sel=="true"
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"1m","startTime":ts,"endTime":ts+4*3600*1000,"limit":300})
    rows=[v for v in api(f"{BASE}/api/v3/klines?{q}") if ts <= int(v[0]) <= ts+4*3600*1000]
    if not rows: continue
    close=float(rows[-1][4]); high=max(float(v[2]) for v in rows); low=min(float(v[3]) for v in rows)
    ret=(close/price-1)*100
    out.append({"source_run_id":run["id"],"symbol":symbol,"signal_price":price,"signal_created_at":created_s,
      "forecast_edge_pct":float(edge),"selected_shadow_buy":selected,"return_4h_pct":ret,
      "mfe_4h_pct":(high/price-1)*100,"mae_4h_pct":(low/price-1)*100,
      "avoided_loss_if_rejected":(not selected) and ret<0,"missed_gain_if_rejected":(not selected) and ret>0})

summary={"evaluated":len(out),"rejected":sum(not x["selected_shadow_buy"] for x in out),
"avoided_losses":sum(x["avoided_loss_if_rejected"] for x in out),
"missed_gains":sum(x["missed_gain_if_rejected"] for x in out)}
json.dump({"summary":summary,"decisions":out},open("core-timesfm-mature-batch.json","w"),indent=2)
print(json.dumps(summary,indent=2))
for x in out: print(json.dumps(x))
