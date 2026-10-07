#!/usr/bin/env python3
import io, json, os, urllib.error, urllib.parse, urllib.request, zipfile
from datetime import datetime, timezone

REPO=os.environ.get("GITHUB_REPOSITORY","Famarquezh1/proypers25-backend")
TOKEN=os.environ.get("GITHUB_TOKEN","")
WORKFLOW="core-post-signal-resilience.yml"
COST=0.002
HORIZONS=[30,60,120,240]
ISSUE_TITLE="[RESEARCH] CORE Resilience Accumulated"

def gh_headers():
    h={"Accept":"application/vnd.github+json","User-Agent":"proypers25-core-resilience-eval/1.0"}
    if TOKEN: h["Authorization"]=f"Bearer {TOKEN}"
    return h

def request(url,headers=None,method="GET",data=None,redirect=True):
    req=urllib.request.Request(url,headers=headers or {"User-Agent":"proypers25-core-resilience-eval/1.0"},method=method,data=data)
    if redirect: return urllib.request.urlopen(req,timeout=60)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,newurl): return None
    opener=urllib.request.build_opener(NoRedirect)
    try: return opener.open(req,timeout=60)
    except urllib.error.HTTPError as e:
        if e.code in (301,302,303,307,308): return e
        raise

def get_json(url,github=False):
    with request(url,gh_headers() if github else None) as r: return json.load(r)

def github_json(path,method="GET",payload=None):
    data=None if payload is None else json.dumps(payload).encode()
    with request("https://api.github.com/repos/"+REPO+path,gh_headers(),method,data) as r:
        raw=r.read()
        return json.loads(raw.decode()) if raw else None

def download_artifact(artifact_id):
    first=request(f"https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip",gh_headers(),redirect=False)
    loc=first.headers.get("Location"); first.close()
    if not loc: raise RuntimeError(f"artifact {artifact_id}: no signed URL")
    with request(loc,{"User-Agent":"proypers25-core-resilience-eval/1.0"}) as r: return r.read()

def list_artifacts():
    out=[]
    for page in range(1,30):
        runs=github_json(f"/actions/workflows/{WORKFLOW}/runs?status=success&per_page=100&page={page}").get("workflow_runs",[])
        if not runs: break
        for run in runs:
            arts=github_json(f"/actions/runs/{run['id']}/artifacts?per_page=100").get("artifacts",[])
            for a in arts:
                if not a.get("expired") and str(a.get("name","")).startswith("core-post-signal-resilience-"):
                    out.append((run,a))
        if len(runs)<100: break
    return out

def parse_iso(s): return datetime.fromisoformat(str(s).replace("Z","+00:00"))

def load_observations():
    rows=[]; errors=[]; seen=set()
    for run,a in list_artifacts():
        try:
            blob=download_artifact(a["id"])
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                mn=[n for n in z.namelist() if n.endswith("core-post-signal-metadata.json")]
                on=[n for n in z.namelist() if n.endswith("liquidity-resilience-shadow.ndjson")]
                if not mn or not on: continue
                meta=json.loads(z.read(mn[0]).decode("utf-8-sig"))
                obs=[]
                for line in z.read(on[0]).decode("utf-8-sig").splitlines():
                    try: obs.append(json.loads(line))
                    except Exception: pass
            key=(str(meta.get("issue_number")),str(meta.get("symbol")))
            if key in seen: continue
            seen.add(key)
            rows.append({"run_id":run["id"],"head_sha":run.get("head_sha"),"artifact_id":a["id"],"meta":meta,"obs":obs})
        except Exception as e:
            errors.append({"artifact_id":a.get("id"),"error":f"{type(e).__name__}: {e}"})
    return rows,errors

def binance_klines(symbol,start_ms,end_ms):
    q=urllib.parse.urlencode({"symbol":symbol,"interval":"1m","startTime":start_ms,"endTime":end_ms,"limit":500})
    last=None
    for b in ["https://api.binance.com","https://api1.binance.com","https://api2.binance.com","https://api3.binance.com"]:
        try: return get_json(f"{b}/api/v3/klines?{q}")
        except Exception as e: last=e
    raise last or RuntimeError("Binance unavailable")

def trade_outcome(klines,decision_ms):
    eligible=[r for r in klines if int(r[0])>=decision_ms]
    if len(eligible)<2: return None
    entry=float(eligible[0][1]); end_ms=decision_ms+4*3600*1000
    window=[r for r in eligible if int(r[0])<=end_ms]
    if not window or entry<=0: return None
    first3=None; firstneg1=None; mfe=-1e9; mae=1e9
    for i,r in enumerate(window[1:],1):
        hi=float(r[2])/entry-1; lo=float(r[3])/entry-1
        mfe=max(mfe,hi); mae=min(mae,lo)
        if first3 is None and hi>=0.03: first3=i
        if firstneg1 is None and lo<=-0.01: firstneg1=i
    close=float(window[-1][4]); net=(close/entry-1)-COST
    cont=first3 is not None and (firstneg1 is None or first3<firstneg1)
    return {"entry":entry,"net":net,"mfe":mfe,"mae":mae,"continuator":cont}

def avg(a): return sum(a)/len(a) if a else None

def metrics(items):
    if not items: return {"n":0}
    ordered=sorted(items,key=lambda y:y["signal_ms"])
    rets=[x["outcome"]["net"] for x in ordered]
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<0]
    gp=sum(wins); gl=abs(sum(losses)); eq=100.0; peak=100.0; mdd=0.0
    for r in rets:
        eq*=1+r; peak=max(peak,eq); mdd=min(mdd,eq/peak-1)
    return {"n":len(items),"win_rate":len(wins)/len(items),
      "continuator_rate":sum(1 for x in items if x["outcome"]["continuator"])/len(items),
      "avg_net4h":avg(rets),"avg_mfe":avg([x["outcome"]["mfe"] for x in items]),
      "avg_mae":avg([x["outcome"]["mae"] for x in items]),
      "profit_factor":gp/gl if gl>0 else None,"compound_100_to":eq,"max_drawdown":mdd}

def select_rule(states,name):
    if not states: return False
    latest=states[-1]
    if name=="S_POSITIVE": return float(latest.get("S") or 0)>0
    if name=="DIRECTIONAL": return latest.get("directional_candidate") is True
    if name=="SUSTAINED_DIRECTIONAL":
        tail=states[-3:]
        return len(tail)>=2 and sum(1 for x in tail if x.get("directional_candidate") is True)>=2
    return False

def pct(v): return "—" if v is None else f"{v*100:.3f}%"
def num(v): return "—" if v is None else f"{v:.3f}"

def main():
    observations,errors=load_observations()
    now_ms=int(datetime.now(timezone.utc).timestamp()*1000)
    matured=[]; immature=0; no_state=0
    for item in observations:
        meta=item["meta"]; symbol=str(meta.get("symbol") or "").upper(); created=meta.get("signal_created_at")
        if not symbol or not created: continue
        signal_ms=int(parse_iso(created).timestamp()*1000)
        if now_ms < signal_ms+(4*3600+max(HORIZONS))*1000: immature+=1; continue
        states=sorted([x for x in item["obs"] if x.get("type")=="resilience_state" and isinstance(x.get("at"),(int,float))],key=lambda x:x["at"])
        if not states: no_state+=1
        try: kl=binance_klines(symbol,signal_ms,signal_ms+(4*3600+max(HORIZONS)+120)*1000)
        except Exception as e:
            errors.append({"symbol":symbol,"issue":meta.get("issue_number"),"error":f"klines: {e}"}); continue
        matured.append({"symbol":symbol,"issue":meta.get("issue_number"),"signal_ms":signal_ms,"states":states,"klines":kl})

    report={"generated_at":datetime.now(timezone.utc).isoformat(),"artifacts_loaded":len(observations),
      "matured":len(matured),"immature":immature,"mature_without_state":no_state,"errors":errors[:20],"horizons":{}}

    for h in HORIZONS:
        rows=[]
        for x in matured:
            cutoff=x["signal_ms"]+h*1000
            states=[s for s in x["states"] if int(s["at"])<=cutoff]
            if not states: continue
            out=trade_outcome(x["klines"],cutoff)
            if out: rows.append({**x,"states_h":states,"outcome":out})
        hr={"coverage":len(rows),"baseline":metrics(rows),"rules":{}}
        for rule in ["S_POSITIVE","DIRECTIONAL","SUSTAINED_DIRECTIONAL"]:
            sel=[x for x in rows if select_rule(x["states_h"],rule)]
            rej=[x for x in rows if not select_rule(x["states_h"],rule)]
            bad=[x for x in rej if x["outcome"]["net"]<0]; good=[x for x in rej if x["outcome"]["net"]>0]
            hr["rules"][rule]={"selected":metrics(sel),"rejected":metrics(rej),
              "selected_count":len(sel),"rejected_count":len(rej),"rejected_losses":len(bad),"rejected_positive":len(good),
              "avoided_loss_sum":sum(-x["outcome"]["net"] for x in bad),"missed_gain_sum":sum(x["outcome"]["net"] for x in good)}
        report["horizons"][str(h)]=hr

    candidates=[]
    for h,hr in report["horizons"].items():
        for rule,r in hr["rules"].items():
            m=r["selected"]
            if m.get("n",0)>=8 and m.get("avg_net4h") is not None:
                candidates.append((m["avg_net4h"],m.get("profit_factor") or 0,m["n"],h,rule,r,hr["baseline"]))
    best=None
    if candidates:
        candidates.sort(reverse=True,key=lambda x:(x[0],x[1],x[2]))
        _,_,_,h,rule,r,base=candidates[0]
        best={"horizon_sec":int(h),"rule":rule,"selected":r["selected"],"rejected":r["rejected"],"baseline":base,
              "selected_count":r["selected_count"],"rejected_count":r["rejected_count"],"rejected_losses":r["rejected_losses"],
              "rejected_positive":r["rejected_positive"],"avoided_loss_sum":r["avoided_loss_sum"],"missed_gain_sum":r["missed_gain_sum"]}
    report["best_current"]=best; report["research_only"]=True; report["no_order_created"]=True
    with open("core-resilience-accumulated.json","w",encoding="utf-8") as f: json.dump(report,f,indent=2)

    lines=["CORE Post-Signal Resilience — acumulado","",
      f"Generado: {report['generated_at']}",
      f"Artefactos cargados: {report['artifacts_loaded']} · maduros: {report['matured']} · inmaduros: {report['immature']} · maduros sin estado: {report['mature_without_state']}",
      f"Costo aplicado: {COST*100:.2f}%.",""]
    for h in HORIZONS:
        hr=report["horizons"][str(h)]; b=hr["baseline"]
        lines.append(f"## Horizonte {h}s — cobertura {hr['coverage']}")
        lines.append(f"Baseline: n={b.get('n',0)} · net4h={pct(b.get('avg_net4h'))} · PF={num(b.get('profit_factor'))} · WR={pct(b.get('win_rate'))} · continuator={pct(b.get('continuator_rate'))}")
        for rule,r in hr["rules"].items():
            m=r["selected"]
            lines.append(f"- {rule}: n={m.get('n',0)} · net4h={pct(m.get('avg_net4h'))} · PF={num(m.get('profit_factor'))} · WR={pct(m.get('win_rate'))} · cont={pct(m.get('continuator_rate'))} · rechazadas={r['rejected_count']} (pérdidas={r['rejected_losses']}, positivas={r['rejected_positive']})")
        lines.append("")
    if best:
        m=best["selected"]
        lines += ["## Mejor lectura actual (NO promovida automáticamente)",
          f"{best['rule']} a {best['horizon_sec']}s: n={m.get('n',0)}, net4h={pct(m.get('avg_net4h'))}, PF={num(m.get('profit_factor'))}, WR={pct(m.get('win_rate'))}, DD={pct(m.get('max_drawdown'))}.",
          f"Rechazos: {best['rejected_count']} · pérdidas={best['rejected_losses']} · positivas perdidas={best['rejected_positive']} · pérdida evitada acumulada={pct(best['avoided_loss_sum'])} · ganancia perdida={pct(best['missed_gain_sum'])}."]
    else:
        lines += ["## Conclusión actual","No existe aún una submuestra seleccionada con al menos 8 casos maduros. No promover."]
    lines += ["","Research/shadow solamente. No crea órdenes ni modifica producción."]
    body="\n".join(lines); print(body)
    if TOKEN:
        issues=github_json("/issues?state=open&per_page=100&sort=updated&direction=desc")
        existing=next((x for x in issues if x.get("title")==ISSUE_TITLE),None)
        if existing: github_json(f"/issues/{existing['number']}",method="PATCH",payload={"body":body})
        else: github_json("/issues",method="POST",payload={"title":ISSUE_TITLE,"body":body})

if __name__=="__main__": main()
