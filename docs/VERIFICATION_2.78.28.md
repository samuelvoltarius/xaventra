# Xaventra 2.78.28 verification

## Reproduced failure

A native `read_file` call with a stale or misspelled path correctly returned a
failure, but the authoritative recovery allow-list did not include `find_files`.
The later generic model recovery could therefore drift into capability discovery
instead of locating the resource. A second defect could infer both a rooted path
fragment and its containing relative path as separate mandatory targets.

## Implemented boundary

- read-only missing-resource classification for `read_file`, `read_document` and
  `code_outline`;
- bounded search rooted at the workspace, or at an existing non-root ancestor
  for an explicitly absolute path;
- one discovery and one retry, using the existing authorization, policy, budget,
  timeout, idempotency and Execution Kernel validation path;
- unique exact-name selection, or a unique fuzzy match at confidence >= 0.82
  with a minimum 0.08 margin;
- cryptographically bound discovery result and auditable requested/resolved
  target mapping on the retry receipt;
- fail-closed ambiguity, mutation, unrelated failure and root-scan controls.

## Evidence before exact-commit CI

- recovery, Kernel and TaskContract: **24/24**, passed;
- TypeScript typecheck: passed;
- first complete local run: **1,550/1,553**; the failures were an outdated local
  `sharp`, a nested Windows Git long-path error and a timing-sensitive witness
  case;
- after clean lockfile dependency installation and process-local Git long-path
  configuration, an unrestricted-worker run reached **1,551/1,553**; both
  five-second timeouts passed **7/7** in immediate isolated reruns;
- the final bounded-concurrency run passed **226 files / 1,553 tests** with no
  skips or weakened assertions;
- build, current runtime catalogs, static layer reachability and runtime import
  checks pass (the latter remains loading evidence, not functional acceptance);
- the actually packaged Windows Desktop passes **5/5** isolated checks covering
  Core authority, a real file tool and linked Outcome, post-tool command routing,
  scoped memory/Trust access and a forbidden-file negative.

Exact runtime `1630b0a2e83174afa553ebd2a67a9c870cc0a33f` passes all ten jobs in
[CI 35479444924](https://github.com/samuelvoltarius/xaventra/actions/runs/35479444924):
Windows/Linux/macOS verification, Windows/Linux/macOS packaged Desktop, legacy
dashboard, repair sandbox, managed repair and Docker repair. The complete public
history (84 commits) produced zero findings with the official, checksum-verified
Gitleaks 8.30.1 binary. This evidence-documentation commit requires its own green
exact-SHA CI before `main` promotion.

## Open gates

- final evidence-commit CI and normal `main` promotion;
- durable hydration of verified native tool receipts after process/node restart;
- wider typed recovery beyond missing read-only resources;
- production Telegram/Desktop adoption and actual failover observation;
- all broader memory, HA, benchmark, installer and signing gates in the release
  plan.

No production service, node, container or model server was changed.
