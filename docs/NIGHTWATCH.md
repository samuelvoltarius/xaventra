# Nachtwache

Read-only watch over services, disks, backups and cron targets on the local
node and on remote hosts. It only observes; it never restarts, deletes or
repairs anything. Repairs stay a separate, owner-approved action.

Code: `src/doctor/nightwatch-checks.ts` (probes), `src/doctor/nightwatch.ts`
(run, journal, autonomy adapter). Example config: `nightwatch.example.json`.

## Check kinds

| kind | Observes | Fixed command (argv, no shell) | Default severity |
|---|---|---|---|
| `http` | Service answers with an expected status (default 200–399, no redirects followed) | `fetch` from the daemon | critical |
| `systemd` | Unit is `active` | `systemctl [--user] is-active -- <unit>` | critical |
| `disk` | Fill level of a mount | `df -P -k -- <mount>` | warning ≥ `warnPercent` (85), critical ≥ `critPercent` (95) |
| `backup` | Newest file in a folder is younger than `maxAgeHours` | `find <dir> -maxdepth 1 -type f [-name <pattern>] -printf %T@\n` (GNU find) | warning |
| `file` | A path exists (and is executable), e.g. a cron target | `test -f|-x <path>` | warning |

Config values are validated before use: unit names, absolute paths without
`.`/`..`, `user@host` SSH targets, http(s) URLs without credentials. Config can
never supply a command. Remote probes run via `ssh -T -o BatchMode=yes -o
StrictHostKeyChecking=yes`, each argument single-quoted for the remote shell.

## Result classes

- `ok`: observed and fine.
- `fehler`: observed and wrong (service down, backup too old, script missing,
  HTTP target unreachable from the daemon).
- `unbekannt`: could not observe (SSH exit 255, timeout, command missing,
  permission denied). **Never counted as ok.** Always reported as a warning, so
  it lands in the daytime bundle instead of waking anyone at night.

Every result carries evidence: host, command, exit code, redacted output
excerpt (≤ 400 chars), duration and timestamp.

## Alarm policy

`createNightwatchSource()` returns a function producing the autonomy loop's
`CheckResult[]`. The loop already implements the policy:

- `critical` notifies at any hour,
- `warning` notifies only outside quiet hours (default 23–7),
- repeated identical findings are deduplicated by fingerprint.

All green yields a single `info` line without notification. A missing or
invalid config yields a warning (`Nachtwache läuft nicht: …`), never silence.
Probes re-run at most every `intervalMinutes` (default 30); concurrent callers
share one run.

## Journal

One JSON line per run in `<journalDir>/<UTC-date>.jsonl`, directory `0700`,
files `0600`. `readLatestNightwatchReport()` returns the newest intact report
and skips corrupt lines. The morning briefing reads from here.

`formatNightwatchReport(report, principal)` renders findings with evidence for
the owner only; every other principal gets a refusal.

## Activation

The watch is wired into the autonomy loop as check source `nightwatch`
(`src/core/autonomy-loop.ts`) and is **off by default**. To switch it on, set in
the daemon config:

```json
"autonomy": { "nightwatch": { "enabled": true } }
```

Optional `configPath` (default `.nova-data/nightwatch.json`) and `journalDir`
(default `.nova-data/nightwatch`). A missing or invalid probe config shows up as
a warning, it never silently disables the watch. Remote hosts need a dedicated
read-only SSH key, ideally restricted on the host side to the commands above.
