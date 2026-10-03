import json, math
SRC="core-timesfm-evaluation.json"
d=json.load(open(SRC,encoding="utf-8"))
rows=sorted([r for r in d["rows"] if r["forecast_edge_pct"]>0],key=lambda r:r["created_at"])
rets=[float(r["return_4h_net_pct"]) for r in rows]
wins=[x for x in rets if x>0]; losses=[x for x in rets if x<0]; bes=[x for x in rets if x==0]
capital=100.0; peak=100.0; maxdd=0.0
curve=[]
for r,x in zip(rows,rets):
    capital*=1+x/100.0
    peak=max(peak,capital)
    dd=(capital/peak-1)*100
    maxdd=min(maxdd,dd)
    curve.append({"created_at":r["created_at"],"symbol":r["symbol"],"net_return_pct":x,"capital_index":capital,"drawdown_pct":dd})
gross_profit=sum(wins); gross_loss=abs(sum(losses))
out={
 "research_only":True,"shadow_only":True,"no_order_created":True,
 "objective":"net capital growth after costs; no +3/+5/+10 target requirement",
 "frozen_rule":d["rule"],
 "n":len(rows),"wins":len(wins),"losses":len(losses),"breakeven":len(bes),
 "win_rate_pct":100*len(wins)/len(rows) if rows else None,
 "avg_net_return_pct":sum(rets)/len(rets) if rets else None,
 "median_net_return_pct":sorted(rets)[len(rets)//2] if rets else None,
 "avg_win_pct":sum(wins)/len(wins) if wins else None,
 "avg_loss_pct":sum(losses)/len(losses) if losses else None,
 "payoff_ratio":(sum(wins)/len(wins))/abs(sum(losses)/len(losses)) if wins and losses else None,
 "profit_factor":gross_profit/gross_loss if gross_loss else None,
 "capital_start_index":100.0,"capital_end_index":capital,
 "compounded_return_pct":capital-100.0,
 "max_drawdown_pct":maxdd,
 "curve":curve
}
json.dump(out,open("core-timesfm-economic-evaluation.json","w"),indent=2)
print(json.dumps({k:v for k,v in out.items() if k!="curve"},indent=2))
