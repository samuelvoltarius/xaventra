# 2.78.18 automatic publication acceptance

Runtime source: `c57ccc1b67016aa41c0e3894281dc2a8f6409cf5`.
Core/Desktop manifests and lock roots are synchronized to 2.78.18.
This is bounded subsystem evidence, not production activation or an RC.

## Actual runs, distinguished from fixture assumptions

| Check | Result and source |
| --- | --- |
| Windows Core regression | 211 files / 1,438 tests at `41090b0554d1fc5c6f74f53cd918289255e5564b`; final runtime differs only by trusted-image Git dependency. |
| Desktop bridge/unit tests | 7/7; not packaged UI acceptance. |
| Build, typecheck, generated catalogs | Passed locally. |
| Actual Windows daemon/own-PID restart fixture | 7/7 assertions; exit 0 confirmed. Startup 18,839ms, shutdown CLI 154ms; scripted loopback provider. |
| Automatic isolated build/image/source publication | 6/6 on clean Linux arm64 `c57ccc1`, 2026-09-08T23:28:23Z. Actual compiler, Docker, background writer, state copy and HTTP predicate; fixture lease/admission. |
| Actual state clone/rollback preservation | 4/4 on clean Linux arm64 `c57ccc1`; external-writer attestation is a fixture. |
| Real Qwen Doctor/native Kernel/sandbox/signed Docker recovery | 7/7 on clean `41090b0`, 2026-09-08T23:26:39Z. Existing pre-prepared artifact path, **not** a claimed continuous live-model-to-new-publisher run. |

The Qwen run used immutable expected answer 358, investigation
`doctor-research-aa98360a-1067-4cfd-adff-4d3afb38f60a`, candidate
`doctor-candidate-7db72105-be35-4d78-829e-8ab37ee6e0dc`, activation
`repair-b16393fa-334b-4838-8099-abee288f547f`. Lease/grants and fault remain
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
