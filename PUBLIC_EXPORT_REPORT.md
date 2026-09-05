# Public export report

Export date: 2026-09-01. Review updated: 2026-09-05 (2.77.1).

This directory is a history-free public-source export of the Xaventra candidate.
No Git objects, commits or refs from the private development repository were
copied.

## Excluded by design

- private Git history and recovery bundles;
- wallets and credential-bearing files;
- `.env`, local configuration and OAuth state;
- runtime data, Memory, logs, outcomes and node identities;
- production host inventories and one-off remote deployment scripts;
- generated build output, dependency trees, screenshots and local reports;
- private project and user memory.

## Sanitization

Production hostnames, addresses, usernames and unique node identifiers were
replaced with RFC 5737/example values where an example was useful. Abstract
compatibility identifiers such as `NOVA_*`, `.nova-*` and `nova-spark` remain
where source contracts or regression tests require them.

Example infrastructure files require credentials through environment variables
and do not contain default passwords. High-entropy security test fixtures are
assembled at runtime so repository scanners do not mistake them for live keys.

The legacy message-triggered administrator override was removed from both
authorization paths. A regression test now requires identity and permissions to
remain at the multi-user middleware boundary. Personal persona text, Telegram
aliases and IDs, SSH users, private Tailscale addresses and production service
names were replaced with neutral examples.

## Current validation evidence

- TypeScript typecheck: passed
- production TypeScript build and dashboard asset copy: passed
- independent `npm ci --ignore-scripts` using only this export and its lockfile:
  passed; subsequent compatible dependency remediations are locked
- unit/integration suite: 153 files, 1024 tests passed
- Electron main-process bridge regression suite: 4 tests passed
- separate legacy Next.js dashboard: production build passed
- Core, Desktop and legacy-dashboard npm audits: zero reported vulnerabilities
- PM2 CommonJS configuration and built daemon entrypoint: passed
- generated runtime catalogs: current
- security assurance: passed; external agent comparison remains unavailable
- targeted redaction, relay, witness, Codex runtime and provider tests: passed
- Gitleaks 8.30.1 source-only working-tree scan: zero findings (940 files)
- TruffleHog 3.97.1 repeat scan exited without a usable report; no successful
  independent second-scanner result is claimed for this review
- local privacy/topology scan: zero personal runtime identities and zero known
  production host values outside the intentional creator copyright attribution
- CycloneDX SBOM: 692 Core package-lock components (separate Desktop/dashboard
  lockfiles are audited separately, not included in this Core SBOM)

Scanners and tests reduce risk; they do not establish the absence of every
secret or defect. Copyright/creator attribution and third-party notices remain.

## Corrected during this review

- Provider probes retain API version/base paths; invalid catalog paths,
  placeholder credentials, stale results and failed probes cannot look verified.
- Trusted plugin provider metadata has scoped registration and cleanup; it is
  projected into the Desktop catalog without copying credential values.
- Desktop preserves first-run identity, drops the previous endpoint's token on
  connection changes, accepts IPv6 loopback and blocks private workspace paths.
- Setup preserves existing identity/channel/mesh settings. New examples default
  to standalone operation with no fabricated live peers.
- CI seeds an inert configuration and checks Desktop and legacy-dashboard
  regressions. Website publication is manual and separately opt-in.
- Audit transport/JSON failures block release assurance. Nested wallet artifacts
  are rejected. No wallet runtime is introduced.
- Python paths are user-independent; PM2's ESM/CommonJS mismatch, stale deploy
  branch, dashboard source encoding and stale type import are corrected.
- The unused PWA plugin is removed. The legacy dashboard is clearly labeled,
  binds locally by default, and no longer fabricates a healthy Core status.

## Before publication

Only the newly initialized Git history of this source candidate may be uploaded;
never reuse the old private development history or temporary export objects.
The GitHub upload is private, not authorization for public visibility or Pages.

Before a public binary release, run native install scripts on a disposable CI
host, package and test every supported Desktop target, and review GPL/LGPL
connector obligations. The experimental legacy dashboard is not suitable as a
production authenticated control plane; use the Core dashboard and Desktop.
No production rollout, live multi-node failover test, OAuth login or external
agent benchmark was performed by this code review.
