# Proypers25 Autonomous Research State

Updated: 2026-09-27T23:17:35.728Z

Branch: research/post-signal-continuation-autopsy
Execution environment: github-hosted-provisional-hazard

## Latest valid batch
- Universe: 286
- Hypothesis: H-COMPETING-HAZARD-001
- Decision: REJECTED_OR_INCONCLUSIVE
- Raw split: {"train":143,"val":57,"test":43,"final_holdout":43}
- Risk set: {"train":92,"val":46,"test":32}
- Hazard TEST AUC: 0.625
- Static meta TEST AUC: 0.546875
- AUC delta: 0.078125
- Hazard BUY continuation: 36.364%
- Meta BUY continuation: 22.222%
- Hazard BUY net 4h: -3.971%
- Meta BUY net 4h: -3.812%
- FINAL HOLDOUT: UNTOUCHED_NOT_EVALUATED

## Next hypothesis
Model the joint distribution of MFE/MAE or latent continuation species; competing hazards did not add robust OOS separation over the static meta-agent.

## Guardrails
Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.
