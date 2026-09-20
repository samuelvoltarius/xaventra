# Xaventra 2.78.38 verification

## Scope

This candidate closes one bounded RC gap: a packaged Desktop owner can approve
one already sandbox-verified Doctor proposal through the canonical gate, obtain
an independently signed terminal live receipt, and restart Core without
repeating the activation effect.

The acceptance uses a disposable loopback repair controller, temporary signing
identities, synthetic source marker and independent scripted probe. It does not
modify a production node and is not evidence of a physical-host rollout.

## Source and regression evidence

- `src/desktop/desktop-api.test.ts`: owner-only receipt projection, secret
  exclusion, fencing, transient token forwarding and terminal no-resubmission.
- `scripts/check-desktop-core.mjs --daemon`: packaged Electron to full compiled
  daemon, canonical approval, signed controller receipt, independent fault to
  healthy observation, one external effect, full Core restart, restored receipt
  and unchanged effect count.
- The existing chat, policy denial, Tool Evidence, Outcome Ledger, scoped
  memory and session-resume assertions remain part of the same full-daemon run.

## Candidate record

| Gate | State | Evidence |
| --- | --- | --- |
| TypeScript | passed | local `npm run typecheck` and candidate CI |
| Unit regressions | passed with retained local infrastructure negative | local Core run passed 1,570/1,571 tests; the sole nested-worktree failure was Windows Git path handling in `repair-publication.test.ts`, which passed unchanged 8/8 with Git's supported per-process `core.longpaths=true`; all platform CI verification jobs passed |
| Full packaged Desktop daemon | passed | local packaged Windows run passed 7/7, including canonical signed activation, terminal receipt display and restart without replay; Windows, macOS and Linux packaged jobs repeated the full-daemon path |
| Staged secret scan | passed | Gitleaks 8.30.1 scanned 18.33 KB, zero findings |
| Candidate CI | passed | runtime `1332ee043db8c722e88a758392626fc0ccbf85f1`, all ten jobs in [CI 35540849173](https://github.com/samuelvoltarius/xaventra/actions/runs/35540849173) |
| Full history scan | passed | Gitleaks 8.30.1 scanned 107 commits / 10.87 MB, zero findings |
| Evidence CI | pending | exact evidence commit and workflow run to be recorded |
| Main CI and signed release | pending | exact main commit, tag and workflow run to be recorded |

## Known limits

- Native signing/notarization still depends on configured platform identities.
- This round proves the packaged Desktop repair-approval boundary only. It does
  not by itself complete every RC gate or claim full production self-repair.
- Production rollout is separately governed and may run only through configured
  signed update profiles after release verification.
