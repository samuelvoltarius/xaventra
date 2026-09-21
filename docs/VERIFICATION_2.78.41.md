# Xaventra 2.78.41 verification

## Scope

This candidate hardens screenshot evidence inside the existing packaged
Desktop acceptance. It does not add product features, change production nodes,
or claim complete RC readiness.

## Reproduced defect

The first evidence CI run for 2.78.40 reached the packaged Linux UI but failed
while capturing a screenshot because `page.screenshot()` inherited the general
ten-second UI timeout. Retrying the exact unchanged failed job passed. That is
a verified transient evidence-harness failure, but relying on an unrecorded CI
retry makes the release proof less deterministic.

## Change

- Capture evidence JPEGs with their own 30-second deadline.
- Disable animations during capture.
- Retry one transient capture failure after a bounded delay.
- Keep a repeated failure terminal.
- Persist the attempt count and timeout for every screenshot in the acceptance
  report.

## Local evidence before candidate publication

| Evidence class | Result | Boundary |
|---|---|---|
| Screenshot helper regression | 3/3 passed | Explicit deadline, one recovery, repeated failure remains terminal |
| Desktop unit regression | 12/12 passed | Desktop main-process and evidence-helper contracts |
| TypeScript/build | Passed | Windows source |
| Runtime catalogs | Current | Generated inventory |
| Runtime module load | 9 core and 40 service modules loaded | Import/wiring evidence only |
| Disposable packaged interaction | 10/10 checks passed | Exact Desktop source in ASAR with locked Electron runtime; simulated local Core |
| Screenshot evidence | 5/5 captured on attempt 1 | Windows local compositor, 30-second per-image deadline |

The local `electron-builder --dir` copy step did not finish in the restricted
sandbox. The disposable acceptance therefore assembled the exact Desktop files
and locked Electron distribution into an ASAR. This proves the changed capture
path against a packaged Electron process, but not the official installer or
electron-builder output. Hosted CI remains the authoritative package build.

## Required publication evidence

- Exact candidate CI green on Ubuntu, Windows and macOS.
- Uploaded reports show all interaction checks and screenshot metadata.
- Full Core regression green on the exact candidate.
- Full-history secret scan, evidence-commit CI, main CI and signed release.

## Remaining gates

- Physical-host partition with lease/fencing, mission takeover and memory
  convergence.
- Signed updater enrollment and broader install/update recovery evidence.
- Native signing/notarization identities where the platform requires them.
- Remaining gates in `docs/RELEASE_PLAN.md`.
