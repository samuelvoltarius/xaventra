# Reliability release loop

Every iteration: reproduce -> isolate -> fix -> regression -> real acceptance ->
document -> synchronized version bump -> scan -> push candidate -> CI -> main.
Preserve negative results. No mocked proof is substituted for live execution.

## Current bounded gates

### 2.78.13 goal and mission lifecycle candidate

The next coherent layer follow-up corrects a shared autonomy prerequisite:
explicit blocks no longer disappear during goal selection; paused/terminal
parents suppress child selection; paused native mission checkpoints are
restored rather than ignored. See [reproductions, tests and remaining
limits](VERIFICATION_2.78.13.md). These are behavioral changes, not a relabeling
of the 40-module matrix. Exact-commit CI is required before main promotion.
No RC acceptance or production rollout is implied.

Doctor findings now feed a durable bounded investigation through the existing
native Kernel path. Long prose is no longer execution proof. The separate
[repair acceptance boundary](AUTONOMOUS_REPAIR.md) explicitly keeps generic
sandbox candidate generation, activation and original-symptom recovery open.
The module matrix is not promoted to complete merely for adding this connection.
Initial connected-runtime commit `5b51bd926716a71dbc1afd5687fe587cf2cfdb84`
passed all seven jobs in [CI 34232476824](https://github.com/samuelvoltarius/xaventra/actions/runs/34232476824).
The subsequent diagnostic tool-scope narrowing and live-fixture shutdown fix
require their own green exact-revision CI before main promotion. The retained
live failures and bounded successful investigation are recorded in
[2.78.13 verification](VERIFICATION_2.78.13.md).

### 2.78.12 layer-contract candidate

All 40 modules are statically connected, but several have only getter/import
evidence for their main function. The [complete per-module matrix](LAYER_BEHAVIOR_MATRIX.md)
separates actual bounded assertions from smoke coverage and lists remaining
acceptance requirements. No service is declared production-ready solely from
its import graph or a passing aggregate score.

Reproduced L0/L8 hidden mutation/retry paths, L7/L17 learning attribution/user
mixing, Docker inspection intent, failure reflection/tracking and federated node
identity are addressed in this bounded candidate. See [versioned tests, review,
upgrade and open gates](VERIFICATION_2.78.12.md). Automatic governed repair,
full distributed convergence and the remaining Nova persona/UI migration are
still **open**; not removed or renamed away to obtain an RC. Exact candidate CI
must pass before updating main. No production deployment is part of this audit.

Runtime candidate `8eed1406835f0f65a3eae4ec77101e3056b0ba6b` passed all seven
jobs in [CI 34216930914](https://github.com/samuelvoltarius/xaventra/actions/runs/34216930914).
Exact-SHA clean compiled-layer artifacts: 8/8 on Windows, Linux and macOS.
The final documentation attestation requires its own green CI before promotion.

### Follow-up: real autonomy and GitHub self-update remain open

- [GitHub self-update contract](GITHUB_SELF_UPDATE_PLAN.md): `/update` currently
  sees the local installation, not a new trusted upstream release. Discovery,
  publisher verification and isolated staging must feed the single fenced
  updater; do not activate the separate in-place pull/rebuild route.
- GoalManager selects and persists goals, but `next()` currently feeds its
  prompt projection; the autonomous executor progresses an already-created
  mission. There is no demonstrated complete ready-goal-to-governed-worker
  dispatcher for arbitrary persisted goals.
- The background autonomy loop still turns active mission state into synthetic
  prompts while the mission executor has its own step timers. Prove one owner,
  one execution key and one dispatch per action, including timeout/cancellation;
  a timed-out Promise must not leave an old write running alongside its retry.
- 2.78.13 distinguishes explicit/legacy blocks from dependency-generated blocks,
  fixing the reproduced implicit blocked-to-active transition. Rich structured
  missing-input/policy/permission/budget/resource reasons and their governed
  resolution workflows remain open; an explicit state update is not itself
  proof of operator permission or a fresh lease.
- Route safe observation/diagnosis through typed tools automatically within an
  explicit autonomy policy. For reversible writes require scope, budget and
  post-validation; higher-risk operations retain approval. Provider discovery
  should inform a proposal, never itself authorize software installation.
- Acceptance must show event -> scoped goal -> one claimed action -> Kernel ->
  independent evidence -> checkpoint -> next action, plus stop, restart,
  duplicate-event and user-isolation negatives. Background greetings, module
  imports and stored goal objects are not evidence of that closed loop.

These are source-grounded follow-up findings/design requirements, not features
implemented or production autonomy enabled by the 2.78.12 bounded layer fix.

### 2.78.11 predecessor

Startup PID reuse, Telegram starter concurrency and grounded identity/capability
answers were verified from base `221930cb3ed2faf345d80ed6be4631255eca79b0`.
Candidate `5b1fe9a7f19929d95dbb3b0ec2cf250545bc088d` passed all seven jobs
in [CI 34209431042](https://github.com/samuelvoltarius/xaventra/actions/runs/34209431042).
See [separate evidence and open gates](VERIFICATION_2.78.11.md). No RC label,
automatic production rollout or closed distributed-failover gate is implied.

1. Core source installs from a clean checkout on Windows, Linux and macOS.
2. Local model chooses real tools and returns the observed result.
3. HTTP ingress authenticates, handles malformed requests and reaches execution.
4. Scoped conversation memory survives process restart, correction and reset.
5. Policy, allow-lists, budgets and evidence apply to every execution round.
6. Native Desktop packages build and are smoke-tested on each advertised OS.
7. Full daemon startup/shutdown and channel dispatch are tested without touching
   production state; live Telegram delivery is a separately credentialed check.
8. Multi-node lease, task takeover and memory convergence are proven in controlled
   failure tests; local subsystem probes alone do not close this gate.
9. Comparable, artifact-verified tasks run against reference agents before any
   claims about better completion, speed or autonomy.
10. Signed binary releases, checksums and install/rollback instructions precede
    broad consumer binary distribution.

No automatic production rollout, token replication, unreviewed third-party code
execution or weakened approval gate is permitted to make these checks green.
Unavailable hardware, signing identities or service credentials remain explicit
external prerequisites, not invented successes.

## Evidence-linked RC inventory

Status: **not RC-ready**. A bounded pass closes only the stated checks, not the
whole advertised product. `2.78.2` below means commit
`f300d1a04bca42072618677ff4115e727a870072`, with
[candidate CI](https://github.com/samuelvoltarius/xaventra/actions/runs/33993416173)
and [main CI](https://github.com/samuelvoltarius/xaventra/actions/runs/33993649700).
For the current revision, exact-commit CI reports are mandatory before main moves;
Desktop reports identify their `sourceRevision`, OS and package version.

### 2.78.10 Doctor grounding checkpoint

Neutral typed input replaces fabricated runtime errors. Generic diagnosis accepts
informational proposals only, and L15 no longer turns a diagnosis into successful
repair memory or resets tool/silence failures without evidence. The original
14-case Doctor quality baseline and all negative reports are retained, plus four
new authored controls. Source/compiled API regression is separate from native
GGUF quality, which remains open. Runtime `8f5d70a959660183d80cc5b8efdb75210d1af1bc`
passed all seven jobs in [CI 34050162854](https://github.com/samuelvoltarius/xaventra/actions/runs/34050162854).
Downloaded clean exact-SHA reports confirm API 15/15 and artifacts 5/5 on each
OS. Core: 185 files / 1250 tests; bridge: 7/7. A documentation attestation still
needs exact-SHA CI before promotion; see [verification and limits](VERIFICATION_2.78.10.md).
No retraining, production rollout or RC label follows from this bounded fix.
Native Windows Vulkan runs improved the unchanged baseline to 10/14 for both
0.5B and 1.5B, with additional controls 2/4 and 3/4 respectively. These are
pre-final-guard dirty-tree runs, not clean final-SHA model acceptance. Unsafe
log-derived prose was reproduced and received a bounded rejection guard; uncertain
and other semantic answers remain an open Doctor gate, with failed evidence kept.
Separate clean runtime API smoke: 1.5B 2/2, 0.5B 1/2 on two attempts. The small
model still invents a configuration premise and firewall advice on refused
connections. Do not confuse improved aggregate fixtures with full acceptance.

### 2.78.9 environment-awareness and host-boundary checkpoint

Current graph reads replace boot-only inventory in chat/capability tools. Setup
distinguishes installed from usable runtimes and preserves model/endpoint pairs.
Known-host metadata no longer claims admin authority. New plaintext password
writes are rejected; legacy files require explicit migration and are not changed.
Runtime commit `3deb16dc05da68cb9b0ff3e125bfbb9790fc5a10` passed all seven jobs in
[candidate CI 34046228875](https://github.com/samuelvoltarius/xaventra/actions/runs/34046228875).
Downloaded clean exact-SHA reports confirm 10/10 compiled inventory/host cases
on all three OSes. Core regression is 184 files / 1227 tests; seven bridge tests,
packaged Desktop and isolated lifecycle checks pass. Source, compiled synthetic
input, actual process restart and live deployment are separate evidence classes.
The documentation attestation also requires exact candidate-SHA CI before promotion;
see [2.78.9 verification](VERIFICATION_2.78.9.md) and
[discovery/credential recovery guide](ENVIRONMENT_DISCOVERY.md).

The broader environment/install acceptance and SSH execution risk matrix remain
open. A bounded storage/prompt fix is not a full SSH security audit or an RC.
The approved next improvement packages remain: grounded Doctor diagnosis before
retraining, scoped/correctable memory, verified duplicate-safe tools/resume,
measured low-latency decisions with cumulative budgets, and outcome-only learning.

### 2.78.8 bounded Doctor validation checkpoint

The empty-review/empty-fix, initialization and invented credential-request
failures are reproduced and fixed with new source tests plus nine compiled API
cases. Guarded runtime commit `1cccf74860996f092be7341ff0dcee8e76808409`
passed all seven jobs in [candidate CI 34040574609](https://github.com/samuelvoltarius/xaventra/actions/runs/34040574609).
Downloaded exact-revision reports confirm 9/9 scripted compiled API and 5/5
artifact cases on Windows, Linux and macOS, separate from native model quality.
All 1191 Core tests, lifecycle/response and packaged Desktop checks pass. This
documentation attestation also needs exact-SHA green CI before main promotion.
See the separate
[source/API and native model-quality record](VERIFICATION_2.78.8.md).

Doctor quality remains **open**: the real 0.5B Q5_K_M run passed all checks in only
1/14 authored synthetic cases despite 14/14 schema-valid responses. Unsupported
configuration proposals, uncertainty and healthy controls need more work. The
1.5B comparison passed 5/14 overall and exposed the credential-request defect.
Case-level sanitized reports retain the pre-guard results explicitly. The
schema/parser/oracle measures are separate, not a general agent benchmark.
Known negative reports remain retained. No retraining, weight publication,
production rollout or RC label is part of this source change.

### 2.78.6 acceptance checkpoint — 2026-09-06

Runtime/source commit `933edc45ffc9cff50e10017a54134d03439c79c6` passed all seven
jobs in [candidate CI 34029584042](https://github.com/samuelvoltarius/xaventra/actions/runs/34029584042).
This includes clean source installs, 1132 Core tests, compiled lifecycle, nine
new response-contract/API cases and packaged Desktop checks on all three OSes.
Hosted provider responses are scripted, not live-model claims. Separate Windows
real-provider native/REST acceptance passed 8/8 on this commit at 11:13 UTC,
with the original checks/exclusions intact. See [scope and reproduction](VERIFICATION_2.78.6.md).
Any subsequent documentation-only attestation must also pass exact-commit CI
before main promotion. No full RC label, binary publication or production deploy.

| Gate | Status | Evidence / missing acceptance |
|---|---|---|
| Clean installs and upgrades | Partial | 2.78.2 clean CI source installs on three OSes; full native installer/update acceptance outstanding. |
| Real model and tools | Partial | [2.78.6 native/REST 8/8 and response-contract regression](VERIFICATION_2.78.6.md); prior [2.78.5 full-daemon/Desktop 6/6](VERIFICATION_2.78.5.md). The retained 7/8 negative is not erased. Neither is a 100-task product score. |
| Authenticated HTTP ingress | Bounded pass | 2.78.2 actual daemon authenticated status and unauthenticated rejection, plus ingress regressions. |
| Memory/correction/reset/resume | Partial | Scoped restart recall, cross-user isolation and bounded explicit correction-response enforcement pass in 2.78.6; general instruction handling and complete native/distributed mission resume remain outstanding. |
| Policy, validation and evidence | Partial | Core release regressions and real file-tool evidence; full advertised workflow/risk matrix outstanding. |
| Packaged Desktop | Partial | [2.78.5 full daemon and restart](VERIFICATION_2.78.5.md), scripted cross-platform checks plus separate real local-provider Windows run. Exact-commit CI reports required; native dialogs/capture/installers remain open. |
| Daemon and channels | Partial | [2.78.2 compiled lifecycle on all three OSes](VERIFICATION_2.78.2.md); separately credentialed live channel delivery outstanding. |
| Distributed HA and memory convergence | Open | Requires controlled multi-node partitions, fencing, takeover and reconciliation; subsystem probes do not suffice. |
| Critical/high release defect closure | Open | The response-contract defect is reproduced and fixed; the full advertised risk matrix, cumulative budget/fallback attribution and distributed failure paths are not yet accepted. No blanket absence-of-high-risk-defects claim. |
| Recovery and upgrade documentation | Partial | Versioned source reproduction/rollback guidance exists; native installer recovery, actual upgrade/rollback and distributed recovery procedures need matching live evidence. |
| Reference-agent comparison | Open if claimed | No parity/superiority claim without matched tasks, budgets and independently checked artifacts. |
| Signed installers and recovery | Open / external prerequisites | Signing identities/notarization plus actual install/update/rollback acceptance and checksums outstanding. |

Next useful rounds: cumulative usage and inference attribution; native dialogs/capture and installer acceptance; typed
inference-host attribution across fallback; controlled distributed failure and
mission-resume tests. Do not remove advertised features to make the table
green. Unavailable credentials/signing may block individual gates, not all safe
engineering work.

### 2.78.7 bounded Doctor candidate

Runtime commit `6262799052ada50a78c924a403236b37915951c3` passed all seven jobs
in [candidate CI 34035690597](https://github.com/samuelvoltarius/xaventra/actions/runs/34035690597).
Downloaded three-platform Doctor reports confirm 5/5 compiled cases and the exact
clean source revision. Native model quality stays open: both 0.5B and 1.5B showed
unfounded diagnoses in the separate local smoke. The observed failures now fail
closed; this is not broad semantic or self-repair acceptance. Any documentation
attestation also requires exact-commit green CI before main promotion.

[Doctor delivery/runtime verification](VERIFICATION_2.78.7.md) separates artifact
integrity/configuration fixtures from actual GGUF diagnosis quality. The retained
0.5B invented-port/provider response is an open quality failure, not a passing
benchmark. Delivery, integrity and fail-closed handling can be fixed without
claiming the weights are fully qualified. Candidate exact-SHA three-OS CI must
pass before main promotion. No production, weights or RC publication authorized.
