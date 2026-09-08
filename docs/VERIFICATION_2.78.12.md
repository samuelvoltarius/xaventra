# 2.78.12 — layer contracts, learning isolation and repair authority

Base: `5b1fe9a7f19929d95dbb3b0ec2cf250545bc088d` (2.78.11), whose seven
jobs passed in [CI 34209431042](https://github.com/samuelvoltarius/xaventra/actions/runs/34209431042).
The new candidate needs its own exact-commit CI before main promotion.

## Findings and bounded fixes

1. L0 converted tool failures into file/directory writes and package installation
   derived from untrusted error text. Complete and legacy registries could
   trigger direct L8 handler retries outside a fresh governed action. Both
   registries now preserve the failed call; L0 returns diagnostic metadata only.
   Both legacy L8 callback signatures and its failure-count helper are inert.
   This deliberately closes unsafe automation, **not** the complete self-repair
   acceptance gate. A new scoped plan, sandbox, rollback and approval remain
   required. No successful recovery is recorded merely for making a proposal.
2. L17 reused the first singleton session goal when recording later results.
   It now records the actual outcome request. L7 examples/corrections and L17
   recall are filtered by user before matching; caller identities propagate
   through the Coordinator and runner. Two pre-patch learning tests failed;
   both pass after correction, including persisted reload and wrong-user cases.
3. The concrete Docker inspection phrase did not require tool evidence.
   It now does, while a conceptual Docker explanation remains tool-free.
   Reflection sees execution failure, journal entries preserve actual tool
   success, failed/action responses are not cached, and the task tracker no
   longer marks a failed/unvalidated result successful.
4. Federated memory now prefers configured canonical node identity over an old
   persisted compatibility alias. This does not prove full convergence.

## Evidence and limitations

| Gate | State / evidence |
| --- | --- |
| Static import reachability | Passed: `npm run check:layer-graph`, all 40 service modules; no runtime activation/correctness claim |
| Bounded source behavior | Passed locally: new L0, L8, registry, learning and runtime-evidence tests; normal success/denial controls included |
| Full Core regression | Passed locally: `npm test -- --maxWorkers=2 --reporter=json --outputFile=.nova-data/full-tests-2.78.12.json`, 1282/1282 tests |
| Syntax/build | Passed locally: `npm run typecheck`, `npm run build` on Windows / Node 24.11.1 |
| Compiled layer contracts | Passed locally: `node scripts/check-layer-contracts.mjs`, 8/8 cases; synthetic input, isolated disk, networking prohibited, no live model |
| Desktop bridge | Passed locally: `npm run test:desktop`, 7/7; not native UI acceptance |
| Assurance/catalogs | Passed locally: `npm run check:assurance`, `npm run check:catalogs`; dependency audit 0 findings; external comparison still missing |
| Compiled lifecycle | Passed locally: normal and own-PID-seeded `check-daemon-lifecycle.mjs`; authenticated status, rejection without auth, scoped CLI stop, clean exit and marker removal. Real local daemon process with scripted provider, not distributed failover |
| Candidate three-OS CI | Pending: source/build/compiled layer reports and packaged Desktop on Windows/Linux/macOS at the exact candidate SHA |
| All 40 modules functionally accepted | **Open**, see every module's [evidence and remaining acceptance requirement](LAYER_BEHAVIOR_MATRIX.md) |
| RC / full Nova rename / production rollout | **Open / not performed**; existing release gates remain |

Local pre-commit reports explicitly identify a dirty working tree based on the
base SHA, not an exact clean commit. CI writes clean source revision, platform,
version and case results to `layer-contract-qa-<os>` artifacts, including failed
runs. Source tests, compiled fixtures, actual process lifecycle and live external
service behavior are different evidence classes.

## Security-fix review record

The repair-boundary outcome is **fixed for the reproduced automatic mutation
and retry paths**, subject to the candidate gates above. Error text is data,
not authority. An independent read-only review found the sibling legacy registry;
its returned-error and exception paths were corrected and tested separately.
Original missing-directory and malicious package-string inputs no longer cause
writes or callback execution. Repeated explicit registry calls invoke a handler
once each; denied calls invoke none; successful calls preserve their result and
immutable final evidence. Alternate L0 pattern/wrapper and L8 callback signatures
are covered. No broad authorization-system audit or governed repair execution
acceptance is claimed.

Changed boundary files: `src/layers/L0-tool-autorepair.ts`,
`src/layers/L8-sub-agent.ts`, `src/tools/complete-registry.ts`,
`src/tools/registry.ts`. Regression tests use those real registry APIs and
isolated fixtures. The `fix-finding` review procedure influenced the scope by
requiring independent alternate-entry-point review, not just the first failing
example.

## Upgrade / recovery guide

Preserve existing user data and release backups. Old unscoped learning records
remain on disk, but scoped conversations cannot retrieve them. Do not assign
historical records to a user by guessing. Rollback to older code can reopen the
old isolation and automatic-repair defects; retain the failed/evidence reports
and prefer a corrected forward release after review.

An L0 repair proposal is not an entry approved in PATCH_GATE. Submit a separate
Kernel action with explicit scope and required checks; do not bypass policy or
call the handler directly. A failed compatibility L8 repair call is intentional
until a governed replacement is accepted. All advertised self-repair workflows
remain in RC scope.

Outstanding audit items include L8 tool/capability outcome-key alignment, L22
pagination/snapshot completeness, old orchestrator/ROI completion semantics,
approximate cost projections, broader learning retraction/isolation and visible
legacy persona/branding paths. The audit does not claim absence of remaining
high-priority defects. No production instance, credential or user memory was
changed or included in the public candidate.
