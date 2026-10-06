import io, json, os, urllib.parse, urllib.request, zipfile
from datetime import datetime, timezone, timedelta

BINANCE="https://data-api.binance.vision"
REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
TOKEN=os.environ.get("GH_TOKEN","")
NOW=datetime.now(timezone.utc)

def get_json(url, github=False):
    headers={"User-Agent":"proypers25-timesfm-evaluator/2.0"}
    if github and TOKEN: headers["Authorization"]=f"Bearer {TOKEN}"
    req=urllib.request.Request(url,headers=headers)
    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)

def get_bytes(url):
    headers={"User-Agent":"proypers25-timesfm-evaluator/2.0","Accept":"application/vnd.github+json"}
    if TOKEN: headers["Authorization"]=f"Bearer {TOKEN}"
    req=urllib.request.Request(url,headers=headers)
    with urllib.request.urlopen(req,timeout=60) as r:return r.read()

# Artifacts are the immutable prospective records; do not scrape job logs.
arts=get_json(f"https://api.github.com/repos/{REPO}/actions/artifacts?per_page=100",github=True).get("artifacts",[])
decisions=[]; seen=set()
for a in arts:
    name=a.get("name","")
    if not name.startswith("core-timesfm-prospective-") or a.get("expired"): continue
    created=datetime.fromisoformat(a["created_at"].replace("Z","+00:00"))
    if NOW-created < timedelta(hours=4) or NOW-created > timedelta(days=3): continue
    try:
        blob=get_bytes(f"https://api.github.com/repos/{REPO}/actions/artifacts/{a['id']}/zip")
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            candidates=[n for n in z.namelist() if n.endswith("core-timesfm-prospective.json")]
            if not candidates: continue
            d=json.loads(z.read(candidates[0]).decode("utf-8-sig"))
    except Exception as e:
        print(f"WARN artifact {a.get('id')} skipped: {type(e).__name__}: {e}")
        continue
    symbol=d.get("symbol"); created_s=d.get("signal_created_at"); price=float(d.get("signal_price") or 0)
    if not symbol or not created_s or price<=0: continue
    key=(symbol,created_s)
    if key in seen: continue
    seen.add(key)
    ts=int(datetime.fromisoformat(created_s.replace("Z","+00:00")).timestamp()*1000)
    selected=bool(d.get("selected_shadow_buy"))
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"1m","startTime":ts,"endTime":ts+4*3600*1000,"limit":300})
    try:
        rows=[v for v in get_json(f"{BINANCE}/api/v3/klines?{q}") if ts <= int(v[0]) <= ts+4*3600*1000]
    except Exception as e:
        print(f"WARN Binance {symbol} skipped: {type(e).__name__}: {e}"); continue
    if not rows: continue
    close=float(rows[-1][4]); high=max(float(v[2]) for v in rows); low=min(float(v[3]) for v in rows)
    ret=(close/price-1)*100
    decisions.append({"artifact_id":a["id"],"symbol":symbol,"signal_price":price,"signal_created_at":created_s,
      "forecast_edge_pct":float(d.get("forecast_edge_pct") or 0),"selected_shadow_buy":selected,
      "return_4h_pct":ret,"net_4h_pct_after_0_2_cost":ret-0.2,
      "mfe_4h_pct":(high/price-1)*100,"mae_4h_pct":(low/price-1)*100,
      "avoided_loss_if_rejected":(not selected) and (ret-0.2)<0,
      "missed_net_gain_if_rejected":(not selected) and (ret-0.2)>0})

rejected=[x for x in decisions if not x["selected_shadow_buy"]]
accepted=[x for x in decisions if x["selected_shadow_buy"]]
summary={"evaluated":len(decisions),"rejected":len(rejected),"accepted":len(accepted),
"avoided_losses":sum(x["avoided_loss_if_rejected"] for x in rejected),
"missed_net_gains":sum(x["missed_net_gain_if_rejected"] for x in rejected),
"rejected_avg_net_4h_pct":(sum(x["net_4h_pct_after_0_2_cost"] for x in rejected)/len(rejected) if rejected else None),
"accepted_avg_net_4h_pct":(sum(x["net_4h_pct_after_0_2_cost"] for x in accepted)/len(accepted) if accepted else None)}
payload={"generated_at":NOW.isoformat().replace("+00:00","Z"),"cost_pct":0.2,"summary":summary,"decisions":sorted(decisions,key=lambda x:x["signal_created_at"])}
with open("core-timesfm-mature-batch.json","w",encoding="utf-8") as f: json.dump(payload,f,indent=2)
print(json.dumps(summary,indent=2))
for x in payload["decisions"]: print(json.dumps(x))
