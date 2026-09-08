# 2.78.18 automatic publication acceptance

Final runtime source: `b6f87a3de7868964e07855a355bb622922e675a3`.
Core/Desktop manifests and lock roots are synchronized to 2.78.18.
This is bounded subsystem evidence, not production activation or an RC.

## Actual runs, distinguished from fixture assumptions

| Check | Result and source |
| --- | --- |
| Windows Core regression | 212 files / 1,439 tests with final dependency updates; no skipped/relaxed regressions. |
| Desktop bridge/unit tests | 7/7; not packaged UI acceptance. |
| Build, typecheck, generated catalogs | Passed locally. |
| Actual Windows daemon/own-PID restart fixture | 7/7 assertions; exit 0 confirmed. Startup 18,839ms, shutdown CLI 154ms; scripted loopback provider. |
| Automatic isolated build/image/source publication | 6/6 on clean Linux arm64 `b6f87a3`, 2026-09-08T23:39:57Z. Actual compiler, Docker, background writer, state copy and HTTP predicate; fixture lease/admission. |
| Actual state clone/rollback preservation | 4/4 on clean Linux arm64 `b6f87a3`; external-writer attestation is a fixture. |
| Signed controller/child process/original HTTP predicate | 4/4 on clean Linux arm64 `b6f87a3`; fixture deployment adapter, no production/model. |
| Real Qwen Doctor/native Kernel/sandbox/signed Docker recovery | 7/7 on clean `b6f87a3`, 2026-09-08T23:40:53Z. Existing pre-prepared artifact path, **not** a claimed continuous live-model-to-new-publisher run. |

The final Qwen run used immutable expected answer 495, investigation
`doctor-research-441e4b16-6715-4099-980e-9e3aa13bb3bd`, candidate
`doctor-candidate-beee48a7-cdc8-4495-8d3b-55a3ed403d6c`, activation
`repair-38d7e2a6-b3d7-4e1b-ab61-c99aa9867a6e`. Lease/grants and fault remain
disposable fixtures. No production container, channel, configuration or key was
changed. New publisher acceptance is a separate actual execution, not a fabricated
combined score.

## Retained negatives and fixes

- Previous main CI [34276726942](https://github.com/samuelvoltarius/xaventra/actions/runs/34276726942)
  failed Windows own-PID lifecycle acceptance after successful CLI shutdown and
  marker cleanup. The test now awaits the parent's actual daemon exit event,
  bounded to five seconds, and still requires exit code zero.
- Initial publisher fixture tests used an empty required Vitest config. Corrected
  fixture contents; no assertions removed.
- Actual `2bc8d04` volume preparation failed. The restricted helper changed owner
  before mode and lacked FOWNER afterwards. Mode is now set before ownership
  transfer, without granting another capability; real Docker rerun passes.
- Full source sandbox at `41090b0` failed seven publisher tests with `git ENOENT`.
  The trusted dependency image now includes real Git; tests are not skipped.
  Negative report is retained separately from subsequent runs.
- Candidate CI [34290984686](https://github.com/samuelvoltarius/xaventra/actions/runs/34290984686)
  passed Docker publication, complete sandbox and all packaged Desktop jobs, but
  failed the dependency assurance gate on all three OSes. Newly indexed
  [sharp/libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) and
  [Hono](https://github.com/advisories/GHSA-g6gw-c38x-mqfc) advisories were not waived.
  The candidate now requires sharp >=0.35.4 and Hono >=4.13.5, updates the lock/SBOM,
  and adds actual native image decode/resize coverage. Local runtime audit is
  0 findings; full development audit still has two moderate findings. Final full
  regression is 212 files / 1,439 tests plus 7 Desktop unit tests.

Receipt completion was additionally checked with parallel actual HTTP status
queries and controller restart: failed completion retries, successful completion
does not redeploy/reopen writers. Each unresolved attempt uses its own inventory.

Candidate CI [34291717368](https://github.com/samuelvoltarius/xaventra/actions/runs/34291717368)
subsequently cleared Core assurance but failed the separate Desktop dependency
audit for newly indexed [js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
The Desktop build dependency is updated to the 4.3.2 floor, not excluded from audit.

## Promotion and remaining gates

Final exact-commit ten-job CI must pass, including complete four-phase sandbox,
actual publication, all three OS lifecycle checks and packaged Desktop, before
normal main promotion. No use of predecessor green CI for a different candidate.

The [operational contract](REPAIR_PUBLICATION.md) enumerates unresolved production
requirements: complete writer/host/sink enrollment, independently enforced remote
sink fences, controlled restart ownership, shared-state peer migration and actual
original production failure recovery. Health warning callbacks and unclassified
tools are not silently labeled bounded. Native signed installers, full distributed
HA and the broader RC matrix remain open.
