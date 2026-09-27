# Proypers25 Autonomous Research State

Updated: 2026-09-27T23:12:48.280Z

Branch: research/post-signal-continuation-autopsy

Execution environment: github-hosted-provisional-data-api

## Latest valid batch
- Universe: 286
- Split: TRAIN 143 / VALIDATION 57 / TEST 43 / FINAL HOLDOUT 43
- Hypothesis: H-SELECTIVE-DISAGREE-001
- Decision: REJECTED_OR_INCONCLUSIVE
- TEST baseline BUY continuation: 37.50%
- TEST selective BUY continuation: 20.00%
- TEST baseline BUY net 4h: -2.526%
- TEST selective BUY net 4h: -2.692%
- Bootstrap delta mean: -17.72 pp
- Bootstrap 95% CI: [-43.61, 2.56] pp
- Bootstrap P(delta <= 0): 0.954
- FINAL HOLDOUT: UNTOUCHED_NOT_EVALUATED

## Conclusion
Low specialist disagreement does not identify safer BUYs here. It reduced continuation rate and did not improve 4h net return. H-SELECTIVE-DISAGREE-001 is rejected on TEST without opening the final holdout.

## Next hypothesis
Model continuation and failure as competing risks / discrete-time hazards. Predict the relative near-term hazard of +3% continuation versus -1% failure from causal post-signal trajectory, rather than treating continuation as one static binary label.

## Guardrails
Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.
