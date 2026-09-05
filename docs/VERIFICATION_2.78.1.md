# Xaventra 2.78.1 verification record

This patch continues the [2.78.0 runtime verification](VERIFICATION_2.78.0.md).
It does not replace the evidence boundaries in that record.

Local patch verification on 2026-09-05: **163 test files / 1,063 tests passed**,
four Desktop bridge tests passed, and typecheck, build, catalogs and assurance
passed. The real local-model acceptance suite was rerun at 20:13 UTC and passed
**8/8** again, with four verified file reads over eleven model calls. Runner
durations ranged from 0.990 to 3.163 seconds, excluding process bootstrap.
These are eight narrow tasks, not a general success-rate or speed guarantee.

## Preserved failure and regression

The [first three-OS candidate run](https://github.com/samuelvoltarius/xaventra/actions/runs/33988917006)
passed Windows, Linux and dashboard checks, but failed one macOS assurance test
(1,060/1,061 tests passed there). The check compared a subprocess's working
directory to its requested path as plain strings. Directory aliases such as
`/var` and `/private/var` can identify the same directory with different strings.

The check now compares existing canonical directory paths, still requires the
child to exit successfully, and emits expected/observed paths when it fails.
Regression tests exercise a real directory alias (junction on Windows, symlink
on Unix) and reject a different directory, missing path or regular file. There
is no macOS skip or weakened policy, plugin, evidence or promotion assertion.
Working-directory identity alone is not a filesystem sandbox guarantee.

The exact-commit hosted CI result is authoritative for the three platform jobs.
Installer and source tests do not prove all GPUs, NAS variants or signed Desktop
packages work. See [the remaining release gates](RELEASE_PLAN.md).

## Additional isolated evidence

- The 2.78.0 compiled daemon reached its authenticated HTTP status endpoint on
  Windows after 25.3 seconds, using a fresh temporary home/configuration and a
  scripted loopback model fixture. It reported version 2.78.0. This proves boot
  and HTTP liveness, not live model reasoning, Telegram delivery or failover.
- All 100 deterministic subsystem probes passed with an injected advisory
  planner. Their report explicitly records `subsystem-probes` and
  `autonomousTaskCompletionMeasured: false`. They are not 100 real agent tasks.
- Separately, the 2.78.0 real-model suite passed eight native-runner cases with
  actual tools, an authenticated REST adapter and fresh-process memory restore.
  The earlier failed runs remain part of the record.

No personal configuration, model endpoint, raw transcript or production state
is published with these results. No production node was updated by this loop.
