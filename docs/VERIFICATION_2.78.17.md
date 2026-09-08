# 2.78.17 maintenance admission evidence

Bounded protocol change, not production activation or RC acceptance. Core/Desktop
versions and locks are synchronized. Public source baseline is
`231563aa31de07db8196a337b004df41f0e40ef4` (2.78.16); this is not the identity of
the new candidate. Final source identity and CI must be recorded before promotion.

## Local pre-commit evidence (Windows, working tree)

- Core: **209 files / 1424 tests passed**, 50.48 seconds.
- Desktop unit/bridge tests: **7/7**; typecheck and compiled build passed.
- Real signed HTTP with two disposable node processes: **5/5**. One process
  executes a held file write; another cannot start after maintenance admission
  closes. Killing a worker leaves its action pending across coordinator restart.
- Existing separate controller/live HTTP predicate acceptance: **4/4** with real
  disposable processes and fixture deployment adapter; no live model involved.
- HTTP regressions require independent signed resolved/rollback receipts and
  demonstrate retry of failed reopening without deploying again. Authority
  rechecks lease/grant after drain completion. Unknown actions cannot be renamed
  into completion-bounded actions.

The first registry test failed because the test imported a nonexistent singleton
instead of `getToolRegistry`; the test import was corrected, not the assertion.
The full suite then passed. Retain this negative with previous release reports.

## Required exact-candidate CI

The existing ten jobs plus the new acceptance steps inside three-OS `verify`
must all pass for the candidate SHA. Compiled `repair-drain-qa-*` artifacts carry
source revision, dirty flag, platform, timestamps and case-level results. Docker
repair, real isolated sandbox/state and managed Linux acceptance remain separate
jobs; none are inferred from the admission protocol tests.

## Still open

No production containers, keys, leases or services changed in this source round.
The coordinator is opt-in, not quorum-based, and does not cover unregistered
module calls or background writers. State authority deliberately refuses missing
drain observation. The initial completion policy is narrow; unclassified actions
block repair until independently reconciled. Full artifact build/sign/source
advancement, container adoption, external-writer fencing and original production
symptom recovery remain open. See [the recovery guide](REPAIR_DRAIN.md).
