# Xaventra 2.78.32 verification

## Scope

This candidate closes the managed-repair identity-marker race observed in the
hosted Linux acceptance. It does not claim production activation, general
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

## Evidence

### Source and isolated regression

- TypeScript typecheck: passed on Windows.
- Build and generated runtime-catalog check: passed on Windows.
- Focused daemon-control and activation regression: 2 files, 30 tests passed on
  Windows.
- Full Core regression: 228 files, 1,560 tests passed on Windows with four
  workers.
- Static runtime/layer loading: 9 core modules and 40 service modules passed.
- Packaged Desktop Core regression: 7/7 passed on Windows.
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
the approved prior runtime must be restarted and independently observed. Exact
hosted result: pending.

### Hosted platforms and public history

Candidate CI, complete-history secret scan and evidence-commit CI: pending.

### Live/production

Not run. No production instance was changed. Physical-node activation,
Telegram/Desktop continuity and production recovery remain open RC gates.

## Rollback

Select release 2.78.31. The marker reader and rollback branch do not change
stored user data or release manifests. A rollback must still pass the same
authority, immutable-artifact and independent restoration checks.
