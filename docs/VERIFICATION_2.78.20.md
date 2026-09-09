# 2.78.20 verification boundaries

This candidate adds bounded Docker host access. It does not declare the RC,
general self-repair, cumulative token budgets or corrected long-term memory done.

## Reproduced baseline defects

On 2.78.19, a real Telegram Docker-list request called `docker_ps` but failed
because the app image has no Docker executable and no host socket. A later
unrelated time lookup satisfied the generic action-evidence criterion; a
1024-token total budget then rejected the run and masked the concrete error.
The separate real CLI read-file test reproduced that budget masking, while a
file creation plus readback actually passed. Those are different outcomes.

2.78.20 does not solve general budgets by raising or removing the limits. An
unambiguous local Docker inventory request takes a native, zero-inference path,
requires actual host inventory evidence and records its own scoped outcome.
Other non-inventory requests still need the broader budget/validation follow-up.

## Local evidence before final commit

- Windows Core regression: 215 files, 1470 tests passed. Includes 15 new host
  protocol/command cases; fake Engine unit tests are not live Docker acceptance.
- TypeScript build, static 40-module reachability, generated catalogs and
  seven Desktop bridge tests passed. Static imports do not prove module behavior.
- Production dependency audit: no vulnerabilities reported by npm audit at run time.
- Real Linux arm64 Docker/Unix-socket acceptance: 10/10 checks passed at
  2026-09-09T12:01:09Z on a dirty candidate based on `ba0b157ed93d543c4ea16ac3df61b1646ae3f862`.
  Authenticated inventory, filtered status, bounded logs, absent approvals,
  signed stop/start/restart, replay after agent restart and free-exec denial.
  Only a newly created confined fixture was changed and then removed.
- Earlier live negative at 11:58:52Z: seven checks passed, then stale HTTP
  Keep-alive reuse after agent restart caused `EPIPE`. Preserved, not relabeled
  a pass. The host client now opens a fresh Unix connection for every request.
- Separate actual CLI candidate overlay on the deployed dependency image:
  5/5 checks (answer, no model inference, real fixture tool evidence, validated
  ledger outcome, honest unavailable-host response). Network disabled; separate
  runtime and no production secrets, chats, memories or Mesh enrollment.
  This is not the packaged consumer Desktop, live Telegram or automatic discovery.

## Release and production gates

The exact final candidate must pass all ten CI jobs before main promotion.
The existing Docker job now preserves the real host-access report too. Read
the report's sourceRevision/dirty fields; never substitute earlier dirty proof
for exact-SHA clean evidence. Source and runtime Docker variants are distinct.

No production host agent, socket mount, credential provisioning or lifecycle
allowlist was installed by the source patch. Follow [HOST_ACCESS.md](HOST_ACCESS.md)
to enroll a node explicitly. App Docker-group membership and raw socket access
are not an alternative to that enrollment.

Remaining live findings: memory-write intent/tool-contract mismatch, correction
shortcut retaining stale facts, packaged SOUL lookup/fallback name, unnecessary
missing-file recovery, generic action-specific validation, and broad token budget
semantics. They remain open rather than being hidden by the Docker fast path.
