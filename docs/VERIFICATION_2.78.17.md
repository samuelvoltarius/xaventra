# 2.78.17 maintenance admission evidence

Bounded protocol change, not production activation or RC acceptance. Core/Desktop
versions and locks are synchronized. Runtime source is
`fc0e3a008f1515dda5048d2098945f3f49a7375d`, based on public 2.78.16
`231563aa31de07db8196a337b004df41f0e40ef4`.

## Clean exact-source acceptance

Downloaded reports from [candidate CI 34275424996](https://github.com/samuelvoltarius/xaventra/actions/runs/34275424996)
identify `fc0e3a008f1515dda5048d2098945f3f49a7375d`, `sourceDirty:false`:

| Evidence class | Result |
| --- | --- |
| Actual signed HTTP/two-process admission, Windows/Linux/macOS | 5/5 each |
| Actual signed controller/disposable process/original HTTP predicate, three OSes | 4/4 each |
| Linux Docker repair, scripted model but actual Kernel/sandbox/controller/containers | 7/7 |
| Actual Docker state copy, fixture quiescence | 4/4 |
| Privileged managed Linux controller with separate runtime UID | 6/6 |

The same clean source separately passed Linux arm64 **5/5** admission and
**7/7 real Qwen/native Kernel/isolated sandbox/signed Docker/original HTTP
recovery** at `2026-09-08T20:36:49.332Z`. Actual state-copy negatives/positive
passed **4/4**. The real-model run's original unchanged assertion expected 622;
the model read source/test evidence and produced the candidate. Investigation
`doctor-research-c965bfe5-3f23-46f2-ac19-0e832440de33`, candidate
`doctor-candidate-75cc1ebd-f55e-4b17-a7e5-201427bdab94`, activation
`repair-0300af92-d44e-4679-895f-4a955a2e3139` identify that disposable run.
Its lease and operator grants remain fixtures, and admission/external writer
coverage is a separate test, not a newly claimed production Mesh proof.

All ten jobs, including full isolated sandbox regression and packaged Desktop,
must be green for the final documentation-attested candidate before main is
updated. A documentation attestation does not reuse a predecessor's CI gate.

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
