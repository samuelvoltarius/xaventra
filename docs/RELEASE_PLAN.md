# Reliability release loop

## 2.78.51 Doctor delayed-receipt reconciliation candidate

Two failing source regressions reproduced that delayed terminal Outcomes could
never release an uncertain Doctor hold. New observation-bound holds now use a
durable three-check, 15-minute receipt-only budget. Reconciliation cannot dispatch
a diagnostic worker. Foreign, invalidated, changed-observation, legacy-unbound
and exhausted records remain closed. Terminal failure keeps bounded backoff.

Focused source/native-runner regression passes 31/31. Separate-process delayed
completion and restart acceptance passes 16/16. Local full regression passed
233 files / 1,626 tests before one additional ledger-read failure test; that
test is included in the final focused pass. Desktop passes 12/12 after using
the permitted temporary root (the initial sandbox Temp-access failure is retained).
Typecheck and build pass. Runtime commit
`0ff5e864f233e12a85eaef6f1bbea7554d470a62` passed all ten jobs in
[candidate CI 35790896388](https://github.com/samuelvoltarius/xaventra/actions/runs/35790896388).
Downloaded Ubuntu, Windows and macOS reports each identify that clean revision
and pass all 16 checks, including delayed terminal reconciliation and restart
deduplication. Gitleaks 8.30.1 scanned all 134 public commits (11.12 MB) with
zero findings. The evidence commit, exact main CI and signed publication are
still required before release. This is controlled
process evidence with injected runner replies, not physical-host takeover or
live-model repair quality. No production changes or RC qualification are implied.

## 2.78.50 Doctor uncertain-execution boundary candidate

Missing or nonterminal diagnostic Outcomes previously became retryable after a
lost reply. Three new regression cases reproduced that gap and the missing
failed-Outcome audit reference. A dispatched run now needs a matching terminal
receipt before any bounded retry; uncertain or foreign receipts hold the case
across restart, including retryable records written by 2.78.49. Confirmed terminal failures retain their evidence references,
backoff and three-attempt limit, followed by an explicit operator-visible reason.

Local focused regression passes 23/23. The compiled acceptance covers 14 checks,
including real child processes and durable files with injected runner replies
for absent, nonterminal and failed Outcomes. These fixtures prove retry and
persistence behavior, not live-model diagnosis or physical-node repair quality.
Runtime `e3cbb7c33147d1517092d99248bf8dca46b93537` passed all ten jobs in
[candidate CI 35780475064](https://github.com/samuelvoltarius/xaventra/actions/runs/35780475064),
including full Core regression and packaged Desktop checks. Downloaded Ubuntu,
Windows and macOS failure-escalation reports each identify that clean revision
and pass 14/14 checks. Local Desktop tests pass 12/12; typecheck and build pass.
Gitleaks 8.30.1 found zero secrets in the staged change and all 132 public
commits (11.11 MB). The separate evidence commit still requires its own green
CI before main promotion and the signed release pipeline.
The RC remains open.

## 2.78.49 Doctor receipt reconciliation candidate

When the diagnostic runner commits a validated Outcome but loses its reply,
the Doctor now reads that terminal receipt before scheduling another attempt.
The focused regression uses a fresh coordinator instance and proves one
diagnostic effect. The compiled three-process acceptance passes 10/10 checks:
the persisted Doctor queue is rehydrated, a terminal independently validated
Outcome survives a lost reply, and a third process does not repeat the effect.
Runtime commit `26d07e0458e2377a89b002a44054bb93ac865475` passes
the compiled three-process acceptance 10/10 on a clean tree, Core 233 files /
1,614 tests (two-worker rerun), Desktop 12/12, typecheck, build, layer
reachability and terminal-success authority. The first parallel Core run had
one transient witness-quorum timing failure; the isolated rerun and complete
two-worker rerun passed, so this is recorded rather than hidden. Candidate CI
run `35769104400` passed all ten jobs on this exact runtime commit. Official
Gitleaks 8.30.1 scanned all 130 reachable public commits (11.10 MB) with zero
findings; the staged diff pattern scan was also clear. This is source and
disposable-process evidence, not a physical-node/live-channel proof. Evidence
commit CI, signed release and production activation remain separate gates until
their receipts are recorded.
The RC remains open; this bounded change does not qualify autonomous repair.

Every iteration: reproduce -> isolate -> fix -> regression -> real acceptance ->
document -> synchronized version bump -> scan -> push candidate -> CI -> main.
Preserve negative results. No mocked proof is substituted for live execution.

## Current bounded gates

### 2.78.48 natural-request tool-result correctness candidate

- A live Telegram `nova_capabilities` call produced a valid multi-line
  inventory but the generic string-result heuristic scanned every capability
  description and treated a later `nicht gefunden` phrase as the outcome of
  the call. String failures are now classified from the summary line, while
  structured `success` and `error` fields remain authoritative.
- The Clarification Gate no longer interprets the grammatical `es`/`it` in an
  impersonal time question as an unresolved object reference. `get_current_time`
  remains in the bounded Core tool contract and still requires a correlated
  result and independent validation before its answer counts as verified.
- Local evidence: the real 1,560-character `nova_capabilities` handler output
  classifies as successful; 31/31 focused routing, intent, clarification and
  result-quality tests pass; Core typecheck/build pass; and the unchanged full
  Core suite passes 233 files / 1,613 tests with process-local Windows Git
  long-path support. Exact runtime commit
  `83119c20ffe51286306102e16ffd980c9a784872` passed all ten jobs in
  [candidate CI 35756705874](https://github.com/samuelvoltarius/xaventra/actions/runs/35756705874),
  including Ubuntu, Windows and macOS verification, packaged Desktop,
  container recovery and the isolated repair sandbox. Gitleaks 8.30.1 scanned
  all 128 public commits / about 11.09 MB with zero findings. Evidence CI,
  exact-main CI and signed publication remain pending. No production node,
  channel, lease, credential or configuration is changed.

### 2.78.46 typed non-recoverable failure escalation candidate

- A verified non-recoverable tool failure no longer becomes an LLM prompt that
  can select discovery tools, `build_skill`, commands or authority. The native
  runner records one deterministic typed escalation from correlated Execution
  Kernel evidence.
- Invalid input, unresolved resource and external authorization failures may
  create one durable principal-scoped clarification. If another clarification
  is already pending, it is preserved and the failure is queued for read-only
  Doctor research instead. Rate limit, exhausted transient, missing dependency
  and unknown failures enter that same bounded Doctor queue directly.
- The escalation store retains run/tool references, classification, argument
  names, a redacted failure summary and digest. A fresh process deduplicates the
  same escalation and Doctor case; the original task remains canonically failed
  because no successful tool evidence exists.
- Local evidence includes 17/17 focused unit/authorization/native-runner tests,
  all 233 Core suites / 1,607 tests, Desktop 12/12, packaged Desktop UI 10/10
  and packaged Desktop-to-actual-Core 5/5, typecheck/build, current
  catalogs, 9 core plus 40 service modules, state/completion authority and a
  passing assurance gate with zero dependency findings. A compiled two-process
  acceptance proves one model turn,
  one failed effect, zero `build_skill` effects, a deterministic user response,
  persisted escalation/Doctor records, canonical failure and restart
  deduplication. The retained first regression failures were an obsolete
  call-site count and Windows long-path environment failure; the unchanged
  complete suite passed after the semantic assertion update and process-local
  Git long-path setting. A cached-QA replay was also reproduced and fixed by
  moving each acceptance child into its disposable runtime before imports.
  Exact candidate `0c809c6b94e290af40c0f425105a7a099547c02a` passed all ten
  jobs in [CI 35623661385](https://github.com/samuelvoltarius/xaventra/actions/runs/35623661385).
  Downloaded Ubuntu, Windows and macOS artifacts each bind all eight acceptance
  checks to that clean revision. Gitleaks 8.30.1 found no secret across 124
  public commits / about 11.08 MB. Evidence/main CI and signed publication
  remain pending. No production node or channel is changed.

### 2.78.45 typed low-risk recovery candidate

- Native tool failures are classified into transient transport, rate limit,
  authorization, invalid input, missing dependency, missing resource and
  unknown categories. Failure text remains untrusted evidence and cannot select
  a command, tool or permission.
- Only seven explicitly reviewed observational tools may receive exactly one
  automatic retry, and only after a transient transport result. The retry
  re-enters authorization, task policy, fencing, budget, idempotency, lifecycle
  policy and timeout gates. Mutating and unclassified failures remain closed.
- Local source evidence includes 15/15 focused unit/native-runner regressions,
  typecheck/build, all 232 Core suites / 1,602 tests, Desktop 12/12, current generated catalogs,
  9 core plus 40 service modules loaded, terminal/state authority acceptances
  and the assurance gate with zero high/critical runtime dependency findings.
  A compiled Windows acceptance against an actual loopback HTTP service
  observed two requests for a recoverable 503, two total requests for a
  persistent 503, zero mutation retries, zero unknown retries and an
  independently verified Execution Kernel receipt. The first full regression
  retained three local-environment failures caused by an absent locked module
  tree and Windows long-path handling; after installing the unchanged lock and
  setting process-local long-path config, the complete unchanged-source rerun
  passed. After adding the native-runner and concrete Node transport
  classifications, the final suite passed 1,602/1,602.
- Exact candidate commit `0c475ff3641dc2af8be966b2fa93b38b499e1f12`
  passed all ten jobs in
  [candidate CI 35609719672](https://github.com/samuelvoltarius/xaventra/actions/runs/35609719672).
  Downloaded Ubuntu, Windows and macOS reports independently reproduced the
  compiled loopback contract: two requests and a verified receipt for the
  recoverable case, one bounded retry for a persistent failure, and zero retry
  for mutation or unknown failures. Gitleaks 8.30.1 found no secret across 122
  public commits / about 11.04 MB.
- This is bounded process/network evidence, not a production-host recovery or
  physical network-partition claim. Evidence CI, main promotion and signed
  publication remain pending. No production node or channel is changed.

### 2.78.44 Agents SDK durable tool takeover candidate

- Agents SDK tool execution now persists the completed idempotency record and a
  principal/channel/contract-bound verified receipt. Approval checkpoints list
  the exact completed keys; resume fails closed when any claimed receipt is
  missing or no longer matches its durable result.
- Fenced SDK missions publish and hydrate those records through the same
  authenticated witness checkpoint boundary as native tools. The successor
  restores Execution Kernel evidence before approval and terminal validation;
  stale epochs cannot write a later checkpoint.
- Local focused regressions pass 8/8; the unchanged full Core suite passed 231
  files / 1,587 tests with the process-local Windows Git long-path setting, and
  Desktop passed 12/12. A compiled Windows acceptance used two
  isolated Xaventra node processes and three authenticated durable witness
  services, executed exactly two intended effects around a real SDK approval
  interruption, restored the predecessor receipt, completed through the
  canonical validator and rejected the stale predecessor. This is controlled
  process/witness evidence, not a physical-host or production-network claim.
- Exact runtime commit `61947dae789272572c3ad611a5ac28423efb658a`
  passed all ten jobs in
  [candidate CI 35596064791](https://github.com/samuelvoltarius/xaventra/actions/runs/35596064791).
  Downloaded Ubuntu, Windows and macOS reports each used three process starts
  and three authenticated durable witnesses, observed exactly two intended
  effects, restored the predecessor receipt and approval checkpoint, reached
  canonical completion without replay and rejected the stale writer.
  Gitleaks 8.30.1 found no secret across 120 public commits / about 11.01 MB.
  Evidence/main CI and signed publication remain pending. No production node
  or channel is changed.

### 2.78.43 single terminal-success authority candidate

- `OutcomeLedger.completeValidated` is now the only public terminal-success
  writer. It fails closed unless the same run has a successful, non-pending
  `nova-execution-kernel` validation; the raw append primitive is private.
- Signed mesh `run.result` delivery no longer marks a task successful. It
  contributes transport-bound evidence, while the requesting Execution Kernel
  validates and commits the final outcome. Remote failure remains terminal.
- Imported or legacy `run.completed` events without the canonical validation
  event project as failed and invalidated instead of manufacturing success.
- Local evidence before candidate publication: typecheck/build, 48 focused
  regressions, full Core regression (231 suites / 1,585 tests), Desktop unit
  regression 12/12, current catalogs, 9 core plus 40 service modules loaded,
  Windows unpacked Desktop package build and compiled disposable terminal
  authority acceptance 9/9. The first full run retained one 5-second timing
  failure in repair publication; its focused rerun passed 8/8 and the unchanged
  full rerun passed 1,585/1,585. Assurance passed with no high or critical
  dependency finding. Secret scans and hosted cross-platform CI remain required.
- The first hosted candidate run failed closed on Ubuntu because the existing
  Outcome Router process acceptance itself still used the removed raw ledger
  completion API. That negative is retained; the fixture now exercises the
  public validated completion contract. Exact corrected candidate
  `97d6453dcbbee125bd37c8b3b27688caf8f15d4a` passed all ten jobs in CI
  `35585156186`; downloaded Ubuntu, Windows and macOS reports passed all 27
  terminal-authority checks. Evidence CI, main promotion and signed publication
  remain required.
- This is source/process evidence. It does not prove a physical-node failover,
  production deployment, native signing identity or platform notarization;
  those RC gates remain open.

### 2.78.42 canonical process-state authority candidate

- The dead parallel `NovaStateMachine` implementation has been removed from
  L03. `CoreRuntime`, daemon channel ingress and observers now use the same
  canonical `StateMachine` object.
- Each top-level message owns a correlated operation lease. Completing one of
  two overlapping requests cannot return the process to idle, duplicate
  admission/completion is rejected, and a legacy direct idle transition is
  fenced while any request remains active. Failures reconcile only after the
  active set drains.
- Local Windows evidence before candidate publication: focused state/L03
  regressions 171/171, typecheck/build, compiled state-authority acceptance
  19/19, and static/runtime module loading with 9 core plus 40 service modules.
  Exact candidate `82216d4d852cf27180394ce41cb67e4bab3402f4` passed all ten
  jobs in CI `35574205134`. Downloaded official Ubuntu, Windows and macOS
  reports each passed all 19 authority checks against that exact revision.
  Gitleaks 8.30.1 found no secret across 115 public commits / about 10.96 MB.
  Evidence CI, main promotion and signed release remain required.
- This is a source-only concurrency fix. It does not prove a physical-host
  partition, live-channel handoff, distributed mission reconstruction or
  production rollout; those RC gates remain open.

### 2.78.41 packaged Desktop screenshot reliability candidate

- The packaged Desktop acceptance now gives screenshot capture an independent
  30-second deadline, disables animations and permits exactly one retry for a
  transient compositor or font-rendering stall. A second failure remains
  terminal and cannot turn a failed UI run green.
- Every evidence image records its attempt count and timeout in `report.json`.
  The previous 2.78.40 evidence run is retained as negative evidence: Ubuntu's
  first attempt timed out after ten seconds during screenshot capture, while an
  exact unchanged failed-job retry passed.
- Local Windows evidence before the candidate commit: Desktop screenshot unit
  regressions 3/3, all Desktop unit regressions 12/12, typecheck/build, current
  catalogs, 9 core plus 40 service modules loaded, and a disposable packaged
  Electron acceptance with all ten interaction checks plus five screenshots
  captured on their first attempt. The default Electron-builder copy step did
  not complete in the restricted local sandbox, so that acceptance used the
  exact Desktop sources in an ASAR with the locked Electron runtime; hosted CI
  must still build and test the official packages on all three platforms.
  Exact candidate `4538e7c2245a49734034f49af0a6ae94c529d4b9`
  passed all ten jobs in CI run `35566322916`. Official Ubuntu, Windows and
  macOS package reports each passed all ten interactions and captured all five
  screenshots on attempt one with the explicit 30-second deadline. Gitleaks
  8.30.1 found no secret across 113 public commits / about 10.94 MB. Evidence
  CI run `35566843123`, main CI `35567308522` and signed publisher run
  `35567856185` passed for evidence commit
  `3c98dd008078f342c647e59b6454c5870564dcbd`. Prerelease `v2.78.41`
  targets that exact commit. No production node changed.

### 2.78.40 cancellable mesh-agent execution candidate

- Mesh subagents now use the existing signed, authenticated and policy-checked
  transport instead of a nonexistent legacy HTTP endpoint. Worker execution is
  constrained to the transmitted principal and explicit tool allowlist; remote
  slash commands cannot bypass the tool contract.
- Agent admission is acknowledged before long-running work completes so a
  typed `run.cancel` can overtake it. Timeout or uncertain delivery never falls
  back to local execution, avoiding duplicate side effects. Idempotent replay
  returns a cached outcome correlated to the new request ID.
- Local Windows evidence before the candidate commit: focused mesh/subagent
  regressions 10/10, two-process authenticated direct-WebSocket acceptance 7/7,
  typecheck/build, full Core regression 230 suites / 1,579 tests, Desktop unit
  tests 9/9, current runtime catalogs, and 9 core plus 40 service modules loaded.
  The first acceptance run is retained as negative evidence: request ACK waited
  for handler completion, so cancellation arrived after a late effect. The
  admission/completion split fixed the reproduced race. A packaged Desktop was
  not locally available; cross-platform package and candidate CI remain
  required. Exact candidate `52551cc15e13f9de8bc4c35843ca1bc071ed3d78`
  passed all ten jobs in CI run `35558977932`; Ubuntu, Windows and macOS
  artifacts each passed all seven cancellation checks. Gitleaks 8.30.1 found
  no secret across 111 public commits / about 10.93 MB. Evidence CI, main
  promotion and signed publication remain required. This is loopback process
  evidence, not a physical-host failover or production rollout.

### 2.78.39 Telegram effect fencing candidate

- The Telegram adapter now revalidates both current Main and Telegram
  authority at the Bot API effect boundary. This covers legacy direct SDK
  calls as well as messages, chunks, edits, files, reactions, progress,
  streaming and proactive output; stale inbound updates are rejected before
  reactions or pipeline dispatch.
- The compiled acceptance launches two distinct Node processes against a
  disposable epoch authority. It proves the predecessor can send before
  takeover, cannot use either the adapter or the legacy direct Bot API after
  takeover, cannot dispatch a stale update, and that only the successor emits
  and consumes after epoch 2. The transport is a fake Telegram sink: this is
  process-boundary fencing evidence, not a physical-host partition or live
  Telegram delivery claim.
- Local Windows evidence before the candidate commit: focused Telegram tests
  11/11, two-process handoff 5/5 in 1.15 seconds, typecheck/build and complete
  Core regression 535 suites / 1,575 tests. The first local full run retained
  two setup negatives: a missing worktree dependency tree and a stale Sharp
  0.35.3 junction. Exact `npm ci` installed locked Sharp 0.35.4; the unchanged
  full suite then passed with the supported per-process Git long-path setting.
  Exact candidate commit `be54bce6a9e340cc7087fe1ee5bf74e8550896c8`
  passed all 10 jobs in CI run `35552924144`; its Ubuntu, Windows and macOS
  artifacts each passed all five handoff checks against that revision. Gitleaks
  8.30.1 found no secrets across 109 public commits / about 10.90 MB. Evidence
  CI, main promotion and signed publication remain required. No production node
  or Telegram bot was touched.

### 2.78.38 packaged Desktop repair activation candidate

- The packaged Trust surface now completes owner approval through the existing
  canonical `PATCH_GATE`, a separately signed loopback controller and an
  independent before/after probe. The public projection contains only bounded
  terminal metadata; controller signatures, challenges, fingerprints, patch
  contents and approval tokens remain private.
- Pending and terminal proposals cannot be resubmitted. The full-daemon
  packaged Electron acceptance activates one disposable repair, observes the
  original fault and healthy candidate, then restarts Core and verifies the
  same terminal receipt with an unchanged external activation count.
- Source, package and full-daemon acceptance evidence is recorded in
  [the candidate record](VERIFICATION_2.78.38.md). Runtime
  `1332ee043db8c722e88a758392626fc0ccbf85f1` passed all ten jobs in
  [CI 35540849173](https://github.com/samuelvoltarius/xaventra/actions/runs/35540849173),
  including the packaged full-daemon acceptance on Windows, macOS and Linux.
  Gitleaks 8.30.1 found no secret in the full 107-commit / 10.87 MB public
  history. This disposable controller is an isolated acceptance fixture, not a
  production repair or node rollout. Evidence-commit CI, main CI and signed
  release publication remain required before promotion.

### 2.78.37 packaged Desktop Doctor trust candidate

- The packaged Trust view now exposes Doctor repair proposals only to the
  configured Desktop owner and only as a sanitized evidence projection. Patch
  contents, controller signatures and raw sandbox output never cross the API.
- Approval requires current Main plus dashboard fencing and sends a transient
  token into the existing canonical `PATCH_GATE`; Desktop has no alternate
  patch executor or autonomous approval path.
- Source regressions and the packaged Electron-to-full-daemon acceptance are
  recorded in [the candidate record](VERIFICATION_2.78.37.md). Candidate CI,
  including packaged Desktop runs on Windows, Linux and macOS, passed all ten
  jobs at candidate `6a497cb23c58a61bfd308934e5d1cf2f14f6e538` in
  [CI 35533601234](https://github.com/samuelvoltarius/xaventra/actions/runs/35533601234).
  Gitleaks 8.30.1 found no secret in all 105 public commits (10.86 MB).
  Evidence-commit CI remains required. The test is isolated synthetic evidence,
  not a production repair or node rollout.

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
