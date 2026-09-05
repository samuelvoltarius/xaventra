# Xaventra release checklist

This repository is a public source preview. Source publication, downloadable
binaries and upgrades of existing deployments have different evidence gates.
Do not present unchecked items as completed or as production guarantees.

## Public source gates

- [x] Use a fresh Git object database; copy no old private commits or refs.
- [x] Scan the complete new history and exported source for secrets.
- [x] Exclude credentials, OAuth state, wallets, runtime memory, logs, private
      project memory, production inventories and operational backups.
- [x] Review examples for inert addresses, identities and credential placeholders.
- [x] Remove the message-triggered admin override and blanket OS-mode ownership;
      test persisted permissions and channel-bound authorization.
- [x] Include README, contribution guidance, responsible disclosure policy,
      compatibility identifiers, third-party notices and Core SBOM.
- [x] Install using public lockfiles with lifecycle scripts disabled; run
      typecheck, isolated tests, build, catalogs and dependency audits.
- [x] Verify the source in clean GitHub CI using only example configuration.
- [x] Obtain explicit owner authorization to make this clean repository public.

The old private repository and its cached hosting objects are not published by
this process. Historical credential retirement remains an independent private
operational requirement; those credentials must never be reused.

## Binary distribution and commercial readiness

- [ ] Review name, domain and package availability and relevant marks.
- [ ] Reserve desired package namespaces.
- [ ] Complete review of applicable GPL/LGPL connector distribution obligations.
- [ ] Run native dependency lifecycle scripts on disposable CI hosts.
- [ ] Package and smoke-test Desktop on every advertised operating system.
- [ ] Publish signed artifacts and SHA-256 hashes with reproducible build evidence.
- [ ] Render and smoke-test the website at desktop and mobile widths before
      separately enabling its publication.

## Existing-deployment migration

- [ ] Prove old Nova identities survive the migration without duplication.
- [ ] Prove Main, Telegram, dashboard and release fencing permit one owner.
- [ ] Prove rollback to the last verified release.
- [ ] Prove Memory, Outcome Ledger and mission checkpoints survive migration.
- [ ] Confirm no credential or OAuth migration crosses a node boundary.
- [ ] Reauthorize legacy privileged users whose grants have no provenance.

Never expose the development REST API without authentication. The legacy
Next.js dashboard remains an experimental prototype, not an authenticated
production control plane. See [PUBLIC_EXPORT_REPORT.md](../PUBLIC_EXPORT_REPORT.md)
for evidence and [the authorization review](AUTHORIZATION_REVIEW_2.77.2.md)
for the latest permission fix and its validation limits.
