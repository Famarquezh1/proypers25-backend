import json, os, re, statistics, urllib.parse, urllib.request
from datetime import datetime, timezone

BASE="https://data-api.binance.vision"
REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
TOKEN=os.environ.get("GITHUB_TOKEN","")
OFFSETS=[0,5,10,20,30,60]
COST=0.002
MAX_PAGES=5
OUT_JSON="backward-entry-immediate.json"
OUT_MD="backward-entry-immediate.md"
ISSUE_TITLE="[RESEARCH] CORE Backward Entry Immediate"

def req_json(url, headers=None, method="GET", body=None):
    h={"User-Agent":"proypers25-backward-entry/1.0", **(headers or {})}
    data=None if body is None else json.dumps(body).encode()
    r=urllib.request.Request(url,headers=h,method=method,data=data)
    with urllib.request.urlopen(r,timeout=30) as x:
        raw=x.read()
        return json.loads(raw.decode()) if raw else {}

def github(path, method="GET", body=None):
    return req_json("https://api.github.com/repos/"+REPO+path,{
        "Authorization":f"Bearer {TOKEN}",
        "Accept":"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28",
        "Content-Type":"application/json"
    },method,body)

def klines(symbol,start,end):
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"1m","startTime":start,"endTime":end,"limit":1000})
    return req_json(f"{BASE}/api/v3/klines?{q}")

def parse_signal(issue):
    title=str(issue.get("title") or "")
    body=str(issue.get("body") or "")
    m=re.match(r"^\[SPOT SIGNAL\] ([A-Z0-9]+USDT)\b",title)
    if not m: return None
    if "V4.2" not in body or "V10_HUNTER" in body: return None
    pm=re.search(r"(?mi)^- Precio:\s*([0-9.eE+-]+)",body)
    if not pm: return None
    try: price=float(pm.group(1))
    except: return None
    try: ts=int(datetime.fromisoformat(issue["created_at"].replace("Z","+00:00")).timestamp()*1000)
    except: return None
    return {"issue":issue.get("number"),"symbol":m.group(1),"signal_price":price,"signal_ms":ts,"created_at":issue.get("created_at")}

def first_hit(highs,lows,entry):
    for h,l in zip(highs,lows):
        up=h/entry-1
        dn=l/entry-1
        if up>=0.03 and dn<=-0.01:
            return None
        if up>=0.03: return True
        if dn<=-0.01: return False
    return False

def metrics(rows):
    if not rows:return {"n":0}
    vals=[r["net_terminal"] for r in rows]
    wins=[v for v in vals if v>0]
    losses=[v for v in vals if v<0]
    pf=(sum(wins)/abs(sum(losses))) if losses else (999.0 if wins else 0.0)
    return {
      "n":len(rows),
      "avg_net_terminal":sum(vals)/len(vals),
      "median_net_terminal":statistics.median(vals),
      "win_rate":sum(v>0 for v in vals)/len(vals),
      "profit_factor":pf,
      "continuator_rate":sum(r["continuator"] is True for r in rows)/len(rows),
      "avg_mfe":sum(r["mfe"] for r in rows)/len(rows),
      "avg_mae":sum(r["mae"] for r in rows)/len(rows),
      "avg_entry_advantage_vs_signal":sum(r["entry_advantage_vs_signal"] for r in rows)/len(rows)
    }

issues=[]
for page in range(1,MAX_PAGES+1):
    batch=github(f"/issues?state=all&per_page=100&page={page}&sort=created&direction=desc")
    if not isinstance(batch,list) or not batch: break
    issues.extend(batch)

signals=[x for x in (parse_signal(i) for i in issues) if x]
signals=sorted(signals,key=lambda x:x["signal_ms"])
rows_by_offset={o:[] for o in OFFSETS}
errors=[]
now_ms=int(datetime.now(timezone.utc).timestamp()*1000)
for s in signals:
    if now_ms < s["signal_ms"]+4*3600*1000: continue
    try:
        ks=klines(s["symbol"],s["signal_ms"]-62*60000,s["signal_ms"]+4*3600*1000)
    except Exception as e:
        errors.append({"issue":s["issue"],"symbol":s["symbol"],"error":str(e)}); continue
    if not ks: continue
    by_open={int(k[0]):k for k in ks}
    signal_bucket=(s["signal_ms"]//60000)*60000
    end=s["signal_ms"]+4*3600*1000
    for off in OFFSETS:
        target=signal_bucket-off*60000
        candidates=[k for k in ks if int(k[0])<=target]
        if not candidates: continue
        k0=candidates[-1]
        entry=float(k0[4])
        fut=[k for k in ks if int(k[0])>=int(k0[0]) and int(k[0])<=end]
        if len(fut)<5: continue
        highs=[float(k[2]) for k in fut]; lows=[float(k[3]) for k in fut]; closes=[float(k[4]) for k in fut]
        rows_by_offset[off].append({
          **s,"offset_min":off,"entry":entry,
          "entry_advantage_vs_signal":s["signal_price"]/entry-1,
          "net_terminal":closes[-1]/entry-1-COST,
          "mfe":max(highs)/entry-1,
          "mae":min(lows)/entry-1,
          "continuator":first_hit(highs,lows,entry)
        })

report={"research_only":True,"no_order_created":True,"generated_at":datetime.now(timezone.utc).isoformat(),
        "rule":"fixed backward offsets only; no threshold search","cost":COST,"signals_found":len(signals),"errors":errors,"offsets":{}}
for off in OFFSETS:
    rows=rows_by_offset[off]
    cut=max(1,int(len(rows)*0.7)) if rows else 0
    report["offsets"][str(off)]={"all":metrics(rows),"development":metrics(rows[:cut]),"holdout":metrics(rows[cut:])}

best_holdout=None
for off in OFFSETS:
    m=report["offsets"][str(off)]["holdout"]
    if m.get("n",0)<8: continue
    if best_holdout is None or m["avg_net_terminal"]>best_holdout[1]["avg_net_terminal"]:
        best_holdout=(off,m)
report["best_holdout_offset_min"]=best_holdout[0] if best_holdout else None

def pct(x):
    return "—" if x is None else f"{100*x:.3f}%"
lines=[
"# CORE backward-entry immediate study","",
f"Generated: {report['generated_at']}",
f"Signals parsed: {report['signals_found']} · errors: {len(errors)} · cost: {100*COST:.2f}%",
"Protocol: fixed offsets 0/5/10/20/30/60m before the original signal; chronological 70/30 split; no threshold optimization.","",
"| offset | holdout n | net avg | WR | PF | continuator | MFE | MAE | entry advantage vs signal |",
"|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
]
for off in OFFSETS:
    m=report["offsets"][str(off)]["holdout"]
    lines.append(f"| -{off}m | {m.get('n',0)} | {pct(m.get('avg_net_terminal'))} | {pct(m.get('win_rate'))} | {m.get('profit_factor','—') if m.get('n',0) else '—'} | {pct(m.get('continuator_rate'))} | {pct(m.get('avg_mfe'))} | {pct(m.get('avg_mae'))} | {pct(m.get('avg_entry_advantage_vs_signal'))} |")
lines+=["",f"Best fixed holdout offset by net return: {('-'+str(best_holdout[0])+'m') if best_holdout else 'insufficient holdout coverage'}",
"","Research only. This does not create orders or modify production."]
open(OUT_JSON,"w").write(json.dumps(report,indent=2))
open(OUT_MD,"w").write("\n".join(lines))
print("\n".join(lines))

if TOKEN:
    existing=github("/issues?state=open&per_page=100")
    found=next((i for i in existing if i.get("title")==ISSUE_TITLE),None)
    body="\n".join(lines)
    if found: github(f"/issues/{found['number']}","PATCH",{"body":body})
    else: github("/issues","POST",{"title":ISSUE_TITLE,"body":body})
