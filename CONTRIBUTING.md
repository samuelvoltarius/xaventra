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
npm run check:assurance
```

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
