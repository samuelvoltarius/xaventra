# Layer/service behavioral evidence — 2.78.12

## What the count means

`npm run check:layer-graph` follows literal local imports/exports and dynamic
imports from daemon, CLI and boot using the TypeScript AST. All **40** non-test
modules directly in `src/layers` are reachable. This proves neither runtime
activation nor correctness: branches, disabled services and compatibility APIs
remain reachable. Computed imports are outside this static check.

`npm run check:layers` is an import/export smoke, not an execution benchmark.
The matrix below distinguishes **B** (a bounded behavior asserted with fixtures)
from **S** (only shape, getter, formatter or import evidence for the main job).
Neither class means the whole module is accepted. Every row still has an open
production or semantic acceptance requirement. Other Core tests may cover
related subsystems; their results must not be attributed to this legacy module
without tracing its actual caller.

Test abbreviations (repository-relative, all fixtures isolated):

- **T**: `src/layers/layers.test.ts`
- **E**: `src/layers/layers-extended.test.ts`
- Named tests below are in `src/layers/`, unless otherwise specified.

## All 40 modules

| Module (`src/layers/`) | Class / executed assertion | Test evidence | Still open / important limit |
| --- | --- | --- | --- |
| L0-health-monitor.ts | B: RAM/disk values; threshold semantics | T; L0-health-monitor.test.ts | Real cross-node alert delivery, dedupe and actionable diagnosis |
| L0-self-repair.ts | B: classify import/type errors and suggest known fixes | E, L0 Self-Repair | Suggestion is not execution; sandbox, regression, rollback and approval end-to-end |
| L0-supervisor.ts | B: empty/wrong-persona response handling | T, L0 Supervisor | Legacy persona enforcement still contains Nova; semantic correctness and complete rename open |
| L0-tool-autorepair.ts | B: missing-file/package errors cannot mutate or retry; successful control preserved | L0-tool-autorepair.test.ts; src/tools/registry-repair-boundary.test.ts | Diagnostic metadata is not a persisted/approved patch; governed recovery workflow still required |
| L03-core-runtime.ts | B: actual MessageBus delivery and queue operations | E, L03 Core Runtime | Concurrent state transitions, restart and authority across services |
| L10-vision.ts | S: constructors and issue/severity formatting | E, L10 Vision | Real model/image analysis and validated follow-up action |
| L11-project-manager.ts | B: create project and select active project | E, L11 Project Manager | Complete project lifecycle, concurrent users and restart |
| L12-anti-hallucination.ts | B: reject failed-tool success claims, preserve honest controls | T, L12 Anti-Hallucination | Heuristics are not a semantic truth guarantee; all output channels |
| L12-qa-agent.ts | S: framework detection and getter | E, L12 QA Agent | Generate and actually execute useful tests in a governed sandbox |
| L13-ast-analyzer.ts | S: repository map shape | E, L13 AST Analyzer | Exact symbols/edges against semantic fixtures and large projects |
| L14-cost-tracker.ts | B: recorded usage and budget-warning threshold | T, L14 Cost Tracker | Pipeline still has estimated tokens/cost and parallel accounting; exact cumulative attribution open |
| L15-security-scanner.ts | S: scanner/report shape | E, L15 Security Scanner | Known vulnerable/safe fixtures, false positives and governed remediation |
| L15-self-check.ts | B: registry failures remain degraded, no diagnosis-based success reset | T; src/tools/registry-repair-boundary.test.ts | Real health recovery evidence and complete Doctor integration |
| L16-business-sense.ts | S: request-analysis shape | E, L16 Business Sense | Decision quality, false assumptions and measurable outcomes |
| L17-autonomous-learning.ts | B: sequential requests keep their own result; user-scoped recall | learning-isolation.test.ts; E | Old session APIs and complete provenance/retraction lifecycle; unscoped data must not be reassigned by guessing |
| L18-llm-router.ts | B: task classification, vision preference and single-model cases | T, L18 LLM Router | Live per-user/node routing, cumulative failover budgets and validated training samples |
| L19-monitoring.ts | B: add/list targets | E, L19 Monitoring | Actual outages, recovery, duplicate notifications and authenticated target scope |
| L20-self-improvement.ts | B: explicit rule/context storage and retrieval | E, L20 Self-Improvement | Independently validated improvements, approval and rollback quality |
| L21-node-health.ts | S: manager/health formatting | E, L21 Node Health | Real partition, fencing and task takeover; not proved by heartbeat formatting |
| L22-federated-memory.ts | B: canonical configured ID wins over persisted legacy alias | runtime-evidence.test.ts; E | Snapshot cap/pagination, tombstones, principal isolation and full convergence |
| L23-instincts.ts | B: insert and include strong instincts in prompt | T, L23 Instincts | Outcome quality, scoped provenance and precise decay/retraction |
| L24-prompt-optimizer.ts | B: unknown section locked; repeated issue count | E, L24 Prompt Optimizer | Real optimization, regression gate and safe promotion |
| L6-cold-storage.ts | S: files/context return strings | T, L6 Cold Storage | Real scoped read/write/correction/reset, not just return type |
| L6-core-facts.ts | B: add, dedupe, remove and cap facts | T, L6 Core Facts | User separation, conflict/provenance and all consuming prompts |
| L6-session-summary.ts | B: bounded asynchronous model summary and token math | L6-session-summary.test.ts; E | Real long sessions, semantic accuracy and cross-node resume |
| L7-learning.ts | B: record/find corrections, unrelated control | T, L7 Learning Correction Context | Tenant-safe lifecycle and independently useful synthesized skills |
| L7-tool-learning.ts | B: scoped examples/corrections, persistence reload and wrong-user rejection | learning-isolation.test.ts; E | Legacy unscoped inventory remains; full forget/retraction across derived stores |
| L8-meta-learning.ts | S: capability map and solution getters | E, L8 Meta-Learning | Coordinator records tool names while capabilities are keyed separately; outcome mapping and execution proof open |
| L8-prisma-guards.ts | B: destructive SQL blocked, SELECT allowed, casual confirmation rejected | E, L8 Prisma Guards | Actual database execution and transaction/recovery boundaries |
| L8-sub-agent.ts | B: both callback signatures and automatic fallback fail closed | L8-repair-authority.test.ts; E | Legacy API cannot express Kernel authority; actual governed research/repair remains unaccepted, not silently removed from scope |
| L9-idle-learning.ts | S: getters and activity notification | E, L9 Idle Learning | Useful learning from real evidence with budget and user separation |
| auto-bug-fix.ts | S: exported function/init/stats | E, Auto Bug Fix | Real reproducible defect to sandbox patch, approval and rollback |
| dream-daily-digest.ts | B: add/build/mark-sent round trip | E, Dream Daily Digest | Real delivery, dedupe, principal isolation and no internal-reasoning leaks |
| memory-distiller.ts | S: import and model setter/getter | E, Memory Distiller | Actual curated facts, contradiction/correction, isolation and replay |
| multi-bot.ts | S: templates/list/constructor | E, Multi-Bot Manager | Real selected-specialist team run without duplicate replies |
| multi-user-workers.ts | S: constructor/stats/singleton | E, Multi-User Workers | Concurrent users, cancellation, bounded queue and no cross-talk |
| predictive-provisioning.ts | S: usage recording and prediction shape | E, Predictive Provisioning | Useful predictions and authorized install/deploy with rollback |
| subconscious-reflector.ts | S: init/state/activity | E, Subconscious Reflector | Useful evidence-grounded reflection, notification budget and privacy |
| vibe-regler.ts | B: activity changes scheduling category | E, Vibe Regler | Long-running event/budget behavior and useful user experience |
| vram-manager.ts | B: hardware/resource decisions using mocked hardware | vram-manager.test.ts; E | Real heterogeneous GPU contention, eviction and model recovery |

## Cross-module regressions fixed in this candidate

Before correction, the Docker inspection request did not require a tool, a
generic failed answer was accepted by reflection, a second learned outcome was
attached to the first request, and a read failure could create a directory.
New fixtures assert the expected behavior; the two learning cases were also
executed before the patch and failed. Cross-user example retrieval is now
filtered before exact/fuzzy matching, including after disk reload.

The shared complete registry and the legacy registry both previously started
hidden retry paths. Tests now assert one handler invocation per explicit call,
even after repeated returned/thrown errors, and preserve denial/success controls.
The independent boundary review found the second registry; its concrete finding
was addressed and both L8 public callback forms are tested separately.

L0 returns `requires-governed-plan`, `executed: false`, `requiresApproval: true`.
That metadata **does not** queue an approved patch. Callers must create a new
scoped Kernel task and satisfy policy, sandbox/regression, rollback and approval.
Do not teach the model that an error, a cached suggestion or a repair count
grants permission to install software or repeat external actions.

## Migration and release limits

The Nova-to-Xaventra migration is **not complete**. Deterministic identity and
welcome commands were corrected in 2.78.11, but legacy supervisor persona,
default bot/soul prompts and some Desktop labels remain to be checked together.
Compatibility environment names, data paths, tool IDs and old config fallback
must not be bulk-renamed: that can orphan data or break existing installations.

No live external LLM, production node, Telegram bot or database was changed by
this layer audit. Windows source tests and compiled lifecycle are separate from
three-platform CI, packaged Desktop tests and real distributed acceptance.
See [versioned verification](VERIFICATION_2.78.12.md) and
[remaining RC gates](RELEASE_PLAN.md).
