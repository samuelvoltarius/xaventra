# Reliability release loop

Every iteration: reproduce -> isolate -> fix -> regression -> real acceptance ->
document -> synchronized version bump -> scan -> push candidate -> CI -> main.
Preserve negative results. No mocked proof is substituted for live execution.

## Current bounded gates

### 2.78.36 interrupted Doctor proposal candidate

- Doctor proposals now persist an integrity-bound correlation to the failure
  case, candidate run and exact observed revision. A fresh process can reattach
  the already sandboxed proposal after interruption, but only when one exact
  match retains complete reproduction, regression, cleanup, rollback and
  recovery evidence plus the unchanged operator profile.
- Reconciliation performs no model rerun, patch application, approval or
  production activation. It stops at `PATCH_GATE`; ambiguous, incomplete and
  tampered state remains in the generating state for explicit investigation.
- Source regressions and the disposable Docker acceptance are recorded in
  [the candidate record](VERIFICATION_2.78.36.md). Candidate
  `feb7de5f52f85aaa10276cf76abc6c5f9e7245c1` passed all ten jobs in
  [CI 35527631017](https://github.com/samuelvoltarius/xaventra/actions/runs/35527631017),
  including real Docker sandbox, rollback and recovery. The complete 102-commit
  public history (10.83 MB) has zero Gitleaks 8.30.1 findings. No production
  node changed. Evidence-commit CI remains required.

### 2.78.35 principal-scoped Outcome Router candidate

- The canonical Learning Coordinator now admits only Execution-Kernel-validated,
  evidence-bearing outcomes into a durable principal-scoped routing projection.
  Benchmark, fixture, synthetic, response-only, anonymous and cross-user data
  cannot unlock routing; invalidation tombstones the derived sample.
- Source regressions and a compiled two-process restart acceptance are recorded
  in [the candidate record](VERIFICATION_2.78.35.md). Candidate
  `4ffc87bd6d1f83426eafcfad1f282222690721fe` passed all ten jobs in
  [CI 35522284891](https://github.com/samuelvoltarius/xaventra/actions/runs/35522284891),
  including Windows, Linux and macOS compiled acceptance. The complete
  100-commit public history (10.82 MB) has zero Gitleaks 8.30.1 findings. No
  production node or active routing mode changed. Evidence-commit CI remains
  required.

### 2.78.34 distributed capability convergence candidate

- Capability snapshots now reconcile each runtime independently. Delayed node
  snapshots therefore cannot replace newer runtime evidence or discard a
  concurrently observed runtime merely because their node timestamp differs.
- Tombstones suppress observations at or before removal, survive restart and
  still permit a genuinely later verified restart/reinstall. Replication strips
  credential-bearing fields and URL components while retaining booleans such
  as `available` and `authenticated`.
- Source regressions and a compiled multi-process acceptance are recorded in
  [the candidate record](VERIFICATION_2.78.34.md). This is isolated fixture
  evidence, not a physical-node partition, production provider-auth probe or
  live Mesh transport claim. Candidate `f53b2805d8bac6ee2fbc558717770de271493e13`
  passed all ten jobs in
  [CI 35516002178](https://github.com/samuelvoltarius/xaventra/actions/runs/35516002178),
  including Windows, Linux and macOS compiled acceptance. The complete
  98-commit public history (10.78 MB) has zero Gitleaks 8.30.1 findings. No
  production node changed. Evidence-commit CI remains required.

### 2.78.33 truth-layer memory convergence candidate

- Governed memory now orders each scoped semantic key with a monotonic
  lifecycle generation. Terminal states remain authoritative over same- or
  older-generation active records even when a stale node reports a later wall
  clock.
- A reset remains isolated to its user. A disconnected correction cannot revive
  that user's fact, while another user's fact remains available. Deliberate
  post-reset re-entry requires explicit high-authority evidence, a direct
  supersession link and a newer generation.
- Source regressions and a compiled five-process acceptance are recorded in
  [the candidate record](VERIFICATION_2.78.33.md). Runtime
  `482788be94d5025e53956ff98689cada3e6c9ccc` passed all ten jobs in
  [CI 35510934212](https://github.com/samuelvoltarius/xaventra/actions/runs/35510934212),
  including the convergence acceptance on Windows, Linux and macOS. The full
  96-commit public history (10.76 MB) has zero Gitleaks 8.30.1 findings. The
  acceptance uses isolated local durable stores; it is not a physical-host
  partition, live Mesh/channel or production proof. No production node changed.
  The evidence attestation still requires exact-commit CI before promotion.

### 2.78.32 managed runtime handoff candidate

- Daemon shutdown now reads optional identity markers without an
  `exists`/`read` race. A marker that disappears during the authenticated stop
  is normal; malformed, oversized, mismatched or replacement identities remain
  hard failures.
- Managed repair accepts candidate readiness only when `.nova.pid` and the
  authenticated control record identify the same spawned process and runtime
  root. Rollback restarts the approved prior release when shutdown started
  before the durable release pointer advanced, instead of misreporting a CAS
  loss.
- Source and Windows regressions are recorded in
  [the candidate record](VERIFICATION_2.78.32.md). Disposable Linux
  root-controller/non-root-runtime acceptance passed on the first hosted run.
  That run exposed a separate packaged Linux Desktop failure in Electron's
  global Undici fetch path. Corrected runtime `e915421f8353015a106ca05d1b04de190a673c25`
  uses bounded native Node HTTP/HTTPS and passed all ten jobs in
  [CI 35503318716](https://github.com/samuelvoltarius/xaventra/actions/runs/35503318716),
  including packaged Linux setup-to-chat, isolated-Core and full-daemon restart
  acceptance under Xvfb. Public-history Gitleaks: 94 commits, 10.74 MB, zero
  findings. The evidence commit and its exact CI remain required before normal
  promotion. No production node changed.

### 2.78.31 live witness checkpoint candidate

- Native mission checkpoints can now use three independently authenticated
  witness endpoints as both lease and checkpoint authority. Two witnesses must
  accept the exact node and epoch before a checkpoint is stored; reads require
  two matching payload hashes under the successor's current epoch.
- The compiled acceptance starts three disposable HTTP witness services and
  isolated predecessor, successor and stale-writer Node processes. The
  predecessor publishes one verified tool receipt and idempotency result,
  exits, the successor acquires epoch 2 and resumes without a duplicate effect,
  and the stale predecessor's external write is rejected.
- This is real loopback HTTP coordination with separate durable witness state,
  not production Supabase, a physical-host loss or a network-partition proof.
  Runtime `ac137f7f540a0b3a2bdc8dabbd5dda20f263342b` passes all ten jobs in
  [CI 35493191935](https://github.com/samuelvoltarius/xaventra/actions/runs/35493191935).
  The complete 91-commit public history has zero Gitleaks 8.30.1 findings. No
  production node changed. Exact evidence is recorded in
  [the candidate record](VERIFICATION_2.78.31.md); its attestation still needs
  exact-commit CI before promotion.

### 2.78.30 fenced native successor candidate

- Completed native idempotency records and their verified Kernel receipts are
  now mirrored through encrypted HA state. Publication and import require a
  freshly revalidated, exact mission fencing token; the successor binds the
  same scope, user, channel and TaskContract and never overwrites conflicting
  local truth.
- Isolated Windows source evidence: typecheck/build pass, focused regressions
  pass **13/13**, and a compiled three-process acceptance reports one effect,
  successful epoch-2 successor reconstruction, stale epoch rejection and no
  duplicate effect. The full Core regression passes **228 files / 1,558 tests**.
  The first exact hosted run exposed a missing clean-runner artifact directory;
  that evidence bug is fixed and retained here. Corrected runtime
  `97d77d992236adc6351dd294793e3b3c718fda7a` passes all ten jobs in
  [CI 35488674079](https://github.com/samuelvoltarius/xaventra/actions/runs/35488674079),
  including the takeover acceptance on Windows, Linux and macOS. The full
  public history has 89 commits and zero Gitleaks 8.30.1 findings. This evidence
  attestation still needs its own exact-commit CI before promotion.
- The process acceptance uses a file-backed fixture authority. It is not a live
  Supabase/witness, network-partition or physical-node test. Production remains
  unchanged, and controlled live Mesh takeover is still open.
  [Contract](TOOL_EVIDENCE.md), [candidate record](VERIFICATION_2.78.30.md).

### 2.78.29 durable native receipt candidate

- The authoritative native runner now persists a verified tool receipt at the
  moment the Execution Kernel accepts it. The receipt contains no raw arguments,
  credentials or duplicated result; it binds hashes and identity to the durable
  idempotency record and to an exact reconstructed TaskContract.
- Reconstruction accepts only the same mission scope, principal, channel,
  allowed contract and independently completed result. A changed durable result,
  different user or duplicate receipt fails closed. The Outcome Ledger records
  every completed idempotency key as a restart checkpoint.
- Isolated Windows source evidence: typecheck/build pass, focused receipt and
  authorization regressions pass **9/9**, full Core regression passes **227
  files / 1,555 tests**, and a compiled two-process acceptance reports one real
  effect, one rehydrated receipt and zero duplicate effects. Exact runtime
  `70f1992513e5b4109553dc568608ede81504a02a` passes all ten jobs in
  [CI 35484065866](https://github.com/samuelvoltarius/xaventra/actions/runs/35484065866).
  The compiled two-process acceptance passes separately on hosted Windows,
  Linux and macOS. The full public history has 86 commits and zero Gitleaks
  8.30.1 findings. This evidence attestation still needs its own exact-commit CI
  before promotion.
- This closes process-restart rehydration for stable native mission scopes only.
  Replication of idempotency records/receipts to a fenced successor, controlled
  node takeover and live production proof remain open. No production node was
  changed. [Contract](TOOL_EVIDENCE.md), [candidate record](VERIFICATION_2.78.29.md).

### 2.78.28 verified missing-resource recovery candidate

- The native runner now treats a missing read-only resource as a typed recovery
  case rather than asking a model to improvise. It performs at most one governed
  discovery and one retry, and only selects a unique exact or high-confidence
  filename candidate.
- The Execution Kernel records the verified discovery call and binds the resolved
  path to the originally requested target. A forged alias, changed discovery
  payload, duplicate candidate or filesystem-root scan fails closed.
- Focused recovery/Kernel/contract tests pass **24/24**, typecheck passes and the
  complete clean-lockfile Core regression passes **226 files / 1,553 tests**
  with four workers. Build, generated catalogs, static layer graph and runtime
  loading pass; the packaged Windows Desktop passes **5/5** isolated Core checks.
  Exact runtime `1630b0a2e83174afa553ebd2a67a9c870cc0a33f` passes all ten jobs
  in [CI 35479444924](https://github.com/samuelvoltarius/xaventra/actions/runs/35479444924),
  including Windows/Linux/macOS verification, packaged Desktop and all three
  repair jobs. The full public history has 84 commits and zero Gitleaks 8.30.1
  findings. This documentation attestation still needs its own exact-commit CI
  before promotion.
- This closes only deterministic missing-file recovery. Durable native receipt
  hydration/resume, general error research, memory correction completeness,
  controlled HA and remaining RC gates stay open. No production node changed.
  [Evidence contract](TOOL_EVIDENCE.md), [candidate record](VERIFICATION_2.78.28.md).

### 2.78.27 adaptive local-reasoning candidate

- Fast chat and every tool-bearing model turn now request non-thinking mode;
  complex text-only analysis retains the deterministic low/medium/high effort
  selected by the existing cognitive policy. No second orchestrator was added.
- vLLM reasoning metadata remains protected and a reasoning-only result is
  distinguished from endpoint failure. A reasoning-enabled request may recover
  once through the same cumulative inference budget with reasoning disabled.
- Actual compiled-client Spark evidence: identical exact-answer prompt at
  `max_tokens=128` completed in **405ms / 4 output tokens** with reasoning off,
  versus **1,085ms / 20 output tokens** at low effort. A separate non-thinking
  required-tool request produced a structured `health_status` call in **1,183ms** with no
  exposed reasoning. These are LAN model checks, not production Telegram proof.
- Targeted policy/provider tests **10/10**, typecheck, build, current catalogs
  and Desktop **7/7** pass locally. Full Core regression passes **225 files /
  1,546 tests**. Runtime `f892f77579e3c1f0e75af74132ec556e11789c4e`
  passes all ten jobs in
  [CI 35463459896](https://github.com/samuelvoltarius/xaventra/actions/runs/35463459896),
  including Windows/Linux/macOS verify and packaged Desktop smoke. The prior
  Windows failure exposed and now guards a hanging Python launcher alias. Final
  documentation promotion and production adoption remain required. [Policy](REASONING_POLICY.md),
  [evidence](VERIFICATION_2.78.27.md).

### 2.78.26 correlated tool-evidence candidate

- Runtime now records unique call receipts with canonical argument/result hashes
  and matched explicit targets. Duplicate or uncorrelated success cannot satisfy
  the Kernel's verified-tool criterion.
- Explicit file targets and web URLs in the current request are conjunctive: every target
  must occur in verified execution arguments. Machine-comparable targets only;
  vague semantic destinations remain an open gate.
- Local Windows regression: **224 files / 1,540 tests**. Compiled native fixture
  **7/7**, including an intentional partial two-file execution rejected despite
  one successful read. The first candidate passed live local Qwen **2/2** with
  disposable files. The final-commit Tailnet recheck was blocked because Tailscale
  on the Windows caller was stopped; a later LAN probe proved Spark/vLLM healthy.
  That later probe is recorded under 2.78.27, not retroactively counted as the
  2.78.26 final-SHA acceptance.
- The first exact candidate CI failed closed: all three hosted platforms exposed
  missing Unix-path intent classification in the partial two-file case, and the
  legacy dashboard audit hit npm's retired quick-tree endpoint. A first follow-up
  then exposed a greedy unquoted Unix-path matcher. All three causes now have
  bounded regressions. Runtime `2c272121f8c727587bf0fe91db5c67fe4e5b4ce7`
  passes all ten jobs in
  [CI 35459501394](https://github.com/samuelvoltarius/xaventra/actions/runs/35459501394).
  Downloaded exact-SHA clean-source reports pass the native fixture **7/7** on
  Windows, Linux and macOS. This documentation promotion still requires its own
  exact-commit green CI before main.
  No production node was changed. Missing-file recovery, durable evidence across
  distributed resume, complete memory correction and all previous RC gates remain
  open. [Contract and limits](TOOL_EVIDENCE.md), [evidence](VERIFICATION_2.78.26.md).

### 2.78.25 native tool-budget candidate

- Reproduced and corrected: prompt/output budget confusion and missing native
  follow-up/recovery usage. Distinct generation and total ceilings, per-run shared
  accounting and pre-effect rejection of over-budget model replies implemented.
- Working-tree live local-model acceptance: **passed, 2/2**, real disposable reads
  with validated final output. Not production Telegram or full CLI/Desktop proof.
- Windows regression: **passed, 224 files / 1,533 tests**; six-case compiled fixture,
  REST response contract 5/5 and Desktop bridge 7/7: **passed**. Runtime candidate
  `0114c6492fc6dc2cf7d2c854b0d53d017a72daea`: **all ten CI jobs passed** in
  [CI35451427942](https://github.com/samuelvoltarius/xaventra/actions/runs/35451427942).
  Downloaded exact-SHA reports confirm six native tool-budget checks on each of
  Windows/Linux/macOS and Docker repair7/7. An actual isolated Windows CLI/Qwen
  read also returned the unknown canary, with successful ledger validation.
  Documentation promotion still requires its own exact-commit green CI.
- Provider follow-up: reproduced dropped Claude usage and local-fallback
  tool-correlation/options. Corrected with two additional regressions; local
  **224 files / 1,535 tests** and repeated native fixture6/6/live-Qwen2/2 pass.
  Runtime `32d52318eb7c8032a7bf88eb5c673ee533b5b5f5` passes all ten jobs in
  [CI35452294901](https://github.com/samuelvoltarius/xaventra/actions/runs/35452294901).
  Downloaded clean exact-SHA Windows/Linux/macOS reports each pass 6/6.
  Clean committed runtime also passes live Qwen 2/2 and an actual isolated
  interactive CLI read with exact unknown-canary output and normal exit.
  Final documentation promotion still requires its own exact-commit green CI.
- General tool/action-target validation, missing-data recovery, complete memory
  correction and distributed resume remain **open**. Earlier gates are unchanged.
  [Evidence and failures](VERIFICATION_2.78.25.md), [operator guide](TOOL_BUDGETS.md).

### 2.78.24 discovery-noise candidate

- Source: exact node-local exclusions, durable bounded HTTP/protocol retry state,
  complete-body deadline, bounded body and stricter XTTS evidence implemented.
- Windows compiled HTTP fixtures: **passed**, 8/8 pre-commit checks; real sockets
  with synthetic services and a controlled retry clock, not production models.
- Exact runtime source regression/CI: **passed**, all ten jobs on
  `9286a72a4aa46e248bba26fe0c14938821bc23a5`,
  [CI34700930685](https://github.com/samuelvoltarius/xaventra/actions/runs/34700930685).
  Clean Windows/Linux/macOS reports each pass8/8. Final documentation promotion
  requires its own green exact-commit CI. [Limits](VERIFICATION_2.78.24.md).
- Production adoption/request-cadence verification: **open**, separate from unit
  and fixture scores. No unrelated node or foreign service changes authorized.
- Remaining RC/native/HA gates below stay **open** and unchanged.

### 2.78.23 update-stop regression candidate

- Reproduced: an accepted direct WebSocket without a signed hello is absent from
  the known-peer map and can keep listener shutdown pending. A non-reading peer
  also prevents graceful close. This is a real local reproduction, not proof of
  a particular production incident's cause.
- Implemented: complete owned-socket inventory, bounded handshake, terminal
  transport close and unconfirmed pending-ack settlement.
- Targeted regression: three new failures before the patch; 9/9 new/existing
  Mesh tests after it. Compiled Windows daemon: 8/8 checks, normal CLI shutdown
  with the idle non-reading peer still connected (1,152ms).
- Full regression, exact candidate CI and built-image checks must pass before
  this follow-up is promoted. Do not advance main while the previous publisher
  is still executing. Live GitHub/GHCR and production adoption gates remain open.
  [Exact source and acceptance evidence](VERIFICATION_2.78.23.md).

### 2.78.22 signed container update candidate

[Controller/publisher/enrollment](CONTAINER_UPDATES.md),
[verification and retained failures](VERIFICATION_2.78.22.md).

- Source: publisher, detached controller, exact grants, cloned state, acceptance
  and rollback implemented.
- Disposable Linux arm64 Docker: **passed**, 4/4 pre-commit checks; HTTP/authority
  fixtures, not public GitHub/GHCR or production Mesh.
- Source regression/CI: **passed**, 219 files / 1,509 tests and all ten jobs on
  `87fb0bd0857fc6358a4c29d4502d563e56d63bf2`,
  [CI34504399346](https://github.com/samuelvoltarius/xaventra/actions/runs/34504399346).
  Same clean arm64 source: actual update/rollback4/4 and packaged lifecycle7/7.
  Documentation-only follow-ups still require their applicable CI before main.
- Publisher identity/main-only environment: **enrolled**. Automatic publication
  and independent anonymous signed-package/registry verification: **passed**,
  main `6e55f325a61dec7bebc19f8937f407ac25d56817`,
  [publisher34506915056](https://github.com/samuelvoltarius/xaventra/actions/runs/34506915056).
  Preview only; not a native/stable/RC release or production activation.
- Production enrollment and live upstream canary: **open**, no runtime changes.
- Native installers/signatures and remaining RC gates: unchanged and **open**.

### 2.78.21 upstream download candidate (not complete self-update)

[GitHub discovery and staging contract](GITHUB_SELF_UPDATE_PLAN.md): signed
publisher manifests, bounded downloads, exact candidate binding and persistent
status. Legacy in-place Git mutation removed. The compiled HTTP-fixture suite
is run on Windows/Linux/macOS CI; it does not replace a published-release test.
Unit/fixture results and final source evidence are in
[the verification record](VERIFICATION_2.78.21.md).
Runtime source: `f615d3bb192b53d45621b1d8f6028ae0dd37f12c`;
Windows regression 216 files / 1486 tests, compiled HTTP-fixture 7/7.

- Discovery/download source gate: implemented; see exact test evidence.
- Public release publisher/green-CI artifact provenance: **open**.
- Independent upstream activation controller and node enrollment: **open**.
- Actual `/update deploy` upgrade, restart and state rollback: **open**.
- Existing production shutdown/startup failures: **open**, not masked here.
- No production rollout, full self-update, self-repair completion or RC claimed.

### 2.78.20 Docker host-access candidate

[Host access, authority and recovery](HOST_ACCESS.md) implements opt-in local
inventory/status/logs and separately approved, exact-ID lifecycle operations.
Natural local inventory questions use the existing registry and Kernel without
model inference. Application-container Docker absence remains an explicit error
until operator enrollment; no raw Docker socket is added to the app.
Unit/fake-Engine tests, real disposable Docker lifecycle, actual CLI and production
enrollment must be reported separately. Exact candidate CI remains required before
main promotion. General cumulative-budget, memory-correction and persona failures
from the live CLI assessment remain open, not hidden by the inventory fast path.
Runtime source `79ee6eae00319517d4cd2313c1d442c8245f60f6` and its exact CI run
are linked in [the verification record](VERIFICATION_2.78.20.md). Local regression:
1470 tests; dirty Linux arm64 protocol acceptance 10/10 and isolated actual CLI
5/5. Production enrollment is **open**, broader budget/memory fixes are **open**.
CI status must be read from the linked run and from the final promotion commit;
static reachability and fixture results are not full RC acceptance.

### 2.78.19 shared-state peer recovery candidate

[Contract and recovery](REPAIR_PUBLICATION.md) and
[evidence boundaries](VERIFICATION_2.78.19.md). Two reproduced resume defects are
covered: incomplete preflight and missed newly introduced state writers.
Same-image peer replacements can move to the main's separately cloned named
volumes after recovery, or stay stopped while original peers resume on rollback.
Runtime `cd6ef3684dc580a01e73d3f7c0c629caef3fbbc5` passes 1,455 local tests and
[all 10 CI jobs](https://github.com/samuelvoltarius/xaventra/actions/runs/34325848507).
Clean Linux arm64 peer migration passes 6/6; three corrected real-model fixture
runs pass 7/7 each. The earlier schema failure remains documented. Publisher,
peer migration and model runs are separate proofs, not a combined production run.
Final documentation promotion requires green exact-SHA CI as well.
Production writable-bind adoption, exclusive restart
ownership, remote sink enforcement and cross-release peer enrollment remain open.
No production activation, complete self-repair or RC is claimed.

### 2.78.18 automatic repair publication candidate

[Publication and recovery contract](REPAIR_PUBLICATION.md) and
[source-specific acceptance](VERIFICATION_2.78.18.md). Actual Linux arm64 automatic
publication passes 6/6; state cloning 4/4; Windows regression 1,439 tests.
Exact-commit complete CI remains a promotion gate; see the
[candidate checks](https://github.com/samuelvoltarius/xaventra/actions/workflows/ci.yml?query=branch%3Acodex%2Frepair-publisher-2.78.18).
No production activation or RC.
The main CI 34276726942 Windows lifecycle negative is retained: CLI stop and marker
cleanup succeeded but the parent had not confirmed daemon exit. Acceptance now
awaits the actual exit event and still requires exit code zero.

- Source/test gate: local pass; promotion requires all ten exact-commit CI jobs,
  not the green subset of a failed predecessor run.
- Docker build/source/writer gate: bounded pass on `b6f87a3de7868964e07855a355bb622922e675a3`.
- Full production writer coverage: open (sink adapters, inventory enrollment,
  exclusive restart adoption and shared-state peer replacement).
- Existing cross-platform/native/HA RC gates below remain unchanged.

### 2.78.17 tool-admission and maintenance checkpoint

[Protocol, configuration and recovery](REPAIR_DRAIN.md) describe persisted
signed permits, timeout-safe completion, explicit node policy, pre-activation
drain and signed-receipt reopening. Local compiled two-process HTTP acceptance
passes 5/5 on Windows (working-tree evidence, not final-SHA or live Mesh proof).
Unit/API negatives cover authorization, stale completion, unclassified actions,
restart, receipt reconciliation and authority revalidation after draining.
Exact candidate source/test/CI evidence is recorded in the release verification
document before promotion; no incomplete candidate is labeled RC.

Runtime source `fc0e3a008f1515dda5048d2098945f3f49a7375d` has clean downloaded
three-OS admission **5/5** and controller **4/4** reports from
[CI 34275424996](https://github.com/samuelvoltarius/xaventra/actions/runs/34275424996).
Separate clean Linux arm64 real-model Docker repair passed **7/7**, state copy
**4/4** and admission **5/5**. See [exact evidence and scope](VERIFICATION_2.78.17.md).
The final candidate, including documentation, still requires all ten CI jobs
green before normal main promotion. Production activation is not included.

**Open:** general external/background writer fencing; additional typed completion
adapters; immutable Docker build/sign/source-mirror preparation; production
adoption/exclusive restart ownership; original live symptom recovery. Those
requirements remain in scope. The coordinator is opt-in and single-writer,
not a new quorum system. A bounded protocol pass is not production activation.

### 2.78.16 Docker repair and continuous acceptance

[Deployment, evidence and remaining gates](DOCKER_REPAIR.md) cover the external
Docker driver, independent grant/lease authority, isolated state clone and
the continuous Doctor-to-recovery test. A preliminary actual local-model run
passed 6/6 on an isolated Linux host; it was a dirty source run and must not be
relabeled final-source or production evidence. Real state-copy checks passed
4/4 separately, with fixture quiescence rather than production Mesh fencing.
The clean source `e9722f4493226e0780c7d0299f0f24db31ce9dca` subsequently passed
the same live-model 6/6 and state 4/4 at 2026-09-08 17:31 UTC. See
[the evidence record](VERIFICATION_2.78.16.md) for exact runs and limits.
Source `351b3b2ef0021d384d3ce66b37b17c74630d51b4` then passed live-model **7/7**
including the separate signed HTTP authority, plus real state checks **4/4**;
local Core **205 files / 1406 tests**, Desktop **7/7**. The production lease and
writer drain remain unproven. Its initial Linux Desktop CI screenshot timed out;
that failure is retained, and final exact-SHA all-job acceptance is still required.

Ten exact-candidate CI jobs are now required before main promotion. Keep all
previous failed model, Docker provisioning and artifact-upload reports. The
2.78.15 redundant main CI failed Windows artifact finalization with HTTP 403,
not the runtime tests; its previously green candidate run remains recorded.

Open production gates: administrative installation outside candidate mounts;
prepared signed artifacts/source-mirror advancement; deployment-specific writer
drain and current fencing; adoption of existing containers/volumes; actual
production predicate and receipts. No generic state/schema/API rollback, old
DSM cgroup compatibility, fleet rollout or RC completion is implied.

### 2.78.15 Doctor candidate / independent activation checkpoint

The legacy approved host mutation transaction is removed. Profile-bound Doctor
candidates, signed external activation requests and independent original HTTP
predicate receipts are connected; the optional managed Linux adapter verifies
immutable artifacts, process exit, rollback and active-source continuity.
[Verification classes and remaining prerequisites](VERIFICATION_2.78.15.md)
separate source tests, real disposable controller processes, privileged Linux
acceptance and live-model/production acceptance. All nine exact-candidate jobs
must pass before main advances. No RC label or production/fleet acceptance.

Open: arbitrary Doctor-to-production repairs, per-deployment authority/signing,
prepared artifact pipeline, automatic repair source-mirror advancement,
container-specific deployment adapters, original non-HTTP predicates and
distributed recovery. These remain in scope; they are not renamed into passes.

Concrete managed-adapter source `80169f5bc98ae3369b5619a22d5a8a23ca7feee7`
passed five real root-controller/non-root-runtime checks in
[CI 34250403838](https://github.com/samuelvoltarius/xaventra/actions/runs/34250403838).
Clean local-model candidate acceptance is separately recorded in the verification
document. Final HEAD promotion requires all nine jobs green for that HEAD, not
the predecessor's partial/individual job result.

### 2.78.14 isolated repair sandbox candidate

The preapproval host-execution boundary is replaced with constrained disposable
Linux containers. [Acceptance record](VERIFICATION_2.78.14.md) separates scripted
cross-platform boundary/caller tests from the real Docker fixture. Baseline,
candidate, rollback and restoration must each carry snapshot-bound evidence.
No configuration, secret or production source is changed by experimentation.
Exact candidate CI, including the new real container job, is required before
main promotion. Production activation/recovery, automatic candidate generation,
native-host Docker availability and complete 40-module/RC acceptance remain open.

Source `72fa75eea3f87da71bdd359cad4c58d5971eb821` passed all eight jobs in
[CI 34238645175](https://github.com/samuelvoltarius/xaventra/actions/runs/34238645175),
including actual isolated baseline/candidate/rollback/restoration, full Core
regression in each phase and hostile-write/semantic-negative controls. Final
hard-deadline changes require their own exact-SHA CI before main promotion.

Hard-deadline source `9b5edd06ea972c36a4334cc8164f57f7c3e24685` passed all eight
jobs in [CI 34239802665](https://github.com/samuelvoltarius/xaventra/actions/runs/34239802665),
including all six real sandbox checks and the hostile non-cooperating process.
Final caller ownership is covered by a new red/green competing-call regression;
promotion still requires the final HEAD's own green CI, not a predecessor's.

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

### 2.78.35 Outcome Router shadow-learning candidate

Outcome Router training no longer scans terminal ledger records and treats any
validation-shaped payload as production evidence. The Learning Coordinator is
the sole admission path into a durable, integrity-checked derived sample store.
Samples require independently checkable Execution Kernel evidence, are keyed by
a one-way principal scope and are tombstoned when that user's outcome is later
invalidated. Benchmark, fixture, synthetic, response-only, anonymous and other
users' outcomes cannot open an activation gate.

Source tests and a compiled two-process acceptance cover persistence over
restart, exact 20-sample activation, 19-sample fail-closed behavior,
self-asserted ledger rejection, aggregate-view non-activation and cross-user
isolation. This is isolated source/process evidence, not production traffic,
active routing rollout or model-quality proof. Exact candidate/evidence/main CI,
history scan and signed publication remain required before this checkpoint can
be promoted. The overall RC remains open.

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
