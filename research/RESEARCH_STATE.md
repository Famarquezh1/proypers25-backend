# Proypers25 Autonomous Research State

Updated: 2026-09-29T11:15:52.2741558Z

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
- K=10: class=sequence medAUC=0.9 minAUC=0.7619047619047619; money=trades net=-1.339%
- K=15: class=sequence medAUC=0.9 minAUC=0.7619047619047619; money=trades net=-1.339%
- K=20: class=sequence medAUC=0.9 minAUC=0.7619047619047619; money=trades net=-1.339%
- K=5: class=sequence medAUC=0.9 minAUC=0.7619047619047619; money=trades net=-1.339%

## Next hypothesis
classification is recurrent but monetization fails; focus on entry/exit microstructure and depth-state timing

## Guardrails
Research/shadow/offline only. No production, V23, real orders or trading credentials.
