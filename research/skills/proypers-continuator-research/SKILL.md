# Proypers Continuator Research Skill

Purpose: evaluate whether information available at or after a CORE signal can distinguish a continuation (+3% before -1%) without contaminating production.

## Non-negotiable protocol
1. Research-only. Never create, submit, simulate as real, or authorize Binance orders.
2. Preserve chronology. A feature for a signal may use only information timestamped at or before the hypothetical decision time.
3. Never use future MFE, MAE, +3/-1 labels, 1h/4h returns, or outcome fields as model inputs.
4. Split chronologically. Model/rule selection is performed without holdout access. Open holdout once.
5. Include realistic transaction costs in economic evaluation.
6. Report sample count, continuation rate, delta versus the contemporaneous baseline, +5/+10 hit rates when available, MFE/MAE, and net return.
7. Do not promote on training fit. Promotion requires positive out-of-sample evidence and an explicit shadow phase.
8. CORE remains detector-only unless a separately validated production gate authorizes otherwise.
9. Existing exhausted CORE variables are controls, not a reason to repeatedly search more thresholds.
10. TimesFM output is evidence, not authority. A forecast must beat a simple baseline out of sample before it can influence shadow decisions.

## TimesFM experiment
- Use pretrained TimesFM 2.5 only for this experiment.
- No paid API and no external model API key.
- Cache model assets locally when possible.
- Forecast only from historical candles ending no later than the signal timestamp.
- Persist model/version, context length, horizon, forecast values, timestamps, and failures.
- Do not silently drop failed symbols; report coverage.
