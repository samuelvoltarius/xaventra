# 2.79.4 Stufe 1 (sees itself, suggests only)

- Source: `claude/autonomy-plan` b875761 on top of 2.79.3 (f7627ea), CI
  36778810816 green; full suite 483 files / 3239 tests, `tsc --noEmit` 0.
- Doctor fingerprint and `diagnostic` runs: `src/doctor/doctor-stufe1.test.ts`;
  both fail with the fix reverted. Live source: Spark `failure-research.json`,
  175 cases, one case investigated 35 times.
- `auto_provision` refuses: `src/tools/auto-provision-disabled.test.ts`.
- Host-key policy guard: `src/security/ssh-host-key-policy.test.ts` (no
  `StrictHostKeyChecking=no` in src). Measured against ns2: `=no` connects with
  a wrong key, `accept-new` refuses.
- Knotenprofil and receiver bounds: `src/core/node-profile.test.ts`,
  `src/mesh/peer-profile.test.ts`.
- Phantom runtime: `src/mesh/capability-graph-phantom.test.ts`, fails without
  the fix.
- Claude handoff: `src/doctor/claude-handoff.test.ts`; delivered once live to
  the Agentic OS and read back.
- Release review: the added `case 'nodes'` was unreachable behind the existing
  `/nodes` command and was removed; `/knoten` and `/setup knoten` remain.

Pending: candidate CI, main CI, signed publication, production activation,
live acceptance (`/knoten` four profiles, Doctor at most one investigation per
case and day, phantom gone on Spark and ns2).
