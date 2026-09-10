# 2.78.22 verification — container update controller

Exact final source and CI evidence will be recorded before promotion. This is not
full RC acceptance, native signing, or a production rollout report.

## Implemented

- Protected current-main CI publisher, native image architectures, signed bounded
  descriptors and draft-first asset publication.
- Detached authenticated jobs, exact grants, independent download, pinned image,
  confined Docker driver, state clone, retained backups, acceptance and rollback.
- Durable journals and crash locks; separate normal-update drain reopening.

## Pre-commit development evidence

Runtime implementation: `7250ececa94811015df6aadeb99efdfbb2110536`.
Clean Linux arm64 checkout of this exact revision also passed the four real Docker
checks over the Unix socket. First candidate CI
[34503143517](https://github.com/samuelvoltarius/xaventra/actions/runs/34503143517)
exposed a legacy Doctor fixture relying on SIGKILL; retained as failed evidence.
Fixture servers now handle SIGTERM and finish their writes before exit. The new
driver guard and existing acceptance assertions were not weakened.

- Windows: full regression **219 files / 1,509 tests passed**. Build, catalog check,
  seven Desktop tests and seven compiled upstream HTTP checks passed. Dependency
  audit reports zero findings; external agent comparison is still not recorded.
- Linux arm64 Docker: 4/4 actual fixture checks passed: install and corrected fact
  preservation, bad-canary rollback and restored fact, duplicates on both paths.
  Dirty source, HTTP issuer/authority fixtures and local pinned image, not GHCR.
  Repeated over the actual Unix-socket client path: 4/4 passed.
- First fixture run correctly refused a SIGKILLed PID-1 baseline; added graceful
  fixture shutdown. Second run exposed its random port changing on rollback;
  enrolled a fixed port. Failed reports retained; neither is a production fix.
- Production driver now refuses SIGKILL/OOM snapshot points. This does not solve
  an application's underlying shutdown hang.

## Remaining separate gates

- Dedicated publisher key and main-only GitHub environment are enrolled; only the
  public SPKI key is in source. Workflow activation/live publication and anonymous
  registry availability still need verification after exact-source CI.
  Anonymous canonical GHCR token access returned HTTP 403 before publication;
  the local GitHub login lacks `read:packages`. Neither is treated as public access.
- Per-node confined baseline/template, controller, independent authority/drain,
  complete writer/sink inventory and acceptance oracle; no writable-bind adoption.
- Public-release-to-production canary; unrelated native, chat/tool and Mesh RC gates.
