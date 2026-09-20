# Xaventra 2.78.32 verification

## Scope

This candidate closes the managed-repair identity-marker race observed in the
hosted Linux acceptance and the packaged Linux Desktop transport failure found
by the first candidate run. It does not claim production activation, general
self-repair completion or RC readiness.

## Reproduction

The managed controller previously checked for `.nova.pid` and then read it as
two separate filesystem operations. During authenticated shutdown the runtime
could remove the marker between those operations, producing `ENOENT`. Because
the controller marks activation as potentially mutating before invoking the
driver, a failure before the durable release pointer advanced then attempted a
rollback from the candidate ID and reported a second, misleading fenced-CAS
failure.

## Implemented contract

- Read optional PID and control markers in one bounded operation; `ENOENT`
  means absent, while malformed or oversized records remain errors.
- Require the candidate control record, PID marker, spawned PID and canonical
  runtime root to agree before managed startup is accepted.
- If activation entered the driver but the release pointer is still the
  approved prior release, restart that immutable prior release during rollback.
  Any third release ID remains fenced.
- Make the disposable acceptance runtime delete only markers still owned by its
  exact instance and PID.
- Use Node's bounded HTTP/HTTPS client in Electron's main process instead of
  global `fetch`. Redirects are not followed, request abort deadlines remain
  active and response bodies are capped at 2 MB.

## Evidence

### Source and isolated regression

- TypeScript typecheck: passed on Windows.
- Build and generated runtime-catalog check: passed on Windows.
- Focused daemon-control and activation regression: 2 files, 30 tests passed on
  Windows.
- The first full Core regression with four workers exposed one unrelated
  five-second timeout in `src/core/autonomy-doctor-dispatch.test.ts`; the
  failure is retained as negative evidence. The targeted file then passed in
  three separate runs, and the CI-equivalent two-worker full regression passed
  228 files and 1,560 tests.
- Static runtime/layer loading: 9 core modules and 40 service modules passed.
- Packaged Desktop Core regression: 9/9 passed on Windows, including real
  loopback requests proving global `fetch` is not used, redirects are not
  followed and oversized responses are rejected.
- A locally packaged Windows Electron acceptance reached package creation but
  timed out while launching the GUI in the restricted runner before any UI
  assertion executed. It is not counted as product acceptance; the exact
  hosted packaged checks remain authoritative.
- Release-readiness correctly remains blocked in the isolated checkout because
  it has no deployment configuration, audit metadata could not be fetched and
  no external-agent comparison artifact exists. These RC gates were not
  relabelled as complete.

### Real isolated process acceptance

The compiled managed-repair acceptance requires a disposable Linux root
controller and a separate non-root runtime UID. It exercises signed immutable
releases, authenticated process shutdown, independent HTTP fault/health probes,
successful activation, failed-candidate rollback and startup-failure recovery.
The fixture now asserts correlated PID and control markers and deterministically
injects a failure after old-runtime shutdown but before release-pointer advance;
the approved prior runtime must be restarted and independently observed. The
exact `managed-repair` job passed in both candidate runs; the corrected runtime
commit also passed `repair-sandbox` and `docker-repair` without a rerun.

### Hosted platforms and public history

Initial candidate `805d6d7accaffbf9558f3a09682f3fe0716445ef` passed the
managed-repair job on its first run, including the deterministic
post-stop/pre-pointer rollback case. The overall
[CI 35497948342](https://github.com/samuelvoltarius/xaventra/actions/runs/35497948342)
failed because Electron 44's Linux main-process global `fetch` reached Undici
without `performance.markResourceTiming`; setup remained reachable but the
composer never recovered after saving the connection. That failure is retained,
not rerun away.

Corrected runtime `e915421f8353015a106ca05d1b04de190a673c25` passed all ten
jobs in [CI 35503318716](https://github.com/samuelvoltarius/xaventra/actions/runs/35503318716)
on the first exact run. Packaged Desktop acceptance passed on Linux, Windows and
macOS. The Linux job exercised the packaged UI contract, recovery from setup to
an actual isolated Core, and a full-daemon restart under Xvfb. The complete
94-commit public history was scanned with Gitleaks 8.30.1: 10.74 MB scanned and
zero findings. This documentation attestation still requires its own exact-SHA
green CI before any promotion.

### Live/production

Not run. No production instance was changed. Physical-node activation,
Telegram/Desktop continuity and production recovery remain open RC gates.

## Rollback

Select release 2.78.31. The marker reader and rollback branch do not change
stored user data or release manifests. A rollback must still pass the same
authority, immutable-artifact and independent restoration checks.
