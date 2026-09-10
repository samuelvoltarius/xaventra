# 2.78.22 verification — container update controller

This is not full RC acceptance, native signing, or a production rollout report.

## Exact source acceptance

Implementation source `87fb0bd0857fc6358a4c29d4502d563e56d63bf2` passes
[all ten CI jobs](https://github.com/samuelvoltarius/xaventra/actions/runs/34504399346):
Windows/Linux/macOS verify and Desktop, actual Docker recovery/state/publication/
update/rollback, managed activation, full isolated repair regression/rollback and
legacy dashboard. Earlier corrected source `1deb0fd9138dd52099af45bc6819249bf8bd5e8b`
also passes [all ten jobs](https://github.com/samuelvoltarius/xaventra/actions/runs/34503658986).

The clean Linux arm64 checkout of `87fb0bd` independently passes the four real
container-update checks and seven packaged lifecycle checks. Exact image:
`sha256:0baede1176a52490b737c36c89ca35e13b9bfe169a658e9336b9eed58c8b21b0`.
That isolated packaged run starts in 1,265ms and stops normally in 88ms. No live
Telegram, production lease, live model, or cross-node handover is claimed.
Public-history scan at the initial runtime commit: 63 commits, zero findings;
subsequent source changes also pass staged scanning. Documentation-only follow-up
commits preserve these code identities; their CI must also pass before promotion.

## Implemented

- Protected current-main CI publisher, native image architectures, signed bounded
  descriptors and draft-first preview asset publication. No stable/RC label is
  inferred from a successful update-path test; stable clients ignore previews.
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
- Actual arm64 update image also passed packaged daemon start, authenticated REST,
  unauthenticated rejection, CLI stop, normal exit and marker cleanup: 7/7.
  Startup 1,312ms / shutdown 88ms in the isolated loopback-provider fixture.
  This is not the production configured Mesh shutdown path. Package checks now
  run in both native publisher builds before signing a visible release.
- First fixture run correctly refused a SIGKILLed PID-1 baseline; added graceful
  fixture shutdown. Second run exposed its random port changing on rollback;
  enrolled a fixed port. Failed reports retained; neither is a production fix.
- Production driver now refuses SIGKILL/OOM snapshot points. This does not solve
  an application's underlying shutdown hang.

## Remaining separate gates

- Public publisher/download gate **passed** on 2026-09-10 at 17:17 UTC:
  main `6e55f325a61dec7bebc19f8937f407ac25d56817`,
  [main CI](https://github.com/samuelvoltarius/xaventra/actions/runs/34506110426)
  and [automatic publisher](https://github.com/samuelvoltarius/xaventra/actions/runs/34506915056)
  both succeeded. The [preview release](https://github.com/samuelvoltarius/xaventra/releases/tag/v2.78.22)
  was created automatically with complete signed assets after native packaged
  lifecycle checks. Independent anonymous GitHub downloads verified the signature,
  both archive hashes, decoded descriptors and anonymous GHCR manifest body hashes.
  A changed source SHA in the signed payload was rejected. This is not activation.
- Release ID: `2.78.22-7a21e5ef3870bbdd35ea33eee98547d5f8f789ae2fdda77b10ae0525ba20e0f5`.
  x64 image: `sha256:606d8cb8f962f9e819c57afba0e305ba1baf792747ba1304bafaa0db3d1699fd`;
  arm64 image: `sha256:b8e9ec9e5561a89837bbab08ec537ecac63d16c79d543950acfb078828f9859a`.
  Initial anonymous access returned HTTP 403 before package creation; retained as
  pre-publication evidence, superseded by the verified public digest reads.
- Per-node confined baseline/template, controller, independent authority/drain,
  complete writer/sink inventory and acceptance oracle; no writable-bind adoption.
- Public-release-to-production canary; unrelated native, chat/tool and Mesh RC gates.
