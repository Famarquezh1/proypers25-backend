import json, time, urllib.parse, urllib.request, statistics
H=240
d=json.load(open("core-timesfm-results.json",encoding="utf-8"))
rows=[]
def get(url):
  for i in range(5):
    try:
      req=urllib.request.Request(url,headers={"User-Agent":"proypers25-timesfm-eval/1.0"})
      with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
    except Exception:
      if i==4: raise
      time.sleep(.4*(i+1))
for s in d["rows"]:
  ts=int(__import__("datetime").datetime.fromisoformat(s["created_at"].replace("Z","+00:00")).timestamp()*1000)
  if int(time.time()*1000)<ts+H*60000: continue
  q=urllib.parse.urlencode({"symbol":s["symbol"],"interval":"1m","startTime":ts,"endTime":ts+(H+2)*60000,"limit":300})
  try:k=get("https://data-api.binance.vision/api/v3/klines?"+q)
  except Exception:continue
  if len(k)<241:continue
  entry=float(s["signal_price"]); first3=firstn=None; mfe=-99; mae=99
  for i,b in enumerate(k[:241]):
    hi=float(b[2])/entry-1; lo=float(b[3])/entry-1
    mfe=max(mfe,hi);mae=min(mae,lo)
    if first3 is None and hi>=.03:first3=i
    if firstn is None and lo<=-.01:firstn=i
  cont=first3 is not None and (firstn is None or first3<firstn)
  close4=float(k[240][4])
  rows.append({**s,"target_continuator":cont,"mfe_pct":mfe*100,"mae_pct":mae*100,"return_4h_net_pct":(close4/entry-1)*100-.2})
rows.sort(key=lambda x:x["created_at"])
def stats(a):
  if not a:return {"n":0}
  return {"n":len(a),"continuators":sum(x["target_continuator"] for x in a),"continuator_rate":sum(x["target_continuator"] for x in a)/len(a),
    "avg_mfe_pct":sum(x["mfe_pct"] for x in a)/len(a),"avg_mae_pct":sum(x["mae_pct"] for x in a)/len(a),"avg_return_4h_net_pct":sum(x["return_4h_net_pct"] for x in a)/len(a)}
selected=[x for x in rows if x["forecast_edge_pct"]>0]
rejected=[x for x in rows if x["forecast_edge_pct"]<=0]
mid=len(rows)//2
result={"ok":True,"research_only":True,"no_order_created":True,"rule":"forecast_edge_pct > 0 (predefined before outcome evaluation)",
 "mature_forecasts":len(rows),"baseline":stats(rows),"selected":stats(selected),"rejected":stats(rejected),
 "chronological_first_half":{"baseline":stats(rows[:mid]),"selected":stats([x for x in rows[:mid] if x["forecast_edge_pct"]>0])},
 "chronological_second_half":{"baseline":stats(rows[mid:]),"selected":stats([x for x in rows[mid:] if x["forecast_edge_pct"]>0])},
 "rows":rows}
json.dump(result,open("core-timesfm-evaluation.json","w"),indent=2)
print(json.dumps({k:v for k,v in result.items() if k!="rows"},indent=2))
