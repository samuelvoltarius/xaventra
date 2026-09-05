# Xaventra 2.78.0 verification record

## What each check proves

Local release candidate results (2026-09-05): **163 test files / 1,061 tests
passed**, four Desktop bridge tests passed, typecheck/build/catalogs/assurance
passed, and **8/8 real-model acceptance cases passed** at 19:58 UTC. The eight
native-runner durations ranged from 1.029 to 3.594 seconds (excluding per-process
bootstrap). This small suite is not a general task-success or speed guarantee.
A clean Windows export installed 583 packages with scripts disabled, compiled
and typechecked successfully; its CLI launched without the development worktree.
Source scan found no secrets. Hosted multi-OS CI status is reported separately.

| Check | Evidence boundary |
|---|---|
| Vitest regression suite | Typed contracts, gates, isolated stores, adapters and subsystem behavior; many dependencies are test doubles. |
| Desktop bridge tests | IPC identity, credential clearing and protected workspace paths; not packaged-app interaction. |
| Three-OS GitHub CI | Installation prerequisites, isolated tests, build and source gates on named hosted runners; not every GPU, distro or NAS. |
| `benchmark:full` | Deterministic isolated subsystem probes with an advisory planner. NOT autonomous completion of 100 real tasks. |
| `benchmark:acceptance` | Actual configured local model, native runner, real fixture reads, authenticated HTTP adapter, persisted sessions and fresh worker processes. |
| Live production takeover | Not performed in this source release; requires multiple nodes, real leases, channels and controlled interruption. |

The real-model suite uses eight cases: greeting, file read, REST file request,
two-file reasoning, remember, correct, recall after process restart, and isolation
from another user. Correct text alone cannot pass a file task: distinct successful
read evidence and kernel validation are required. Failed workers and nonzero exits
remain failures even if they wrote a plausible result first.

Reports are written under `.nova-data/benchmarks/agent-acceptance/`; private endpoint
addresses and raw transcripts are not published. Disposable worker artifacts stay
in an OS temporary directory. These are local-model runs, not paid cloud calls.
They do not train production routing or import production memory.

## Bugs exposed while adding the evidence

- Plural file requests could lose their tool pack and receive fictional textual
  tool calls. Intent-based file routing and regression tests now cover this.
- Native backend `completed` did not require successful kernel validation.
- User/room/bot session keys did not match raw transcript restore paths; restart
  lost context. Scoped atomic checkpoints now restore the same identity tuple.
- Late follow-up tools were executed without joining final Tool Evidence.
- Pruning the model-facing result also pruned the ledger copy.
- Task budgets and allow-lists were primarily post-checked; execution now gates
  every round before its effects.
- Native Windows setup could treat multiple Node locations as one executable.
- Malformed REST input could throw outside its error boundary.
- Forced worker exit exposed a Windows native async-handle teardown race; the
  harness must await normal shutdown rather than accept a written result as proof.

Early acceptance runs failed (5/7, then 6/7, then 7/8 after the HTTP case was added).
These are retained diagnostic results, not silently replaced claims of perfection.
Consult the final release/CI result for the exact current pass counts.

## Distribution boundary

The public source excludes personal deployment state. No production node is
updated by these checks. Signed native Desktop installers, full daemon/channel
acceptance, distributed mission takeover, GPU/native dependency matrices and
fair comparison runs against Hermes/OpenClaw remain separate gates. A version
number or a green unit suite does not establish those properties.

Use [platform setup](PLATFORMS.md), [issue triage](ISSUE_TRIAGE.md),
[the comparison](AGENT_COMPARISON.md) and [release checklist](PUBLIC_RELEASE_CHECKLIST.md).
