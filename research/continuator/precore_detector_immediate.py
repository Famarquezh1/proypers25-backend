import json, os, re, statistics, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

BASE="https://data-api.binance.vision"
REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
TOKEN=os.environ.get("GITHUB_TOKEN","")
COST=0.002
OFFSETS=[60,30,20]
RULES=["PASS1","PASS2","ALL_PARTS_POSITIVE"]
V42_THRESHOLDS=[
 {"i":0.904010256302157,"c":0.30262335308700017,"e":0.0333071863419859},
 {"i":0.7912647052581232,"c":0.36672756172128707,"e":0.029510140018270917},
 {"i":1.6626658194027173,"c":0.43305908219072103,"e":0.019614079751271593},
]
ISSUE_TITLE="[RESEARCH] CORE Precursor Immediate"

def req_json(url, headers=None, method="GET", body=None):
    h={"User-Agent":"proypers25-precore/1.0", **(headers or {})}
    data=None if body is None else json.dumps(body).encode()
    r=urllib.request.Request(url,headers=h,method=method,data=data)
    with urllib.request.urlopen(r,timeout=30) as x:
        raw=x.read()
        return json.loads(raw.decode()) if raw else {}

def github(path, method="GET", body=None):
    return req_json("https://api.github.com/repos/"+REPO+path,{
      "Authorization":f"Bearer {TOKEN}","Accept":"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},method,body)

def klines(symbol,start,end):
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"5m","startTime":start,"endTime":end,"limit":1000})
    return req_json(f"{BASE}/api/v3/klines?{q}")

def parse_signal(issue):
    title=str(issue.get("title") or ""); body=str(issue.get("body") or "")
    m=re.match(r"^\[SPOT SIGNAL\] ([A-Z0-9]+USDT)\b",title)
    if not m or "V4.2" not in body or "V10_HUNTER" in body:return None
    pm=re.search(r"(?mi)^- Precio:\s*([0-9.eE+-]+)",body)
    if not pm:return None
    try:
      return {"issue":issue["number"],"symbol":m.group(1),"signal_price":float(pm.group(1)),
              "signal_ms":int(datetime.fromisoformat(issue["created_at"].replace("Z","+00:00")).timestamp()*1000)}
    except:return None

def avg(v): return sum(v)/len(v) if v else 0
def ret(a,b): return b/a-1 if a>0 else 0
def qsum(rows,i,n): return sum(float(rows[k][7]) for k in range(max(0,i-n+1),i+1))

def features(sym,btc,decision_ms):
    sb=[x for x in sym if int(x[0])<=decision_ms]
    bb=[x for x in btc if int(x[0])<=decision_ms]
    if len(sb)<290 or len(bb)<50:return None
    i=len(sb)-1; bi=len(bb)-1
    c=float(sb[i][4])
    r15=ret(float(sb[i-3][4]),c); r30=ret(float(sb[i-6][4]),c); r60=ret(float(sb[i-12][4]),c)
    r240=ret(float(sb[i-48][4]),c); r24=ret(float(sb[i-288][4]),c)
    base=avg([float(x[7]) for x in sb[i-72:i-12]])*12
    ph60=max(float(x[2]) for x in sb[i-12:i]); ph240=max(float(x[2]) for x in sb[i-48:i])
    vol15=qsum(sb,i,3)/(base/4) if base>0 else 1
    vol30=qsum(sb,i,6)/(base/2) if base>0 else 1
    trade=float(sb[i][8]); trade_base=avg([float(x[8]) for x in sb[i-12:i]])
    tradeAccel=trade/max(1,trade_base)
    breakout60=c/ph60-1 if ph60>0 else 0; breakout240=c/ph240-1 if ph240>0 else 0
    btc60=ret(float(bb[bi-12][4]),float(bb[bi][4])); btc240=ret(float(bb[bi-48][4]),float(bb[bi][4]))
    rs60=r60-btc60; rs240=r240-btc240
    import math
    ignition=0.9*math.log(max(0.2,vol15))+0.65*math.log(max(0.2,tradeAccel))+0.65*r15+0.35*breakout60
    confirm=1.2*breakout60+0.65*rs60+0.35*math.log(max(0.2,vol30))-0.8*max(0,r24-0.10)-0.5*max(0,r60-0.06)
    extension=1.15*rs60+0.75*rs240+0.35*r30+0.25*breakout240-0.45*max(0,r24-0.12)
    fresh=r24<0.10 and r60<0.10 and r15<0.06
    pc=sum(1 for th in V42_THRESHOLDS if ignition>=th["i"] and confirm>=th["c"] and extension>=th["e"]) if fresh else 0
    return {"price":c,"ignition":ignition,"confirm":confirm,"extension":extension,"passCount":pc,"fresh":fresh,
            "r15":r15,"r60":r60,"r24":r24}

def rule_ok(f,rule):
    if not f:return False
    if rule=="PASS1":return f["passCount"]>=1
    if rule=="PASS2":return f["passCount"]>=2
    if rule=="ALL_PARTS_POSITIVE":return f["fresh"] and f["ignition"]>0 and f["confirm"]>0 and f["extension"]>0
    return False

def first_hit(highs,lows,entry):
    for h,l in zip(highs,lows):
      up=h/entry-1; dn=l/entry-1
      if up>=0.03 and dn<=-0.01:return None
      if up>=0.03:return True
      if dn<=-0.01:return False
    return False

def metrics(rows):
    if not rows:return {"n":0}
    vals=[r["net"] for r in rows]; wins=[x for x in vals if x>0]; losses=[x for x in vals if x<0]
    pf=sum(wins)/abs(sum(losses)) if losses else (999 if wins else 0)
    return {"n":len(rows),"avg_net":sum(vals)/len(vals),"median_net":statistics.median(vals),
            "wr":sum(x>0 for x in vals)/len(vals),"pf":pf,
            "cont":sum(r["cont"] is True for r in rows)/len(rows),
            "mfe":sum(r["mfe"] for r in rows)/len(rows),"mae":sum(r["mae"] for r in rows)/len(rows)}

issues=[]
for page in range(1,6):
    b=github(f"/issues?state=all&per_page=100&page={page}&sort=created&direction=desc")
    if not isinstance(b,list) or not b:break
    issues+=b
signals=[x for x in (parse_signal(i) for i in issues) if x]
signals=sorted(signals,key=lambda x:x["signal_ms"])[-160:]
now_ms=int(datetime.now(timezone.utc).timestamp()*1000)
btc_cache={}
rows=[]; errors=[]

def eval_one(s):
    if now_ms<s["signal_ms"]+4*3600*1000:return [],None
    start=s["signal_ms"]-(25*3600+70*60)*1000; end=s["signal_ms"]+4*3600*1000
    try:
      sym=klines(s["symbol"],start,end)
      btc=klines("BTCUSDT",start,end)
    except Exception as e:return [],{"issue":s["issue"],"symbol":s["symbol"],"error":str(e)}
    out=[]
    for off in OFFSETS:
      dm=s["signal_ms"]-off*60000
      f=features(sym,btc,dm)
      if not f:continue
      fut=[x for x in sym if int(x[0])>=dm and int(x[0])<=s["signal_ms"]+4*3600*1000]
      if not fut:continue
      entry=f["price"]; highs=[float(x[2]) for x in fut]; lows=[float(x[3]) for x in fut]; closes=[float(x[4]) for x in fut]
      out.append({**s,"offset":off,"f":f,"net":closes[-1]/entry-1-COST,
                  "mfe":max(highs)/entry-1,"mae":min(lows)/entry-1,"cont":first_hit(highs,lows,entry)})
    return out,None

with ThreadPoolExecutor(max_workers=12) as ex:
    fs=[ex.submit(eval_one,s) for s in signals]
    for f in as_completed(fs):
      rr,err=f.result()
      rows+=rr
      if err:errors.append(err)
rows.sort(key=lambda x:x["signal_ms"])

report={"generated_at":datetime.now(timezone.utc).isoformat(),"research_only":True,"no_order_created":True,
        "signals":len(signals),"errors":errors,"protocol":"fixed V4.2 precursor rules; chronological 70/30 split; holdout untouched by fitting","offsets":{}}
for off in OFFSETS:
    rr=[x for x in rows if x["offset"]==off]
    cut=int(len(rr)*0.7)
    dev,hold=rr[:cut],rr[cut:]
    report["offsets"][str(off)]={"baseline":{"dev":metrics(dev),"holdout":metrics(hold)},"rules":{}}
    for rule in RULES:
      report["offsets"][str(off)]["rules"][rule]={"dev":metrics([x for x in dev if rule_ok(x["f"],rule)]),
                                                   "holdout":metrics([x for x in hold if rule_ok(x["f"],rule)])}

# Select exactly one rule on development, then report its holdout.
cands=[]
for off in OFFSETS:
  for rule in RULES:
    m=report["offsets"][str(off)]["rules"][rule]["dev"]
    if m.get("n",0)>=12:cands.append((m["avg_net"],m["pf"],off,rule,m))
cands.sort(reverse=True)
chosen=cands[0] if cands else None
if chosen:
  _,_,off,rule,devm=chosen
  report["chosen_on_development"]={"offset":off,"rule":rule,"development":devm,
                                   "holdout":report["offsets"][str(off)]["rules"][rule]["holdout"]}
else: report["chosen_on_development"]=None

def pct(x):return "—" if x is None else f"{100*x:.3f}%"
lines=["# CORE Precursor Immediate","",f"Generated: {report['generated_at']}",f"Signals parsed: {len(signals)} · errors: {len(errors)} · cost: {100*COST:.2f}%",
"Rules were fixed before holdout: PASS1, PASS2, ALL_PARTS_POSITIVE using existing V4.2 features.","",
"| offset | rule | holdout n | net avg | WR | PF | continuator | MFE | MAE |","|---:|---|---:|---:|---:|---:|---:|---:|---:|"]
for off in OFFSETS:
  for rule in RULES:
    m=report["offsets"][str(off)]["rules"][rule]["holdout"]
    lines.append(f"| -{off}m | {rule} | {m.get('n',0)} | {pct(m.get('avg_net'))} | {pct(m.get('wr'))} | {m.get('pf','—') if m.get('n',0) else '—'} | {pct(m.get('cont'))} | {pct(m.get('mfe'))} | {pct(m.get('mae'))} |")
if chosen:
  h=report["chosen_on_development"]["holdout"]
  lines+=["",f"Chosen on development only: -{chosen[2]}m / {chosen[3]}",
          f"Unseen holdout: n={h.get('n',0)} · net={pct(h.get('avg_net'))} · WR={pct(h.get('wr'))} · PF={h.get('pf','—')} · continuator={pct(h.get('cont'))}."]
lines+=["","Research/shadow only. No Binance orders."]
open("precore-immediate.json","w").write(json.dumps(report,indent=2))
open("precore-immediate.md","w").write("\n".join(lines))
print("\n".join(lines))
if TOKEN:
  existing=github("/issues?state=open&per_page=100")
  found=next((i for i in existing if i.get("title")==ISSUE_TITLE),None)
  body="\n".join(lines)
  if found:github(f"/issues/{found['number']}","PATCH",{"body":body})
  else:github("/issues","POST",{"title":ISSUE_TITLE,"body":body})
