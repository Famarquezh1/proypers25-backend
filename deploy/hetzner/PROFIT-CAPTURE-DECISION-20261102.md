# Profit-capture proposal: implementation decision, 2026-11-02

Decision: do not deploy the proposed partial-profit exit as described. This is an implementation/evidence decision, not a conclusion that all partial-exit strategies are unprofitable. No live strategy, order-size setting, native order or service was changed for this review.

## Concrete feasibility constraint

The confirmed SOXLBUSDT BUY was 5.17595 USDT. Its authenticated symbol filters required 5 USDT minimum notional; the position left 0.000935 SOXLB after its completed SELL. Dividing a roughly 5 USDT position into an immediate profit-taking sale and an independently tradeable/protectable remainder cannot meet both minima near entry. At +5%, the original gross position would be worth only 5.4347475 USDT before fees and lot rounding. A split requires approximately the sum of both minima (at least 10 USDT in this example), plus rounding/commission/stop-price allowance. This is symbol/price dependent, not a new blanket order-size recommendation.

Current runtime protection-transition.cjs deliberately requires each replacement to keep the original native stop quantity. Partial profit-taking therefore also requires a new durable partial-exit/remainder-protection lifecycle; changing the quantity in an existing full-exit call would violate its identity/recovery checks. No such bypass was introduced. No order-size increase was inferred from authorization to improve exits.

## Existing production behavior

The pinned strategy already has break-even activation at +5%, a +0.3% gross entry lock, trailing activation at +8%, a 4% initial trailing distance and progressive distance tiers. Thus “add a dynamic exit” duplicates existing behavior unless a specific difference is defined.

The single ZKP historical MFE case does not identify an optimal exit policy or establish a general improvement after costs. Its pre-repair execution context must not be treated as an unbiased post-repair sample.

## Reused prior study; no new research execution

Existing workflow: .github/workflows/early-profit-lock-study.yml.
Completed 2026-09-29 run: https://github.com/Famarquezh1/proypers25-backend/actions/runs/36632691733
Job: 109625604855.
Script: backend/scripts/train-spot-early-profit-lock.js.

The existing result contains 347 reconstructed rows / 338 matched unique exits, with chronological blocks 208 discovery, 69 validation and 70 holdout. It evaluated 20 earlier break-even trigger/lock combinations, including fee and cadence stress.

Recorded decision: DO_NOT_PROMOTE, promote=false. Its ranked first candidate moved the trigger from 5% to 3.5% and kept the 0.3% gross lock. Mean return changed -0.1526 percentage points in validation and +0.0815 in holdout; profit factor changed -0.0709 and -0.0135 respectively. The candidate failed the validation gate. None of the reported top candidates passed both blocks; the study selected no promotion.

This study concerns earlier break-even locks, NOT actual partial sales. Its result does not prove a partial-sale strategy would fail or succeed. It does mean the existing “earlier lock” alternative cannot honestly be presented as a demonstrated improvement.

## Completion and scope

Reviewed the existing exit policy, native transition contract, authenticated SOXLB trade/filter evidence already retrieved, and the one completed historical early-lock study. No new model training, parameter search, research workflow, order dispatch or production modification was executed. This record prevents proposing the same discarded configuration as a new finding later.
