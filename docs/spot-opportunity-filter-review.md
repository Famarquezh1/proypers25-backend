# Spot opportunity and performance review

Static review of the current repository only. No thresholds or strategy behavior were changed; no out-of-sample results in this checkout justify doing so.

## Potentially over-blocking or contradictory gates

- Gem Radar treats 3–12% 24-hour moves as its highest momentum band, while the Early Momentum Radar’s default 24-hour cap is 18% and its fresh/probe path can consider smaller moves. Gem research eligibility additionally requires at least $5M quote volume and 10,000 trades; the normal Early Momentum threshold is $500K, with a $200K probe threshold. These are distinct discovery paths, but chaining them as mandatory gates would exclude candidates the earlier radar was designed to surface. No evidence here establishes that combining the gates improves net results.
- The Gem score gives 0–3% moves fewer momentum points than 3–12% moves, while Early Momentum has a dedicated fresh-move path. That is a prioritization difference, not by itself proof of a faulty filter.
- CORE V4.2 freshness and the local microstructure checks are additional layers: the V4.2 scorer requires a 15m/1h/24h context and suppresses scores for more extended moves; the local guard rejects wide spreads, reversals, stale/insufficient samples, or high latency. This can favor confirmed, liquid follow-through over the earliest move. The repo does not provide out-of-sample comparisons showing whether the combined gates are too strict.
- `momentumContinuationFactor` is a standalone factor with a historical trainer; repository callers do not show it wired into the normal execution decision path. The Pre-CORE runner explicitly reports `shadow_only`, `no_order_created`, and `production_action: NONE`. Neither should be described as a live entry strategy.
- The meta-decision engine has hard rejection conditions and a `SHADOW_ONLY` mode. It is suitable for observation, not evidence that production CORE currently blocks or admits orders.

These observations warrant measurement and clearer lane composition, not relaxed safety settings. Keep liquidity, spread/manipulation, exposure, loss, and late-entry controls in place until an out-of-sample comparison demonstrates a safe improvement.

## Net-performance evidence and limits

The repository has a real-position lifecycle that records realized net PnL, executed quote amounts, and USDT-denominated fees, plus a separate infrastructure-cost estimator and a modeled round-trip cost input. The buy-fee summarizer counts commissions denominated in USDT; non-USDT commissions are not converted there. The entry expected-value model uses a configured cost estimate (default 0.25%), not a measured per-symbol spread/slippage series. Actual fill quote amounts include execution prices, but the reviewed lifecycle does not publish a separate spread/slippage attribution.

No Binance account/order export or verified strategy-level realized-performance dataset is included in this checkout. Therefore this review cannot report real net profitability, validate the strategy thresholds, or treat policy tests, shadow output, or backtests as realized returns.
