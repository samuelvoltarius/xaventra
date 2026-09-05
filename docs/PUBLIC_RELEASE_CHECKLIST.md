# Xaventra public release checklist

This checklist is fail-closed. Do not make the repository public until every
required item has evidence.

## Brand and ownership

- [ ] Final name reviewed against GitHub, npm, PyPI, domains and relevant marks.
- [ ] Repository and package namespaces reserved.
- [x] Current public logo is isolated from removed legacy Nova/Brutus assets.
- [ ] README, Desktop, website and documentation consistently use Xaventra.
- [ ] Compatibility identifiers are documented rather than silently renamed.

## History and secrets

- [ ] Rotate the private key formerly stored in `wallet.json`.
- [ ] Rewrite Git history to remove `wallet.json`, `wallets.json` and any other
      credential-bearing blobs from every ref.
- [ ] Run a full-history secret scan after rewriting.
- [x] Review all `.env.example` files and deployment samples for inert values.
- [x] Confirm no OAuth state, node private key, Telegram token, API key, user
      memory, production log or private host inventory is tracked.

## Repository hygiene

- [x] Remove generated archives, runtime databases, logs, screenshots and local
      operational reports from tracked source.
- [x] Confirm `.gitignore` covers all runtime and credential paths.
- [x] Verify generated catalogs can be reproduced from source.
- [x] Generate an SBOM and central third-party notices.
- [ ] Complete commercial counsel review of GPL/LGPL dependencies.

## Reproducibility

- [ ] Clone the rewritten repository into an empty directory.
- [x] Install from the public lockfile with lifecycle scripts disabled.
- [ ] Create configuration only from checked-in examples.
- [x] Run typecheck, full tests, build and catalog generation.
- [ ] Run packaging lifecycle scripts, assurance and freshness gates in clean CI.
- [ ] Package Desktop on each supported operating system.
- [ ] Render and smoke-test `website/index.html` at desktop and mobile widths.

## Runtime safety

- [ ] Prove existing Nova-branded nodes upgrade without identity loss.
- [ ] Prove Main, Telegram, dashboard and release fencing still allow one owner.
- [ ] Prove rollback to the last verified release.
- [ ] Prove Memory, Outcome Ledger and mission checkpoints survive the migration.
- [ ] Confirm no credential or OAuth migration crosses a node boundary.

## Publication

- [ ] Create the public repository from a fresh Git object database after all
      remaining legal, key-rotation and packaging gates pass.
- [ ] Publish signed source and Desktop artifacts with SHA-256 hashes.
- [ ] Add issue templates, responsible disclosure and contribution guidance.
- [ ] Mark experimental features honestly; do not claim unverified production
      results from historical private deployments as public guarantees.
