# Xaventra 2.78.42 verification

## Scope

This candidate closes one source-level state-authority defect. It does not
claim physical-host failover, live-channel continuity, production deployment or
complete RC readiness.

## Reproduced defect

Daemon ingress previously called `startThinking()` only when the global state
was idle and unconditionally returned the global state to idle when each request
finished. With overlapping requests, the first completion therefore declared
the process idle while the sibling still ran. L03 also exported a second,
independent `NovaStateMachine` implementation even though CoreRuntime used the
canonical state machine.

## Change

- Remove the unused parallel L03 state machine.
- Correlate every admitted top-level message to an operation ID.
- Keep the canonical process state busy until the final operation completes.
- Reject duplicate admission and completion.
- Delay terminal failure reconciliation until siblings drain.
- Fence direct idle transitions while an active operation remains.
- Reset the singleton in place so observers cannot retain a stale authority.

## Local evidence before candidate publication

| Evidence class | Result | Boundary |
|---|---|---|
| State/L03 regressions | 171/171 passed | Source behavior on Windows |
| TypeScript/build | Passed | Windows source and compiled output |
| Compiled authority acceptance | 19/19 passed | One actual Node process, overlapping operation leases |
| Runtime module load | 9 core and 40 service modules loaded | Import/wiring evidence only |
| Full Core regression | 231 suites / 1,583 tests passed | Windows with Git long-path override |
| Desktop unit regression | 12/12 passed | Main-process and evidence contracts |
| Release assurance | Passed | Zero runtime dependency advisories; external comparison remains a warning/open gate |

The first full Core run retained one environment-only negative: the nested
repair-publication fixture exceeded Windows' default Git loose-object path
limit. Its exact focused test passed 8/8 and the unchanged full suite passed
with the process-scoped `core.longpaths=true` override; no global Git setting or
test expectation was changed.

The compiled acceptance proves one process does not become idle early and that
L03 shares the canonical state object. It is not a physical network partition,
cross-host lease election, live Telegram handoff or mission takeover proof.

## Required publication evidence

- Exact candidate CI on Ubuntu, Windows and macOS.
- Full regression and packaged Desktop jobs.
- Complete public-history secret scan.
- Evidence-commit CI, main CI and signed release.

## Remaining gates

- Physical-host partition with lease/fencing, mission takeover, principal-scoped
  memory convergence and live-channel continuity.
- Signed production updater enrollment and broader install/update recovery.
- Real production Outcome Router samples and fair reference-agent runs.
- Native signing/notarization identities where required.
