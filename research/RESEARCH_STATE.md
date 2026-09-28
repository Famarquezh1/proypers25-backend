# Proypers25 Autonomous Research State

Updated: 2026-09-28T03:44:10.325Z

Branch: research/post-signal-continuation-autopsy

## Scientific split status
- Usable universe: 295
- Development block: first 252 signals
- Previous fixed TEST: CONSUMED FOR ARCHITECTURE DEVELOPMENT; not reused as fresh holdout
- FINAL HOLDOUT: last 43 signals — UNTOUCHED_NOT_EVALUATED

## Latest experiment
- Hypothesis: H-FRONTLOADED-WF-001
- Family: frontloaded_competing_hazard
- Decision: REJECTED_OR_INCONCLUSIVE
- Walk-forward folds: 3
- Pooled selected trades: 15
- Pooled avg net: 0.160%
- Positive folds: 3/3
- PF>1 folds: 2/3

## Fold evidence
- Fold 1: AUC test 1, selected 8, avg net 0.019%, PF 1.0326368518860385
- Fold 2: AUC test 0.1, selected 5, avg net 0.332%, PF 1.7526409733926465
- Fold 3: AUC test 1, selected 2, avg net 0.296%, PF null

## Next hypothesis
Investigate state-transition/order-of-events representation rather than static early-window features; front-loaded hazard did not transport economically.

## Guardrails
Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.
