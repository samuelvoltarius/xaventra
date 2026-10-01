# 2.80.0 Stufe 2, Stufe 3 and screenshot fallback

- Integration of `claude/screenshot-fallback` 95f3705 (CI 36803595496),
  `claude/stufe2` b8ff668 (CI 36804760152, 10/10) and `claude/stufe3` c094789
  (CI 36804476390, 10/10) on top of 2.79.4 (f589d90). Only conflict:
  generated `docs/generated/README.md`, regenerated.
- Full suite on the integration: 494 files / 3338 tests, `tsc --noEmit` 0.
- Screenshot fallback: `src/core/screenshot-fallback-trigger.test.ts`,
  `src/agents/read-only-tool-failure.test.ts`; each fix reverted alone turns
  its test red. Live cause read from the Spark journal 01.10. 00:13
  (`load_skill_pack("system")` scored as failure, run stopped).
- Benchmark intent: `src/benchmark/nova-benchmark-intent-path.test.ts`, red
  without the fix.
- Stufe 2: catalog, ticket, host-agent and setup tests; ten safeguards each
  reverted alone turn tests red (never-list, metacharacters, expiry,
  signature, free commands, owner check, YOLO level, worker ticket, resource
  guard, autoremove).
- Stufe 3: `src/doctor/self-heal*.test.ts`, `autonomy-loop-selfheal.test.ts`;
  rollback, never-list, path boundary, fencing, worker reporting, kill switch,
  cooldown, two failures and proposal-only each reverted turn tests red.

Pending: candidate CI, main CI, signed publication, production activation.
Live acceptance: Stufe 2 first isolated (WSL: ffmpeg install, rollback,
package list identical), then Spark with host-agent keys; Stufe 3 drills
ns2 → ns1 → Spark, NAS without restart proposals.
