# 2.78.23 — bounded Mesh shutdown for container updates

Runtime source: `45ffef027e70ba5b4a3095d2d061ed27a505caa1`.
[Exact-source CI](https://github.com/samuelvoltarius/xaventra/actions/runs/34506974509)
must pass before promotion; documentation-only successors have their own CI.
No production node was changed for these checks.

## Reproduction and regression

- Three new tests failed before implementation: accepted socket without hello,
  non-reading peer and unacknowledged outbound hello during shutdown. Failed JSON
  reports are retained. The first standalone reproduction remained blocked after
  500ms and completed only after terminating its own test peer.
- Direct transport now tracks all sockets, not just authenticated peer mappings.
  Shutdown rejects new connections, settles pending acknowledgements as unreachable,
  closes owned sockets and bounds the socket handshake to one second. It does not
  force-exit the daemon, certify drained writers or bypass the update controller.
- Targeted Mesh regression: **9/9 passed**. Complete Windows source regression:
  **220 files / 1,512 tests passed**; typecheck/build, dependency assurance, catalog
  checks and all **7 Desktop tests** passed. This is not agent-task completion data.

## Real process and package acceptance

The compiled daemon runs in an isolated data directory with a synthetic loopback
provider and no real Telegram account or external Mesh. An actual WebSocket client
connects to its direct listener, sends no hello and stops reading. That client stays
connected throughout the CLI stop operation; only fixture resources are cleaned up.

- Windows compiled daemon: **8/8 passed**, startup 24,427ms, CLI stop 1,152ms,
  exit code zero, owned control/PID markers removed.
- Clean Linux arm64 source: **8/8 passed**, startup 2,236ms, stop 1,109ms.
- Actual locally built arm64 image from the same clean source:
  `sha256:ff521d1ca262f9e02d17333af849ff2306fdc445ab31e42060cddd9c6da17ef9`.
  Packaged daemon **8/8 passed**, startup 1,526ms, stop 1,101ms. It ran read-only,
  non-root, capability-dropped and network-isolated; the test peer was loopback
  inside that container. No host dist was substituted for the packaged runtime.
- The same idle-peer acceptance is now required by the native x64/arm64 publisher
  image gate, as well as three-platform source CI.

## Boundaries

This confirms a specific real shutdown defect and its local fix. It does not prove
that this was the only cause of a production stop failure. Production adoption
still requires a confined baseline, independent approval/authority/drain, complete
writer fencing and a real canary. See [container update enrollment](CONTAINER_UPDATES.md).
The previous [2.78.22 publication](VERIFICATION_2.78.22.md) was independently verified
against public GitHub and GHCR; that is separate from this follow-up's publication.
No broad RC, fault-free, production-failover or live-model claim is made here.
