# Xaventra 2.78.33 verification

## Scope

This candidate closes one bounded RC blocker: a correction or user reset must
remain authoritative after process restart and controlled successor merge. A
stale or partitioned writer must not revive an older value. User scopes must not
leak into each other.

## Evidence classes

| Class | Result | Evidence |
|---|---|---|
| Source regression | Passed | `memory-governance.test.ts` and integration tests cover correction, reset, restart, skew and scope isolation. |
| Compiled process acceptance | Passed on Windows | `npm run check:memory-convergence` starts five isolated Node processes and separate leader/successor/partitioned stores. |
| Hosted CI | Passed | Runtime `482788be94d5025e53956ff98689cada3e6c9ccc` passed all ten jobs in [CI 35510934212](https://github.com/samuelvoltarius/xaventra/actions/runs/35510934212), including the uploaded convergence report on Windows, Linux and macOS. |
| Physical-node / live channel | Not claimed | No physical Mesh partition, Telegram session or production node was used. |

## Local acceptance

- TypeScript typecheck: passed.
- Build: passed.
- Focused memory/RBAC regression: 19/19 passed.
- Five-process convergence: passed with correction/reset restart, user
  isolation, clock-skewed stale-writer rejection, disconnected-correction
  rejection and deliberate re-entry.
- Full Core regression: 228 files / 1,561 tests passed. The first nested
  Windows-worktree run had one infrastructure failure because Git could not
  read the disposable publication fixture through the legacy path-length
  limit. The affected 8/8 test file and then the complete suite passed with
  Git's supported `core.longpaths` process setting; no product assertion or
  test was changed.

## Known limits

- This change does not prove physical-node failover or live channel continuity.
- Existing legacy records without an explicit lifecycle generation are read as
  generation 1 and are upgraded as they are changed or merged.
- Staged Gitleaks found zero secrets. The complete public history at the runtime
  commit contains 96 commits / 10.76 MB and has zero Gitleaks 8.30.1 findings.
- This evidence attestation requires its own exact green CI before normal
  fast-forward promotion and signed release publication.
