# Evidence-based direction for Proypers25 — 2026-11-01

## Scope
Read-only comparison of published primary research and the pinned CORE strategy. No production strategy or capital changes; no training or new simulations.

## Verified local findings
The production CORE entry path uses numerical rules and QUBO scoring, not an OpenAI/Anthropic reasoning call per trade.
Relevant files: backend/scripts/github-spot-production-radar-v42.js; backend/services/spotProductionSelection.js; backend/services/spotQuboProductionV5.js.
The candidate gate checks liquidity, 2/3 trained-window agreement, reversal and score thresholds. Its score is not a calibrated expected net return under the actual exit policy.
Market regime classification already exists in backend/services/spotMarketRegime.js; regime-specific weights are supported in spotQuboProductionV5.js. Proposing another generic regime detector would duplicate existing work.
The exit policy already documents a 0.2% round-trip fee assumption and historical training/holdout results. It is incorrect to say costs or evaluation have never been considered. These metadata are historical claims, not current realized profitability.
Current exit parameters include -5% hard stop, +5% break-even trigger, +8% trailing trigger, 1h momentum failure at <=-1.5%, and 3h no-progress exit at <=+0.5%. These are code facts, not evidence that any one threshold caused the observed loss.

## External evidence and limits
1. AI-Trader (Fan et al.): https://arxiv.org/html/2512.10971v1
Table 1 reports Claude 3.7 US equities +3.11% vs QQQ +1.87%; crypto -15.30% vs index -14.30%. Positive equities performance cannot establish transfer to Binance Spot. The framework uses tool-driven information search and different trading frequencies. Code: https://github.com/HKUDS/AI-Trader (current main has evolved beyond the original paper).
2. StockBench (Chen et al.): https://arxiv.org/html/2510.02209v1
Four-month historical trading evaluation, not proof of real broker profits. Claude Sonnet 4 +2.2%, passive +0.4%; includes prices, news and fundamentals. Ablation in two other models reduced returns when information was removed; this does not prove adding news will improve CORE crypto. Rankings change by market period. Binance-specific costs were not verified.
Code: https://github.com/ChenYXxxx/stockbench
3. Agent Market Arena (Qian et al.): https://arxiv.org/html/2510.11695v2
Compares four architectures and five model backbones. Authors report architecture has a larger effect than changing model. Methods explicitly update simulated portfolios with daily BUY/SELL/HOLD actions. Verified news and memory are part of the setup. A reported return is not an audited Binance execution result.

## Decision
No evidence supports replacing CORE wholesale with an LLM agent, adding paid APIs, widening stops, or enabling more capital solely because another study had positive returns.
Prioritize a bounded explanation of the already completed 15 buy/sell pairs: reconstruct actual entry-to-exit paths, decision reasons, commissions and remaining dust, then attribute gross loss to entry movement, exit timing or costs. Compare the same fixed entry events to their subsequent price paths; do not select new assets or search hundreds of thresholds.
A specific mismatch between what a selection score is designed to capture and what the real exit chain captures would justify a targeted change. That mismatch has not yet been proven.
If existing data cannot distinguish competing explanations, report that limit rather than inventing a new strategy. Production remains unchanged.
