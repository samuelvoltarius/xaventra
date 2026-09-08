# 2.78.11 startup and grounded self-description

Base: `221930cb3ed2faf345d80ed6be4631255eca79b0`. Candidate commit and CI
attestation follow only after the working-tree checks below complete.

## Reproduced problems

- A persisted container PID can equal the new daemon's PID after restart. The
  old guard mistakes the new process for another live daemon and refuses boot.
- Independent Main and Telegram takeover callbacks can race to create pollers.
- General capability questions fall through to model prose that invents
  Internet status and host-level access. Identity and welcome still say Nova.

## Evidence classes and gates

| Gate | State | Evidence / limit |
| --- | --- | --- |
| Own-PID reuse, other-process protection | Passed locally | Four source cases plus actual compiled daemon boot with its own PID marker; no Docker namespace claim |
| Concurrent Telegram start and lease-loss fencing | Passed locally | Four actual-starter tests with isolated adapters/lease doubles plus existing authority tests; not Telegram delivery |
| Deterministic identity / capability / permission summary | Passed locally | Command handler and routing tests; no LLM needed |
| Core typecheck and build | Passed locally | Windows working-tree build, TypeScript compilation and generated assets |
| Full Core regression | Passed with CI concurrency bound | 188 files / 1266 tests with maxWorkers=2. Initial unrestricted-worker run: 1264/1265; existing Codex RBAC test timed out at its unchanged 5s limit. Negative result retained; no timeout/assertion relaxed |
| Compiled daemon lifecycle | Passed locally | Normal and seeded-own-PID Windows processes: authenticated status, rejection without auth, graceful scoped stop and marker removal. Scripted loopback provider; not live LLM |
| Cross-platform source and packaged Desktop | Pending CI | Windows, Linux and macOS require exact-candidate evidence |
| Real distributed failover / Telegram handover | Open | Operational recovery is not full task, message, fencing and memory acceptance |
| Native signed installers / full RC | Open | Existing gates and external signing prerequisites remain unchanged |

No private hostnames, operator configuration, tokens, user memories or old Git
refs are part of this candidate. No production deployment of 2.78.11 is claimed.

## Recovery and upgrade

Upgrade through the normal verified release procedure; preserve current user
data and rollback artifacts. If a prior container is blocked by a stale PID,
first stop and verify that exact container has exited. Only then archive its
own PID marker before restart. Never delete a running daemon's marker or kill
processes by a broad name pattern. Do not overwrite Main leases manually.

A model endpoint must be reachable **from its consuming node/container**.
Advertising it from another node is insufficient. Test the selected route and
model API before promotion. Missing Web-search configuration does not establish
loss of Internet. Container isolation does not imply host Docker or SSH access;
provide separately authorized, scoped integrations when those are needed.

The capability summary lists only registered diagnostic categories and explicitly
does not grant tool access. It is not a substitute for live discovery, policy
checks, exact tool evidence or governed self-repair approval.
