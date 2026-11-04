# Proypers25 — ten-day research loop
Deadline: 2026-11-14, America/Punta_Arenas. This is a new bounded prospective experiment, not a claim of achieved intelligence or profitability.

## Runtime and boundaries
- Source branch: deploy/hetzner-safe-bootstrap-20261030; deploy/hetzner/research/.
- Main control workflow: .github/workflows/hetzner-research-control.yml.
- VPS collector: /opt/proypers25/research, service and timer proypers25-research.
- Evidence: /var/lib/proypers25/research/{ledger,report,health}.json.
- Collector every five minutes, native timer bounded through Nov 15 UTC to finish last labels. No PC/Windows or LLM API dependency.
- Intelligence is supplied by scheduled ChatGPT Work runs, with distinct creator, critic and verifier roles. These are role-separated reasoning passes, not three independently trained models. Work limits/availability apply.
- Public GET only. Existing live CORE remains a separate unchanged process. Research cannot dispatch orders. No new infrastructure or external API subscription.
- Public report is hypothetical research performance, fixed 10 USDT per selected signal, with 0.30 percentage-point assumed total cost; it is NOT actual account PnL or a capital-constrained portfolio simulation. Actual account returns require authenticated fills, holdings and allocated VPS costs, evaluated separately.

## Pre-registered question
Among fresh notified CORE signals, can pre-entry price continuation and avoidance of stretched entries improve the direction of price 60–61 minutes later and hypothetical net outcome over selecting every observed CORE signal?
Capture current ask and only fully closed historical candles. One observation per symbol at most every 20 minutes. Record every candidate's prediction before its outcome, including abstention. No backdating or retrospective edits.
Three initial candidates: CORE reference, positive 5m and 15m continuation, same plus 60m return below 5%. These are hypotheses, not validated new trading rules.
Discovery until Nov 10 00:00 Punta Arenas; then freeze proposal hash and test prospectively until the deadline. Outcomes remain append-only; no rejected proposal is erased. Correlated/repeated signals must not be presented as independent trials.

## One scheduled cycle
1. Read this runbook, existing CYCLE-*.md records and current source/control SHA. Discover connector tools only as needed; use Main GitHub connection, never NODRA.
2. Get current control workflow run jobs. Re-run ONLY its latest successful status job, not deploy. Read completed logs; require fresh RESEARCH_STATUS, active timer, success result, public connectivity, fresh live heartbeat. If stale/failing, read only collector unit logs and directly related files; fix conservatively and validate, maximum two repair rounds. Do not leave a dispatched workflow unverified. Do not mistake skipped jobs for successful deployment.
3. Creator: inspect only RESEARCH_DISCOVERY rows (not held-out outcomes) and prior rejected hypotheses. State a concrete falsifiable explanation, a novel improvement when justified, predicted effect and invalidating evidence. At most ONE materially distinct proposal per day, six candidates total. No massive grids, QPU, repeated failed research or general audit.
4. Critic: challenge leakage, stale entry, selection bias, tiny coverage, repeated-symbol dependence, optimistic costs, 1h mark versus executable lifecycle, and dependence on a single winner. Explicitly list what would invalidate the creator's claim.
5. Verifier: check chronology, source SHA, tests, public-data health and genuinely prospective labels. Report sample size/coverage, monetary weighted gains/losses and costs, not hit count alone. Demand independent evaluation; zero observations/pending labels are NOT successes. A target of 80% is an aspiration, never prefilled evidence. No promotion based on small samples.
6. Before freeze, a justified research-only proposal may update proposals.json with a NEW version, tests, and recorded rationale. Update pinned source SHA in main control workflow ONLY after checks. Its path-scoped push deploys research; follow through deploy + independent status to completion. No live-engine configuration/authorization/strategy changes and no financial endpoint calls. After freeze, do not change candidate definitions, features, cost assumptions or horizon; fixes invalidating data require explicit invalidation and honest final verdict.
7. Persist each cycle under deploy/hetzner/research/CYCLE-YYYYMMDD-HHMM.md on source branch (source SHA, creator proposal, critic objections, verifier decision, known failures, next bounded action). Keep existing reports. No secrets/private keys in logs or commits.
8. On Nov 14 deliver a definitive implemented/tested/result report, whether positive, negative or inconclusive; do not extend the experiment automatically or claim a winning system. Net profitability after actual costs and capital allocation is primary; no guaranteed 80/99%.

## First cycle — 2026-11-04
Creator: the seven MOMENTUM_FAILURE closes (-1.603692 USDT realized) suggest testing whether confirmation at entry distinguishes continuation from immediate weakening. This is an association, not a demonstrated causal explanation.
Critic: eliminating losing entries retrospectively would be leakage; a fixed 1h mark does not reproduce current native stop/trailing execution. Trading fees, repeated symbols and market regime can erase apparent benefits.
Verifier: five targeted tests passed; installer checks hashes, public data, timer and unchanged live PID. Initially no fresh eligible signal was captured, so there is no predictive result yet. Candidates stay research-only and cannot change production.
