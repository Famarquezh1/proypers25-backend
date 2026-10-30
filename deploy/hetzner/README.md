# Hetzner bootstrap — staged, not live

Target: CX23, Helsinki, Ubuntu 24.04 x86_64. Subscription authorized at USD 7.09/month including IPv4, on 2026-10-30.

The renderer installs Node.js 22, a pinned production checkout, separate administrative and non-login service accounts, a host firewall, SSH public-key authentication, bounded journal storage and a five-minute systemd read-only probe. No buy, sell, radar, research or recovery script is enabled by this bootstrap. No npm install or TensorFlow runtime is needed for this stage. The probe uses GET requests only and logs no balances or credentials.

The administrative Ed25519 key is generated separately, is never committed, and needs explicit approval before it is installed on the new server. Its private part stays in the task's protected temporary directory. It must be replaced by an owner-controlled key or otherwise handed over through an approved secure mechanism before ending administrative maintenance.

After creating the server, verify SSH host identity through Hetzner's authenticated console, cloud-init completion, OS version, runtime version, pinned commit, inbound firewall, timer execution and Binance public connectivity. Empty root-owned credential files intentionally keep private API checks pending. Binance secrets must be supplied through a secure, non-chat channel; systemd passes them through LoadCredential. Real trading requires separate approval after the read-only account and protection reconciliation checks pass.

## Focused migration findings

- `spot-manual-approval.yml` prepares signals on Ubuntu but executes the Node wrapper on Windows. Signal extraction, execution and decision bookkeeping must move together; changing the runner label alone is insufficient.
- `spot-auto-exit-local.yml` uses PowerShell only for orchestration. Its Node entrypoint invokes historical XEC protection, V6.1 protection, legacy/V10 exit, orphan protection and an advisory orphan audit sequentially. All must be retained.
- The executor checks withdrawals, account trading permission, balances, active Spot symbols, liquidity, signal age, anti-chase rules, sizing and existing positions. The wrapper adds CORE/V10 gates, conviction/growth sizing and native stop handling. Do not remove them.
- A purchase client order ID is timestamp-based. An ambiguous timeout followed by a restart is not proven idempotent. Before live activation, persist an intent before dispatch, use a deterministic intent ID and reconcile with Binance instead of blindly retrying.
- Some protection and exit scripts discover managed positions from completed GitHub signal issues. A standalone service needs equivalent durable bookkeeping and migration of existing positions; otherwise a healthy service can silently manage zero symbols.
- The V6.1 protection script cancels an existing stop before submitting its replacement. Replacement failure must be reconciled and repaired before live readiness can be claimed. A stop-limit order is not a guarantee of execution through a price gap.
- Research and V10 self-training workflows are outside this bootstrap. Migrate only the operational scanner after its exact model/config inputs and workload are established.

## Verified deployment status — 2026-10-30

- Hetzner project `Proypers25`, server `173564852`, name `proypers25-spot-01`, Helsinki, IPv4 `89.167.5.87`.
- Server created after explicit approval: USD 6.49/month plus USD 0.60/month for IPv4, USD 7.09/month total billed by Hetzner under the Chile VAT policy. No paid add-ons were selected.
- Ubuntu 24.04, Node.js 22, pinned checkout, UFW inbound deny except SSH, password/root SSH disabled and deploy-only SSH access verified by the manual GitHub installation job.
- Work cannot route outbound SSH directly. The approved temporary SSH key is stored as `HETZNER_BOOTSTRAP_SSH_KEY` in repository Actions secrets. The installation jobs use it without logging its value.
- Initial cloud-init stopped because `/run/sshd` was not yet present during its SSH configuration check. This was repaired remotely. A separate service-account permission issue was repaired by granting group read/traverse access while keeping root ownership of the checkout. The cloud-init historical error record remains; current service health was checked directly rather than presenting that record as clean.
- Public read-only probe passed in run `41088260465`. The timer is enabled and active and is independent of GitHub Actions.
- Existing Binance credentials were transferred over SSH into root-owned files, without returning their values to the assistant. The read-only private probe reached Binance and passed the withdrawals-disabled check, then refused readiness because `ipRestrict` is not true (`API_IP_RESTRICTION_REQUIRED`), run `41088601433`.
- No trading executor was started. No VPS buy/sell order was sent. Existing Spot workflows were left unchanged. This does not establish or change the activity of the previous runner.
- An actual reboot/recovery test, full position-protection reconciliation, a durable autonomous signal/execution controller and live activation remain pending. The existing shared Binance key must not be restricted to only the VPS IP while the old runner still manages positions. Prepare a dedicated VPS API key with the owner, without withdrawals, and with the exact VPS IPv4 allowlisted before proceeding toward live readiness.

Verified runs:
- https://github.com/Famarquezh1/proypers25-backend/actions/runs/41088260465
- https://github.com/Famarquezh1/proypers25-backend/actions/runs/41088601433
