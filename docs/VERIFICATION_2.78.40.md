# Xaventra 2.78.40 verification

## Scope

This candidate hardens remote subagent dispatch and cancellation. It does not
claim physical-node failover, production rollout, complete RC readiness or a
live wide-area network partition test.

## Reproduced defect

The subagent orchestrator called a legacy `/api/agent` endpoint that is not
provided by the current runtime. On timeout or network uncertainty it could
then execute the same task locally even though the remote node might already
be running it. The typed mesh agent path did not propagate a user/tool scope or
support cancellation. Direct transport ACK also waited for the entire agent
handler, making an otherwise valid cancel arrive after the external effect.

The first real two-process acceptance retained that failure: the request and
cancel were both delivered, but the worker completed successfully and wrote
the deliberately delayed effect before cancellation was processed.

## Change

- Dispatch remote subagents through signed `agent.request` envelopes.
- Apply peer/global tool policy at ingress and pass only the explicit allowlist
  into the worker's normal governed agent pipeline.
- Reject remote slash commands and suppress channel progress output.
- ACK an admitted agent request independently of its later `run.result`.
- Add typed `run.cancel`, `AbortSignal` propagation and a cancellation tombstone
  for cancellation that overtakes request dispatch.
- Never replay a possibly delivered remote request locally after timeout.
- Rebind cached idempotent results to the current request ID so each caller can
  correlate its receipt without repeating work.

## Evidence

| Evidence class | Result | Boundary |
|---|---|---|
| Focused source regression | 10/10 passed | Transport policy, early admission ACK, subagent dispatch, timeout and no local replay |
| Compiled two-process acceptance | 7/7 passed | Two Node processes over authenticated direct WebSocket loopback |
| TypeScript/build | Passed | Windows local source |
| Full Core regression | 230 suites / 1,579 tests passed | Locked dependencies with per-process Git long paths |
| Desktop unit regression | 9/9 passed | Desktop main-process client/security contracts; not packaged UI evidence |
| Runtime catalogs | Current after regeneration | Source inventory |
| Runtime module load | 9 core and 40 service modules loaded | Import/wiring evidence, not full functional proof |
| Candidate CI | Pending | Exact candidate commit not yet pushed |
| Public-history secret scan | Pending | Required before promotion |

The two-process acceptance verifies unsafe tool rejection, typed request
delivery, typed cancel delivery, worker abort, preservation of principal/tool
scope, correlated idempotent replay and prevention of the late effect.

## Preserved negative and limits

- The first acceptance failed because transport ACK represented completion
  rather than admission. Its debug artifacts showed a successful late result
  and the delayed effect. The protocol split was implemented before rerunning.
- The local checkout did not contain a packaged Desktop executable and the
  Desktop dependency tree was not installed, so no local packaged UI claim is
  made. Hosted candidate CI must build and exercise the advertised packages.
- Loopback validates process and authenticated transport boundaries, not a
  physical network partition, lease takeover, or production worker.

## Remaining gates

- Exact candidate/evidence/main CI, full-history secret scan and signed release.
- Physical-node partition with lease/fencing, mission takeover and memory
  convergence.
- Signed updater enrollment and broader install/update recovery evidence.
- Remaining gates in `docs/RELEASE_PLAN.md`.
