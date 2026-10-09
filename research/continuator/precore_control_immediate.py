import json, os, re, statistics, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

BASE="https://data-api.binance.vision"
REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
TOKEN=os.environ.get("GITHUB_TOKEN","")
COST=0.002
ISSUE_TITLE="[RESEARCH] CORE Precursor Control"
V42_THRESHOLDS=[
 {"i":0.904010256302157,"c":0.30262335308700017,"e":0.0333071863419859},
 {"i":0.7912647052581232,"c":0.36672756172128707,"e":0.029510140018270917},
 {"i":1.6626658194027173,"c":0.43305908219072103,"e":0.019614079751271593},
]

def req_json(url,headers=None,method="GET",body=None):
    h={"User-Agent":"proypers25-precore-control/1.0",**(headers or {})}
    data=None if body is None else json.dumps(body).encode()
    r=urllib.request.Request(url,headers=h,method=method,data=data)
    with urllib.request.urlopen(r,timeout=30) as x:
        raw=x.read(); return json.loads(raw.decode()) if raw else {}

def github(path,method="GET",body=None):
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
    try:return {"symbol":m.group(1),"signal_ms":int(datetime.fromisoformat(issue["created_at"].replace("Z","+00:00")).timestamp()*1000),"issue":issue["number"]}
    except:return None

def avg(v):return sum(v)/len(v) if v else 0
def ret(a,b):return b/a-1 if a>0 else 0
def qsum(rows,i,n):return sum(float(rows[k][7]) for k in range(max(0,i-n+1),i+1))

def feat(sym,btc,dm):
    sb=[x for x in sym if int(x[0])<=dm]; bb=[x for x in btc if int(x[0])<=dm]
    if len(sb)<290 or len(bb)<50:return None
    i=len(sb)-1; bi=len(bb)-1; c=float(sb[i][4])
    r15=ret(float(sb[i-3][4]),c); r30=ret(float(sb[i-6][4]),c); r60=ret(float(sb[i-12][4]),c); r240=ret(float(sb[i-48][4]),c); r24=ret(float(sb[i-288][4]),c)
    base=avg([float(x[7]) for x in sb[i-72:i-12]])*12
    ph60=max(float(x[2]) for x in sb[i-12:i]); ph240=max(float(x[2]) for x in sb[i-48:i])
    vol15=qsum(sb,i,3)/(base/4) if base else 1; vol30=qsum(sb,i,6)/(base/2) if base else 1
    import math
    ta=float(sb[i][8])/max(1,avg([float(x[8]) for x in sb[i-12:i]]))
    br60=c/ph60-1 if ph60 else 0; br240=c/ph240-1 if ph240 else 0
    btc60=ret(float(bb[bi-12][4]),float(bb[bi][4])); btc240=ret(float(bb[bi-48][4]),float(bb[bi][4]))
    rs60=r60-btc60; rs240=r240-btc240
    ign=0.9*math.log(max(.2,vol15))+.65*math.log(max(.2,ta))+.65*r15+.35*br60
    con=1.2*br60+.65*rs60+.35*math.log(max(.2,vol30))-.8*max(0,r24-.10)-.5*max(0,r60-.06)
    ext=1.15*rs60+.75*rs240+.35*r30+.25*br240-.45*max(0,r24-.12)
    fresh=r24<.10 and r60<.10 and r15<.06
    pc=sum(1 for th in V42_THRESHOLDS if ign>=th["i"] and con>=th["c"] and ext>=th["e"]) if fresh else 0
    return {"price":c,"ignition":ign,"confirm":con,"extension":ext,"fresh":fresh,"passCount":pc}

def trigger_rule(f,rule):
    if not f:return False
    if rule=="PASS1":return f["passCount"]>=1
    if rule=="PASS2":return f["passCount"]>=2
    return bool(f["fresh"] and f["ignition"]>0 and f["confirm"]>0 and f["extension"]>0)

def outcome(sym,dm,end,entry):
    fut=[x for x in sym if int(x[0])>=dm and int(x[0])<=end]
    if not fut:return None
    highs=[float(x[2]) for x in fut]; lows=[float(x[3]) for x in fut]; closes=[float(x[4]) for x in fut]
    cont=False
    for h,l in zip(highs,lows):
      if h/entry-1>=.03 and l/entry-1<=-.01:break
      if h/entry-1>=.03:cont=True;break
      if l/entry-1<=-.01:break
    return {"net":closes[-1]/entry-1-COST,"mfe":max(highs)/entry-1,"mae":min(lows)/entry-1,"cont":cont}

def metrics(rows):
    if not rows:return {"n":0}
    vals=[r["net"] for r in rows]; wins=[x for x in vals if x>0]; losses=[x for x in vals if x<0]
    return {"n":len(rows),
      "avg_net":sum(vals)/len(vals),"wr":sum(x>0 for x in vals)/len(vals),
      "pf":sum(wins)/abs(sum(losses)) if losses else (999 if wins else 0),
      "cont":sum(r["cont"] for r in rows)/len(rows),
      "avg_mfe":sum(r["mfe"] for r in rows)/len(rows),"avg_mae":sum(r["mae"] for r in rows)/len(rows)}

issues=[]
for page in range(1,6):
  b=github(f"/issues?state=all&per_page=100&page={page}&sort=created&direction=desc")
  if not isinstance(b,list) or not b:break
  issues+=b
signals=[x for x in (parse_signal(i) for i in issues) if x]
signals=sorted(signals,key=lambda x:x["signal_ms"])
now_ms=int(datetime.now(timezone.utc).timestamp()*1000)
mature=[s for s in signals if now_ms>=s["signal_ms"]+4*3600*1000][-60:]
pool=sorted(set(s["symbol"] for s in signals))

tasks=[]
for idx,s in enumerate(mature):
  controls=[]
  for j in range(1,len(pool)+1):
    sym=pool[(pool.index(s["symbol"])+j*7)%len(pool)]
    near=any(x["symbol"]==sym and abs(x["signal_ms"]-s["signal_ms"])<2*3600*1000 for x in signals)
    if sym!=s["symbol"] and not near and sym not in controls:controls.append(sym)
    if len(controls)>=3:break
  tasks.append((s,s["symbol"],True))
  for sym in controls:tasks.append((s,sym,False))

rows=[];errors=[]
def one(task):
  s,sym,is_target=task; dm=s["signal_ms"]-60*60000; end=s["signal_ms"]+4*3600*1000; start=dm-25*3600*1000
  try:
    sb=klines(sym,start,end); bb=klines("BTCUSDT",start,end); f=feat(sb,bb,dm)
    if not f:return None,None
    o=outcome(sb,dm,end,f["price"])
    if not o:return None,None
    return {"target":is_target,"anchor_issue":s["issue"],"symbol":sym,
            "PASS1":trigger_rule(f,"PASS1"),"PASS2":trigger_rule(f,"PASS2"),
            "ALL_PARTS_POSITIVE":trigger_rule(f,"ALL_PARTS_POSITIVE"),**o},None
  except Exception as e:return None,{"symbol":sym,"issue":s["issue"],"error":str(e)}

with ThreadPoolExecutor(max_workers=16) as ex:
  fs=[ex.submit(one,t) for t in tasks]
  for fu in as_completed(fs):
    row,err=fu.result()
    if row:rows.append(row)
    if err:errors.append(err)

target=[r for r in rows if r["target"]]; control=[r for r in rows if not r["target"]]
report={"generated_at":datetime.now(timezone.utc).isoformat(),"research_only":True,"no_order_created":True,
        "events":len(mature),"errors":errors,"target_all":metrics(target),"control_all":metrics(control),"rules":{}}
def pct(x):return "—" if x is None else f"{100*x:.3f}%"
lines=["# CORE Precursor Control","",f"Generated: {report['generated_at']}",
f"Anchors: {len(mature)} · target rows: {len(target)} · matched control rows: {len(control)} · errors: {len(errors)}",
"Rules frozen before this control test: PASS1, PASS2, ALL_PARTS_POSITIVE at -60m.","",
"| rule | target triggers | control triggers | target trigger rate | control trigger rate | target net | control net | target PF | control PF | target cont | control cont |",
"|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
for rule in ["PASS1","PASS2","ALL_PARTS_POSITIVE"]:
  tt=[r for r in target if r[rule]]; ct=[r for r in control if r[rule]]
  tm=metrics(tt); cm=metrics(ct)
  report["rules"][rule]={"target_trigger_rate":len(tt)/len(target) if target else 0,
                          "control_trigger_rate":len(ct)/len(control) if control else 0,
                          "target_triggered":tm,"control_triggered":cm}
  lines.append(f"| {rule} | {len(tt)} | {len(ct)} | {pct(len(tt)/len(target) if target else 0)} | {pct(len(ct)/len(control) if control else 0)} | {pct(tm.get('avg_net'))} | {pct(cm.get('avg_net'))} | {tm.get('pf','—') if tm.get('n',0) else '—'} | {cm.get('pf','—') if cm.get('n',0) else '—'} | {pct(tm.get('cont'))} | {pct(cm.get('cont'))} |")
lines+=["","Research only; matched controls are other historically active CORE symbols with no CORE signal within ±2h of the anchor."]
open("precore-control.json","w").write(json.dumps(report,indent=2));open("precore-control.md","w").write("\n".join(lines));print("\n".join(lines))
if TOKEN:
  exi=github("/issues?state=open&per_page=100"); found=next((i for i in exi if i.get("title")==ISSUE_TITLE),None); body="\n".join(lines)
  if found:github(f"/issues/{found['number']}","PATCH",{"body":body})
  else:github("/issues","POST",{"title":ISSUE_TITLE,"body":body})
