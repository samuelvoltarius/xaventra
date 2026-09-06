# Developing Xaventra

For response-contract changes, run `npm run build` and then
`npm run check:response-contract`. This uses the actual compiled native/REST
and Desktop message pipeline with a scripted loopback provider, isolated state
and no operator credentials. Preserve failing reports; do not confuse this
fixture with a real-provider, packaged UI or distributed HA run. See
[2.78.6 verification](VERIFICATION_2.78.6.md) for the bounded grammar and limits.

This guide is the shortest path from a clean clone to a useful contribution.
It explains where changes belong, why the boundaries exist and how to prove a
change works without relying on model prose or private production state.

## 1. Prepare a development instance

Requirements:

- Node.js 22 or newer
- npm
- Git
- one configured LLM route for interactive tests; most unit tests do not need one

```bash
git clone https://github.com/samuelvoltarius/xaventra.git
cd xaventra
npm install
npm run build
cp xaventra.config.example.json xaventra.config.json
npm run cli -- setup
npm run typecheck
npm test
npm run build
```

PowerShell uses `Copy-Item xaventra.config.example.json xaventra.config.json` instead of
`cp`. Keep credentials in local environment variables or an approved secret
store. Never add them to configuration examples, fixtures or test snapshots.

## 2. Understand the execution path

Every normal request should follow one authoritative path:

```text
channel or client
  -> message pipeline
  -> task contract and context policy
  -> planner / worker
  -> typed tool executor
  -> immutable Tool Evidence
  -> independent validator
  -> Outcome Ledger
  -> governed Memory and learning projections
```

The model may propose work, but it cannot certify that a tool ran. A UI, plugin,
provider or Mesh node may extend the system, but it cannot bypass this path.

## 3. Find the correct owner

| Change | Authoritative location | Proof expected |
|---|---|---|
| Request routing or completion | `src/core/message-pipeline.ts`, `src/core/execution-kernel.ts` | isolated pipeline/contract test |
| Context depth or budgets | `src/core/context-policy.ts` | deterministic policy test |
| Provider discovery | `src/llm/provider-manifest.ts`, `src/llm/` adapters | safe catalog plus live/mock probe |
| Model/node selection | `src/routing/outcome-router.ts` | scored decision with validated samples |
| New tool | `src/tools/complete-registry.ts` and its implementation | executing Tool Evidence plus validator |
| Tool validation | `src/validation/tool-validator.ts` | positive and fail-closed negative tests |
| Durable facts or recall | `src/memory/memory-governance.ts` | provenance, scope and tombstone tests |
| Learning | `src/learning/learning-coordinator.ts` | independently validated non-benchmark outcome |
| Node capability | `src/mesh/capability-graph.ts` | signed/fresh capability evidence |
| Transport | `src/mesh/*-mesh-transport.ts` | ACK, replay and failure-path tests |
| Doctor diagnosis | `src/doctor/` | diagnosis evidence without mutation |
| Self-repair | Doctor plus PATCH_GATE path | sandbox, regression and rollback proof |
| Desktop behavior | `desktop/` plus `src/desktop/desktop-api.ts` | real UI/API gate and scoped ACK |
| Trust presentation | Dashboard/Desktop projection | references to canonical Run and Evidence IDs |

If two components appear to own the same decision, stop and resolve the
duplication rather than adding a third path.

## 4. Common contribution recipes

### Add an LLM provider

1. Declare safe provider metadata and discovery behavior in the manifest catalog.
2. Keep authentication detection separate from model discovery.
3. Expose only availability state; never publish a credential value.
4. Add protocol/capability probes and bounded timeouts.
5. Feed verified runtime state into the Capability Graph.
6. Add fixture-based tests for installed, unauthenticated, offline and healthy states.

### Add a tool

1. Define a narrow typed input schema; do not accept a free shell string.
2. Register the tool through the canonical registry.
3. Apply RBAC, lifecycle and risk gates.
4. Return a structured actual result.
5. Add an independent validator and, where possible, compensation behavior.
6. Test success, denial, timeout, replay and malformed output.

### Improve Memory

1. Preserve user and tenant scope.
2. Store provenance, verification time, confidence and lifecycle.
3. Make correction and deletion produce tombstones that survive failover.
4. Do not add a second write path around Memory Governance.
5. Never learn success from a model answer or benchmark fixture.

### Improve Desktop

1. Treat Desktop as a client of the authoritative Main, not another runtime.
2. Use typed, owner/client-scoped IPC and API messages.
3. Keep tokens in Electron `safeStorage`.
4. Preserve keyboard navigation, responsive layout and independent chat scrolling.
5. Show verified model/node/tool state separately from availability probes.

## 5. Test safely

Tests must use isolated temporary roots. They must never read or write live
`.nova-data`, user Memory, OAuth state, node identities or production config.

```bash
npm run typecheck
npm test
npm run build
npm run check:build
npm run check:layers
npm run check:catalogs
npm run check:assurance
```

Use the smallest relevant test while iterating, then run the full gates before
a pull request. Desktop work should also run `npm run check:desktop-ui` with an
authoritative local Core endpoint available.

## 6. Debug locally

```bash
npm run debug
npm run start:fast
npm run check:voice
npm run benchmark:smoke
```

`start:fast` assumes `dist/` is current. Prefer the normal start command after
source changes. A stale-build warning is diagnostic evidence, not a successful
build.

## 7. Compatibility rules

Xaventra was previously named Nova. During the first public migration release,
the following remain stable compatibility contracts:

- `NOVA_*` environment variables
- `.nova-*` persisted directories
- persisted `nova-*` node IDs and lease names
- legacy `nova` CLI aliases
- existing signed deployment identities

Do not mass-rename them. A migration must include backup, forward migration,
rollback, checkpoint resume, Memory continuity and split-brain tests. See
`BRAND_MIGRATION.md`.

## 8. Definition of done

A change is done only when:

- the expected outcome is explicit;
- the authoritative component owns the implementation;
- success and failure paths have isolated tests;
- real Tool Evidence or deterministic state validates the outcome;
- secrets and user data remain outside source and logs;
- compatibility and rollback behavior are documented;
- generated catalogs and relevant guides are current;
- the required verification commands pass.

A model saying “done” is never one of these conditions.

## 9. Good first contributions

- add safe provider manifests and discovery fixtures;
- replace stale Nova wording in public documentation without renaming persisted contracts;
- improve setup diagnostics and actionable error messages;
- add accessibility tests and keyboard flows to Desktop;
- add isolated benchmark scenarios for real failure modes;
- implement typed compensation for reversible file or configuration tools;
- add defensive Blue-Team parsers with redacted evidence fixtures;
- improve public architecture diagrams and clean-clone documentation.

## 10. Pull-request handoff

Write a handoff that another contributor can continue without private chat
history:

```text
Outcome:
Authority changed:
Files changed:
Validation run:
Failure behavior:
Rollback/compensation:
Known follow-up:
```

Also follow `CONTRIBUTING.md`, `SECURITY.md` and the public release checklist.
