#!/usr/bin/env python3
import csv, io, json, math, os, statistics, time, urllib.request, zipfile
from datetime import datetime, timedelta, timezone

SYMBOLS=os.getenv("DA_SYMBOLS","SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,SUIUSDT,LINKUSDT,NEARUSDT,AVAXUSDT,ARBUSDT,ENAUSDT,APTUSDT,OPUSDT,INJUSDT,WLDUSDT,SEIUSDT,PEPEUSDT").split(",")
START=datetime.fromisoformat(os.getenv("DA_START","2026-08-01T00:00:00+00:00"))
END=datetime.fromisoformat(os.getenv("DA_END","2026-09-01T00:00:00+00:00"))
COST=0.004
TP=0.03
SL=-0.01
HORIZON_MIN=240
BASE="https://data.binance.vision/data"

def fetch_zip(url, retries=3):
    last=None
    for i in range(retries):
        try:
            req=urllib.request.Request(url,headers={"User-Agent":"proypers25-derivatives-archive/1.0"})
            with urllib.request.urlopen(req,timeout=30) as r:
                data=r.read()
            z=zipfile.ZipFile(io.BytesIO(data))
            name=z.namelist()[0]
            return z.read(name).decode("utf-8-sig",errors="replace")
        except Exception as e:
            last=e
            time.sleep(.25*(i+1))
    raise last

def fnum(x, default=None):
    try:
        v=float(x)
        return v if math.isfinite(v) else default
    except Exception:
        return default

def load_metrics(symbol, day):
    ds=day.strftime("%Y-%m-%d")
    url=f"{BASE}/futures/um/daily/metrics/{symbol}/{symbol}-metrics-{ds}.zip"
    text=fetch_zip(url)
    rows=[]
    for r in csv.DictReader(io.StringIO(text)):
        ts=r.get("create_time") or r.get("timestamp")
        try:
            t=datetime.fromisoformat(ts.replace("Z","+00:00")).replace(tzinfo=timezone.utc) if "T" in ts else datetime.fromisoformat(ts).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        rows.append({
            "t":int(t.timestamp()*1000),
            "oi":fnum(r.get("sum_open_interest")),
            "oi_value":fnum(r.get("sum_open_interest_value")),
            "top_count":fnum(r.get("count_toptrader_long_short_ratio")),
            "top_sum":fnum(r.get("sum_toptrader_long_short_ratio")),
            "crowd":fnum(r.get("count_long_short_ratio")),
            "taker":fnum(r.get("sum_taker_long_short_vol_ratio")),
        })
    return [r for r in rows if r["oi"] and r["taker"]]

def load_spot_1m(symbol, day):
    ds=day.strftime("%Y-%m-%d")
    url=f"{BASE}/spot/daily/klines/{symbol}/1m/{symbol}-1m-{ds}.zip"
    text=fetch_zip(url)
    out=[]
    for row in csv.reader(io.StringIO(text)):
        if not row or not row[0].isdigit(): continue
        # Binance Vision timestamps may be ms or microseconds in newer archives.
        raw=int(row[0]); t=raw//1000 if raw>10**14 else raw
        out.append({"t":t,"o":float(row[1]),"h":float(row[2]),"l":float(row[3]),"c":float(row[4]),"qv":float(row[7])})
    return out

def ret(a,b):
    return (b/a-1.0) if a and b and a>0 else None

def med(a):
    x=sorted(v for v in a if v is not None and math.isfinite(v))
    if not x:return None
    return x[len(x)//2]

def qtile(a,q):
    x=sorted(v for v in a if v is not None and math.isfinite(v))
    if not x:return None
    return x[min(len(x)-1,max(0,int(q*(len(x)-1))))]

def outcome(spot, idx):
    entry=spot[idx]["c"]
    end=min(len(spot)-1,idx+HORIZON_MIN)
    first_tp=first_sl=None
    mfe=-999; mae=999
    for j in range(idx+1,end+1):
        hi=spot[j]["h"]/entry-1; lo=spot[j]["l"]/entry-1
        mfe=max(mfe,hi);mae=min(mae,lo)
        d=j-idx
        if first_tp is None and hi>=TP:first_tp=d
        if first_sl is None and lo<=SL:first_sl=d
    cont=first_tp is not None and (first_sl is None or first_tp<first_sl)
    if first_tp is not None and first_sl is not None and first_tp==first_sl:
        payoff=SL-COST
    elif cont: payoff=TP-COST
    elif first_sl is not None and (first_tp is None or first_sl<first_tp): payoff=SL-COST
    else: payoff=max(SL,min(TP,spot[end]["c"]/entry-1))-COST
    return {"continuator":cont,"payoff":payoff,"mfe":mfe,"mae":mae,"hit5":mfe>=.05,"hit10":mfe>=.10}

def build_symbol(symbol):
    metrics=[];spot=[]
    d=START
    while d<END:
        try:
            metrics.extend(load_metrics(symbol,d))
            # Include next 4h outcome beyond END day boundary by loading one extra day later globally below.
            spot.extend(load_spot_1m(symbol,d))
        except Exception as e:
            print(f"SKIP_DAY {symbol} {d.date()} {type(e).__name__}:{e}",flush=True)
        d+=timedelta(days=1)
    # add one day after END for horizon
    try: spot.extend(load_spot_1m(symbol,END))
    except Exception as e: print(f"SKIP_TAIL {symbol} {type(e).__name__}:{e}",flush=True)
    metrics.sort(key=lambda x:x["t"]);spot.sort(key=lambda x:x["t"])
    sidx={r["t"]:i for i,r in enumerate(spot)}
    rows=[]
    for i in range(12,len(metrics)):
        m=metrics[i]; t=m["t"]
        # metrics are 5m buckets; use only exact timestamp spot close at/just before bucket.
        idx=sidx.get(t)
        if idx is None or idx+HORIZON_MIN>=len(spot):continue
        p5=metrics[i-1];p15=metrics[i-3];p60=metrics[i-12]
        if not all(x.get("oi") for x in [p5,p15,p60]):continue
        taker_hist=[x["taker"] for x in metrics[max(0,i-12):i] if x["taker"]]
        oi5=ret(p5["oi"],m["oi"]);oi15=ret(p15["oi"],m["oi"]);oi60=ret(p60["oi"],m["oi"])
        taker_med=med(taker_hist)
        feats={
          "oi5":oi5,"oi15":oi15,"oi60":oi60,
          "taker":m["taker"],"taker_accel":(m["taker"]/taker_med-1) if taker_med else None,
          "top_count_delta15":ret(p15["top_count"],m["top_count"]) if p15["top_count"] and m["top_count"] else None,
          "top_sum_delta15":ret(p15["top_sum"],m["top_sum"]) if p15["top_sum"] and m["top_sum"] else None,
          "crowd_delta15":ret(p15["crowd"],m["crowd"]) if p15["crowd"] and m["crowd"] else None,
          "oi_value5":ret(p5["oi_value"],m["oi_value"]) if p5["oi_value"] and m["oi_value"] else None,
        }
        if any(feats[k] is None for k in ["oi5","oi15","taker","taker_accel"]):continue
        o=outcome(spot,idx)
        rows.append({"symbol":symbol,"t":t,**feats,**o})
    return rows

def summarize(a):
    if not a:return {"n":0}
    return {
      "n":len(a),
      "continuator_rate":sum(x["continuator"] for x in a)/len(a),
      "avg_payoff":sum(x["payoff"] for x in a)/len(a),
      "hit5":sum(x["hit5"] for x in a)/len(a),
      "hit10":sum(x["hit10"] for x in a)/len(a),
    }

def main():
    allrows=[]
    for s in SYMBOLS:
        try:
            r=build_symbol(s);allrows.extend(r);print(f"DATA {s} rows={len(r)}",flush=True)
        except Exception as e:print(f"SKIP_SYMBOL {s} {type(e).__name__}:{e}",flush=True)
    allrows.sort(key=lambda x:x["t"])
    if len(allrows)<1000: raise RuntimeError(f"insufficient archive rows {len(allrows)}")
    # Reduce autocorrelation: at most one event per symbol per 30m is enforced after scoring.
    a=int(len(allrows)*.6);b=int(len(allrows)*.8)
    train=allrows[:a];val=allrows[a:b];hold=allrows[b:]
    feats=["oi5","oi15","oi60","taker","taker_accel","top_count_delta15","top_sum_delta15","crowd_delta15","oi_value5"]
    thresholds={}
    for f in feats:
        vals=[x[f] for x in train if x.get(f) is not None]
        thresholds[f]={"q80":qtile(vals,.80),"q90":qtile(vals,.90),"q20":qtile(vals,.20),"q10":qtile(vals,.10)}
    rules=[]
    # single extreme derivatives states
    for f in feats:
        for q,op in [("q80","hi"),("q90","hi"),("q20","lo"),("q10","lo")]:
            th=thresholds[f][q]
            if th is not None: rules.append({"id":f+"_"+q,"terms":[(f,op,th)]})
    # mechanistic combinations: OI expansion + aggressive taker demand; OI expansion + positioning shift
    for oq in ["q80","q90"]:
      for tq in ["q80","q90"]:
        rules.append({"id":f"OI15_{oq}_TAKERACC_{tq}","terms":[("oi15","hi",thresholds["oi15"][oq]),("taker_accel","hi",thresholds["taker_accel"][tq])]})
        rules.append({"id":f"OI5_{oq}_TAKER_{tq}","terms":[("oi5","hi",thresholds["oi5"][oq]),("taker","hi",thresholds["taker"][tq])]})
      for pq in ["q80","q90"]:
        if thresholds["top_sum_delta15"][pq] is not None:
          rules.append({"id":f"OI15_{oq}_TOPSUM_{pq}","terms":[("oi15","hi",thresholds["oi15"][oq]),("top_sum_delta15","hi",thresholds["top_sum_delta15"][pq])]})
    def match(x,rule):
        for f,op,th in rule["terms"]:
            v=x.get(f)
            if v is None:return False
            if op=="hi" and v<th:return False
            if op=="lo" and v>=th:return False
        return True
    def select(block,rule):
        cand=[x for x in block if match(x,rule)]
        out=[];last={}
        for x in cand:
            prev=last.get(x["symbol"],-10**18)
            if x["t"]-prev<30*60*1000:continue
            out.append(x);last[x["symbol"]]=x["t"]
        return out
    bv=summarize(val);bh=summarize(hold)
    scored=[]
    for rule in rules:
        sv=summarize(select(val,rule))
        eligible=sv.get("n",0)>=20 and sv.get("avg_payoff",-9)>0 and sv.get("continuator_rate",0)>=bv["continuator_rate"]+.05
        score=(sv.get("avg_payoff",-9)+2*(sv.get("continuator_rate",0)-bv["continuator_rate"])) if eligible else -999
        scored.append({**rule,"validation":sv,"eligible":eligible,"score":score})
    scored.sort(key=lambda x:x["score"],reverse=True)
    selected=next((x for x in scored if x["eligible"]),None)
    holdres=None;promote=False
    if selected:
        sh=summarize(select(hold,selected))
        promote=sh.get("n",0)>=20 and sh.get("avg_payoff",-9)>0 and sh.get("continuator_rate",0)>=bh["continuator_rate"]+.05
        holdres={"baseline":bh,"selected":sh,"delta_continuator":sh.get("continuator_rate",0)-bh["continuator_rate"],"delta_payoff":sh.get("avg_payoff",-9)-bh["avg_payoff"],"pass":promote}
    print(json.dumps({
      "ok":True,"research_only":True,"no_order_created":True,
      "family":"DERIVATIVES_ARCHIVE_ALPHA_V1",
      "source":"Binance Vision UM daily metrics + Spot daily 1m archives",
      "period":[START.isoformat(),END.isoformat()],
      "symbols":len(SYMBOLS),"rows":len(allrows),
      "blocks":{"train":len(train),"validation":len(val),"holdout":len(hold)},
      "baselines":{"validation":bv,"holdout":bh},
      "candidate_count":len(scored),
      "top_validation":scored[:10],
      "selected_rule":selected,
      "holdout_result":holdres,
      "production_decision":"PROMOTE_TO_SHADOW" if promote else "REJECT_DERIVATIVES_ARCHIVE_ALPHA",
      "promote_to_shadow":promote
    },indent=2))

if __name__=="__main__": main()
