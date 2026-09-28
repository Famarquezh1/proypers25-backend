# Proypers25 Autonomous Research State

Updated: 2026-09-28T11:41:30.442Z

Branch: research/post-signal-continuation-autopsy

## Scientific split status
- Usable universe: 290
- Development block: first 247 signals
- Previous fixed TEST: CONSUMED FOR ARCHITECTURE DEVELOPMENT; not reused as fresh holdout
- FINAL HOLDOUT: last 43 signals — UNTOUCHED_NOT_EVALUATED

## Latest experiment
- Hypothesis: H-FRONTLOADED-WF-001
- Family: frontloaded_competing_hazard
- Decision: REJECTED_OR_INCONCLUSIVE
- Walk-forward folds: 3
- Pooled selected trades: 23
- Pooled avg net: 0.073%
- Positive folds: 1/3
- PF>1 folds: 1/3

## Fold evidence
- Fold 1: AUC test 0.5555555555555556, selected 11, avg net -0.131%, PF 0.8443058214345478
- Fold 2: AUC test 1, selected 6, avg net 0.851%, PF 14.383759417549603
- Fold 3: AUC test null, selected 6, avg net -0.330%, PF 0.630106640184565

## Next hypothesis
Investigate state-transition/order-of-events representation rather than static early-window features; front-loaded hazard did not transport economically.

## Guardrails
Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.
