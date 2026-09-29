# 2.78.57 bounded verification

Candidate revision: `24b835b62cfed57887ee8160fa7e95be6f392be3`.
[Exact candidate CI](https://github.com/samuelvoltarius/xaventra/actions/runs/36503987699)
passed all ten jobs: Core verification and Desktop smoke on Windows, Linux and
macOS, plus legacy dashboard, managed repair, Docker repair and repair sandbox.
This candidate result is distinct from evidence-commit and main verification.

## Local and isolated evidence

- Local Core regression: 266 files / 1,986 tests passed before the additional
  canonical-root refusal regression; the final three affected files pass 42
  tests. TypeScript build, runtime catalogs and assurance checks pass. Runtime
  dependency audit reports zero critical/high and two moderate advisories.
- Compiled response-contract checks pass 5/5; actual isolated message-pipeline
  checks pass 4/4. Canonical state and terminal-success authority checks pass.
  Provider replies in those fixtures are scripted, not live model acceptance.
- A clean checkout at runtime source
  `56e43c06b45891aa81849b754aad6b3c6f148da2` built the actual 2.78.57 Linux arm64
  production payload. Package/lock identity, file hashes, executable modes,
  architecture headers and the generated archive were independently checked.
  The 217,478,550-byte archive contains 16 qualified ELF binaries and has SHA256
  `086bc1b7d36e96b1ec34acfc9a27ccfd7c7b44955fb0fe481eb91baf7208e583`.
- That same actual payload passed all seven isolated daemon checks: correct
  version, authenticated REST status, anonymous rejection, successful CLI stop,
  normal daemon exit, and removal of the two instance markers. Configuration
  and provider were disposable/loopback; production state was not used.
- Core runtime source/scripts/manifests are unchanged between the arm64 build
  commit and the candidate revision above. Follow-up changes regenerate
  catalogs, canonicalize fixture paths and update Desktop build dependencies;
  they do not change that native Core payload.

## Negative evidence retained

The initial actual native payload contained 13 Windows Tint/CEF binaries.
Removing the unused direct dependency preserved Playwright but exposed the
overbroad private-path matcher. Both negative reports remain retained. Narrow
public dependency metadata admission preserves `.git`, Git credentials/config,
environment, runtime, private-memory and key-file rejection.

The new Telegram channel-case regression failed before correction. Real remote
capture remained policy-denied before execution; a connected bot is not image
delivery evidence. The error is now preserved rather than hidden by a generic
no-image reply. No production screenshot success is claimed.

The first local full-suite failure was Windows Git's long-path limitation in a
nested disposable fixture. Per-process `core.longpaths=true` made the unchanged
assertions pass. Initial macOS CI rejected noncanonical temporary fixture paths
through the system `/var` alias. Fixtures now supply canonical paths; the
production guard is unchanged and a new symlink-root negative test covers it.
The first catalog check also failed and generated catalogs were refreshed.
The subsequent three-platform dependency audit correctly blocked Desktop's
fast-uri 3.1.6 and flagged undici versions. Compatible lockfile updates to
fast-uri 3.1.8 and undici 6.29.0/7.30.0 produce a clean Desktop audit; its 12
local regression tests pass. The audit threshold was not changed.
Earlier CI runs are not substituted for this exact candidate's checks.

## Release and operational boundaries

Staged and complete public-history secret scans passed before this record.
This evidence/documentation commit needs its own exact green CI, followed by
exact main CI and the signed publisher before release completion.

Native x64 payload qualification, protected native publication/installation,
operator enrollment, real writer fencing and complete native update/rollback
remain open. Existing signed Docker packages do not update native services.
Capture enrollment, an unlocked intended session and real Telegram delivery
with correlated receipts are still required. Source publication does not
activate the corrections in production. See [recovery](RECOVERY_2.78.57.md) and
[native integration status](NATIVE_UPDATE_DRIVER.md). This is not an RC clearance.
