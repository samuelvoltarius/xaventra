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
| TypeScript | pending | exact candidate command and result to be recorded |
| Unit regressions | pending | exact candidate command and result to be recorded |
| Full packaged Desktop daemon | pending | exact candidate artifact and report to be recorded |
| Staged secret scan | pending | exact candidate scan to be recorded |
| Candidate CI | pending | exact commit and workflow run to be recorded |
| Full history scan | pending | exact commit count/bytes/findings to be recorded |
| Evidence CI | pending | exact evidence commit and workflow run to be recorded |
| Main CI and signed release | pending | exact main commit, tag and workflow run to be recorded |

## Known limits

- Native signing/notarization still depends on configured platform identities.
- This round proves the packaged Desktop repair-approval boundary only. It does
  not by itself complete every RC gate or claim full production self-repair.
- Production rollout is separately governed and may run only through configured
  signed update profiles after release verification.
