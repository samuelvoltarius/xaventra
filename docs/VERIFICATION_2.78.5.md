# 2.78.5 — full daemon / packaged Desktop acceptance

Status: bounded reliability release, **not RC-ready**. No production rollout or
signed installer publication is implied by this source release.

## Reproduced defects

- The full daemon completed startup, but `getNovaState().runtimeReady` remained
  false: `initNovaState` had copied a separate local object before late startup
  writes. The real readiness check timed out. Daemon and CLI now retain the
  canonical returned object; readiness, tools, channels and memory share identity.
- With empty background discovery, an explicitly configured working local model
  was changed to `unknown`. A real provider rejected it with HTTP 404. Configured
  local endpoints now keep their selected model; successful execution, not the
  configuration alone, proves availability.
- The real local model repeatedly requested the same file and returned no final
  answer. Follow-up evidence was flattened into a user turn and the daemon
  adapter dropped correlated tool metadata. Actual tool messages and IDs now
  survive the adapter, as do native per-call options. The test requires exactly
  one read, not merely at least one successful tool.
- A memory question after daemon restart reread the file despite explicit
  history-only instructions. Current-turn recall-only authority now excludes
  external tool execution, including cached/recovery paths.
- Repeating the real restart test exposed a second problem: the text history
  survived, but the model denied its earlier actual read because historical
  tool receipts were absent from context. Assistant checkpoints now retain a
  run reference, and recall rehydrates bounded, validated ledger receipts only
  for the exact user, channel, room and bot. Invalidated/failed/unscoped runs
  are excluded; historical evidence never counts as a newly executed tool.
- A policy-denied read entered repair/recovery until the response deadline, with
  a still-running Outcome. Policy denials now terminate that path, preserve a
  failed/approval-required result and cannot become successful completion.
- Full Main startup opened an old ungoverned integration side server. This
  parallel path is disabled; normal authenticated REST ingress remains. Dashboard
  has an explicit loopback bind and a default port matching Desktop; conflicts do
  not launch a different port or a legacy fallback.
- Interactive inspection found a rapid pinned/Auto save race. Pending model
  saves are serialized; a delayed fixture regression verifies the return to Auto
  and draft preservation.

Failed reports were retained locally rather than replaced or reclassified.

## Independent checks

| Check | Scope |
|---|---|
| Core regression suite | 171 files / 1094 tests, including canonical state, local configuration, bounded correlated tool turns, scoped historical receipts, authorization and policy validation |
| Desktop bridge | 7 tests; local identity/credential and workspace boundaries |
| Packaged UI | 10 grouped checks against a simulated HTTP Core; includes delayed model save, drafts, failure recovery and minimum window |
| Actual Core components | 5 packaged-client groups with scripted model; API, native pipeline, tools, validator and scoped records |
| Full compiled daemon | 6 packaged-client groups, including actual process restart and scoped session recall; strict scripted provider in CI |
| Real local provider | Separate Windows run of those 6 full-daemon groups using a selected `qwen` endpoint; not simulated model responses |
| Daemon lifecycle | Actual compiled process, authenticated REST status/rejection and instance-scoped CLI shutdown |
| Source gates | Typecheck, build/freshness, generated catalogs, dependency/assurance checks and pre-push secret scan |

The six full-daemon groups require: authoritative bootstrap; one actual file read
with matching model, linked validator and Outcome; following slash command;
scoped Memory/Trust; daemon restart preserving room, ledger, memory and session
without repeating tools; denied file with no content leak or successful result.
The fixture only adds restrictive policy and synthetic data; it does not inject
ready state, message handlers or fake Main leases. Shutdown uses the real scoped
CLI control channel. An unknown model is rejected by the scripted provider too.

A separate eight-scenario real-provider native/REST acceptance run scored **7/8**.
The correction response correctly named the new value but also repeated the
invalid old value, despite the request to confirm only the new one. Its strict
exclusion check failed; it was not relaxed or counted as a pass. Subsequent
restart recall returned only the current value and cross-user isolation passed.
This remains an output-contract gate, not proof of lost persisted memory.

Exact-commit CI reports identify OS, package version and source revision. All
required candidate jobs must pass before moving main. Local screenshots were
reviewed for real file evidence, Trust, denied results and a 1120 x 720 window.
Normal keyboard/mouse exploration also covered pin/Auto, retained drafts and a
command after execution. Native system dialogs/capture are not covered by these
screenshots; no full-display screenshot or personal profile was used.

## Remaining gates

- Enforce explicit correction-response constraints before completion; the live
  eight-scenario acceptance above is not yet fully green.
- Live remote Telegram delivery and controlled distributed fencing/takeover.
- Interrupted multi-step native missions and distributed memory reconciliation.
- Per-attempt inference-host and cost attribution across every fallback path;
  execution-host labels must not be read as verified inference-host placement.
- Native folder/capture/keychain acceptance, signed installers, upgrade/rollback
  and macOS notarization. The Windows unpacked test binary is not signed.
- Matched external-agent comparison before any superiority/parity claim.

The model fixture, live provider, unit tests and subsystem benchmark probes are
different kinds of evidence. None is a full-product task-completion percentage.
