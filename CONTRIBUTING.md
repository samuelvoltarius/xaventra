# Contributing to Xaventra

Thank you for helping build Xaventra. Changes should make the system more
reliable, observable and understandable without creating a second authority.

## Start here

1. Read `README.md`, `docs/DEVELOPMENT.md`, `docs/ARCHITECTURE.md` and `AGENTS.md`.
2. Open an issue describing the expected outcome, affected subsystem, risks and
   validation method.
3. Keep the change bounded. Preserve unrelated working-tree changes.
4. Add isolated tests that use temporary data directories.
5. Run the verification commands below.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check:catalogs
npm run check:infra-leaks
npm run check:assurance
```

## Version rule

- **Patch** (`2.89.x`): fixes only, no new features.
- **Minor** (`2.x.0`): only for a large, coherent block of new capability.
- **Major** (`3.0.0`): only for a breaking change (data, API or config that needs migration).

Public text (README, website) says "Xaventra 2"; the exact version appears only in
status, update and diagnostic sections and in the changelog.

## Pull-request contract

A pull request must explain:

- what user-visible or operational outcome changes;
- which component remains authoritative;
- what real evidence validates the result;
- how failure behaves;
- whether rollback or compensation exists;
- what documentation changed.

Do not commit secrets, production configuration, runtime databases, generated
logs, node identities, OAuth state, benchmark contamination or private user
material.

`check:infra-leaks` scans tracked text files. Tailnet fixtures use only the
documented placeholder blocks; this is not proof that a device exists. Known
private hostnames, domains and identities belong in an ignored `.leak-denylist`
or the `XAVENTRA_LEAK_DENYLIST` CI secret, never in public test patterns. Lines
are case-insensitive literals or `re:` regular expressions. Findings report
file/line and entry number, not the private value. Official push CI requires
this denylist and blocks all regression jobs if the scan fails. Fork PRs without
secrets still run the generic address check. This scans the current tree, not
historical commits; Gitleaks remains a separate required pre-push gate.

## Handoff format

Make the pull request understandable without private conversation history:

```text
Outcome:
Authority changed:
Files changed:
Validation run:
Failure behavior:
Rollback/compensation:
Known follow-up:
```

Use `docs/DEVELOPMENT.md` to locate the authoritative subsystem and its expected
evidence contract.

## Compatibility

The public brand is Xaventra. `NOVA_*`, `.nova-*` paths and `nova-*` persisted
node IDs are temporary compatibility contracts. Do not rename them casually;
follow `BRAND_MIGRATION.md` and provide migration plus rollback tests.
