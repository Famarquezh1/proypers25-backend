# Proypers25 Autonomous Research State

Updated: 2026-09-28T20:41:19.8912457Z

Branch: research/post-signal-continuation-autopsy

## Scientific split status
- FINAL HOLDOUT: 43 - UNTOUCHED_NOT_EVALUATED
- Previous fixed TEST remains consumed; campaign uses expanding purged walk-forward only.

## Latest experiment
- Hypothesis: H-PC-RECURRENT-FACTOR-CAMPAIGN-001
- PC rounds: 4
- Positive money rounds: 0/4
- Strong classification rounds: 4/4
- Conclusion: CLASSIFICATION_SIGNAL_WITHOUT_MONEY

## Recurrent evidence
- K=10: class=sequence+market medAUC=0.8484848484848485 minAUC=0.7575757575757576; money=presignal net=-1.774%
- K=15: class=sequence+market medAUC=0.8484848484848485 minAUC=0.7575757575757576; money=presignal net=-1.774%
- K=20: class=sequence+market medAUC=0.8484848484848485 minAUC=0.7575757575757576; money=presignal net=-1.774%
- K=5: class=sequence+market medAUC=0.8484848484848485 minAUC=0.7575757575757576; money=presignal net=-1.774%

## Next hypothesis
classification is recurrent but monetization fails; focus on entry/exit microstructure and depth-state timing

## Guardrails
Research/shadow/offline only. No production, V23, real orders or trading credentials.
