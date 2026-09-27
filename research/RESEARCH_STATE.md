# Proypers25 Autonomous Research State

Updated: 2026-09-27T23:20:13.048Z

Branch: research/post-signal-continuation-autopsy
Execution environment: github-hosted-provisional-hazard-money

## Latest valid batch
- Universe: 286
- Hypothesis: H-HAZARD-MONETIZE-001
- Decision: REJECTED_OR_INCONCLUSIVE
- Frozen selector TEST selected: 11
- Exit policy selected on TRAIN/VALIDATION: time30_stop1
- TEST avg net: -0.839%
- TEST profit factor: 0.091
- TEST compound: -8.881%
- TEST max drawdown: -8.984%
- Bootstrap 95% avg-return CI: [-1.254%, -0.362%]
- FINAL HOLDOUT: UNTOUCHED_NOT_EVALUATED

## Conclusion
The competing-hazard selector showed classification lift but the preregistered exit family failed to monetize it on TEST. H-HAZARD-MONETIZE-001 is rejected without opening the final holdout.

## Next hypothesis
Model joint future MFE/MAE and terminal-return distribution; the continuation edge still did not convert robustly into money.

## Guardrails
Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.
