# Proypers25 Autonomous Research State

Updated: 2026-09-27T23:23:23.145Z

Branch: research/post-signal-continuation-autopsy

## Scientific split status
- Usable universe: 286
- Historical development block: first 243 signals
- Previous TEST block: CONSUMED FOR ARCHITECTURE DEVELOPMENT; do not treat as fresh holdout again
- FINAL HOLDOUT: last 43 signals — UNTOUCHED_NOT_EVALUATED

## Latest experiment
- Hypothesis: H-DISTRIBUTIONAL-PATH-001
- Decision: REJECTED_OR_INCONCLUSIVE
- Chosen on TRAIN/VALIDATION: terminal_only q=0.75
- TEST avg net: -2.263%
- TEST profit factor: 0.211
- Bootstrap P(avg <= 0): 0.9733333333333334
- TEST continuation rate among selected: 18.18%

## Conclusion
The smooth joint MFE/MAE/terminal model did not transport out of sample. Strong TRAIN/VALIDATION performance reversed on the consumed TEST block.

## Next methodology
Use expanding purged walk-forward over the first 243 development signals. Do not reuse the old TEST as a fresh independent set.

## Next hypothesis
Front-loaded continuation hazard (6–30 minutes) versus early failure may be more economically relevant than cumulative 4h continuation probability.

## Guardrails
Research/shadow/offline only. No production deployment, no V23 modification, no real orders, no trading credentials.
