import io, json, math, os, urllib.error, urllib.parse, urllib.request, zipfile
from datetime import datetime, timezone, timedelta

BINANCE="https://data-api.binance.vision"
REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
TOKEN=os.environ.get("GH_TOKEN","")
NOW=datetime.now(timezone.utc)

def request(url, github=False, redirect=True):
    headers={"User-Agent":"proypers25-timesfm-evaluator/3.0"}
    if github:
        headers["Accept"]="application/vnd.github+json"
        if TOKEN:
            headers["Authorization"]=f"Bearer {TOKEN}"
    req=urllib.request.Request(url,headers=headers)
    if redirect:
        return urllib.request.urlopen(req,timeout=60)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener=urllib.request.build_opener(NoRedirect)
    try:
        return opener.open(req,timeout=60)
    except urllib.error.HTTPError as e:
        if e.code in (301,302,303,307,308):
            return e
        raise

def get_json(url, github=False):
    with request(url,github=github) as r:
        return json.load(r)

def get_artifact_zip(artifact_id):
    api=f"https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip"
    first=request(api,github=True,redirect=False)
    location=first.headers.get("Location")
    first.close()
    if not location:
        raise RuntimeError(f"artifact {artifact_id}: GitHub did not return signed download URL")
    # Important: do not forward the GitHub bearer token to Azure/blob storage.
    with request(location,github=False,redirect=True) as r:
        return r.read()

def list_successful_prospective_artifacts():
    workflow="spot-core-timesfm-prospective.yml"
    artifacts=[]
    page=1
    while True:
        url=f"https://api.github.com/repos/{REPO}/actions/workflows/{workflow}/runs?status=success&per_page=100&page={page}"
        runs=get_json(url,github=True).get("workflow_runs",[])
        if not runs:
            break
        for run in runs:
            run_id=run.get("id")
            if not run_id:
                continue
            aurl=f"https://api.github.com/repos/{REPO}/actions/runs/{run_id}/artifacts?per_page=100"
            for a in get_json(aurl,github=True).get("artifacts",[]):
                if a.get("expired"):
                    continue
                if str(a.get("name","")).startswith("core-timesfm-prospective-"):
                    artifacts.append(a)
        if len(runs)<100:
            break
        page+=1
    return artifacts

def safe_avg(values):
    return sum(values)/len(values) if values else None

def strategy_metrics(items):
    rets=[float(x["net_4h_pct_after_0_2_cost"]) for x in sorted(items,key=lambda y:y["signal_created_at"])]
    wins=[r for r in rets if r>0]
    losses=[r for r in rets if r<0]
    gross_profit=sum(wins)
    gross_loss=abs(sum(losses))
    pf=(gross_profit/gross_loss) if gross_loss>0 else None
    equity=100.0
    peak=100.0
    max_dd=0.0
    for r in rets:
        equity*=1+r/100.0
        peak=max(peak,equity)
        if peak>0:
            max_dd=min(max_dd,(equity/peak-1)*100.0)
    return {
        "trades":len(rets),
        "wins":len(wins),
        "losses":len(losses),
        "win_rate_pct":(100*len(wins)/len(rets)) if rets else None,
        "avg_net_4h_pct":safe_avg(rets),
        "sum_net_4h_pct":sum(rets),
        "profit_factor":pf,
        "compound_100_to":equity,
        "max_drawdown_pct":max_dd,
        "avg_mfe_4h_pct":safe_avg([float(x["mfe_4h_pct"]) for x in items]),
        "avg_mae_4h_pct":safe_avg([float(x["mae_4h_pct"]) for x in items]),
    }

decisions=[]
seen=set()
artifacts=list_successful_prospective_artifacts()
for a in artifacts:
    try:
        blob=get_artifact_zip(a["id"])
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            candidates=[n for n in z.namelist() if n.endswith("core-timesfm-prospective.json")]
            if not candidates:
                continue
            d=json.loads(z.read(candidates[0]).decode("utf-8-sig"))
    except Exception as e:
        print(f"WARN artifact {a.get('id')} skipped: {type(e).__name__}: {e}")
        continue

    symbol=d.get("symbol")
    created_s=d.get("signal_created_at")
    price=float(d.get("signal_price") or 0)
    if not symbol or not created_s or price<=0:
        continue
    signal_dt=datetime.fromisoformat(created_s.replace("Z","+00:00"))
    if NOW-signal_dt < timedelta(hours=4):
        continue
    key=(symbol,created_s)
    if key in seen:
        continue
    seen.add(key)

    ts=int(signal_dt.timestamp()*1000)
    target=ts+4*3600*1000
    selected=bool(d.get("selected_shadow_buy"))
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"1m","startTime":ts,"endTime":target,"limit":300})
    try:
        rows=[v for v in get_json(f"{BINANCE}/api/v3/klines?{q}") if ts <= int(v[0]) <= target]
    except Exception as e:
        print(f"WARN Binance {symbol} skipped: {type(e).__name__}: {e}")
        continue
    if not rows:
        continue

    close=float(rows[-1][4])
    high=max(float(v[2]) for v in rows)
    low=min(float(v[3]) for v in rows)
    ret=(close/price-1)*100
    net=ret-0.2
    decisions.append({
        "artifact_id":a["id"],
        "symbol":symbol,
        "signal_price":price,
        "signal_created_at":created_s,
        "frozen_rule":d.get("frozen_rule") or "unknown",
        "forecast_edge_pct":float(d.get("forecast_edge_pct") or 0),
        "selected_shadow_buy":selected,
        "return_4h_pct":ret,
        "net_4h_pct_after_0_2_cost":net,
        "mfe_4h_pct":(high/price-1)*100,
        "mae_4h_pct":(low/price-1)*100,
        "avoided_loss_if_rejected":(not selected) and net<0,
        "missed_net_gain_if_rejected":(not selected) and net>0,
    })

decisions=sorted(decisions,key=lambda x:x["signal_created_at"])
rejected=[x for x in decisions if not x["selected_shadow_buy"]]
accepted=[x for x in decisions if x["selected_shadow_buy"]]
avoided=[x for x in rejected if x["net_4h_pct_after_0_2_cost"]<0]
missed=[x for x in rejected if x["net_4h_pct_after_0_2_cost"]>0]

by_rule={}
for rule in sorted({x["frozen_rule"] for x in decisions}):
    subset=[x for x in decisions if x["frozen_rule"]==rule]
    a=[x for x in subset if x["selected_shadow_buy"]]
    r=[x for x in subset if not x["selected_shadow_buy"]]
    by_rule[rule]={
        "decisions":len(subset),
        "accepted":len(a),
        "rejected":len(r),
        "all_core":strategy_metrics(subset),
        "accepted_only":strategy_metrics(a),
        "rejected_only":strategy_metrics(r),
    }

summary={
    "evaluated":len(decisions),
    "accepted":len(accepted),
    "rejected":len(rejected),
    "avoided_losses":len(avoided),
    "avoided_loss_sum_pct":sum(-x["net_4h_pct_after_0_2_cost"] for x in avoided),
    "missed_net_gains":len(missed),
    "missed_net_gain_sum_pct":sum(x["net_4h_pct_after_0_2_cost"] for x in missed),
    "rejected_avg_net_4h_pct":safe_avg([x["net_4h_pct_after_0_2_cost"] for x in rejected]),
    "accepted_avg_net_4h_pct":safe_avg([x["net_4h_pct_after_0_2_cost"] for x in accepted]),
    "all_core":strategy_metrics(decisions),
    "accepted_only":strategy_metrics(accepted),
    "rejected_only":strategy_metrics(rejected),
    "by_rule":by_rule,
}
payload={
    "generated_at":NOW.isoformat().replace("+00:00","Z"),
    "cost_pct":0.2,
    "prospective_artifacts_found":len(artifacts),
    "summary":summary,
    "decisions":decisions,
}
with open("core-timesfm-mature-batch.json","w",encoding="utf-8") as f:
    json.dump(payload,f,indent=2,allow_nan=False)
print(json.dumps(summary,indent=2,allow_nan=False))
for x in decisions:
    print(json.dumps(x,allow_nan=False))
