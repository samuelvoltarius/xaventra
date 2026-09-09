# 2.78.19 — shared-state worker recovery

Scope: controlled Docker peer replacement after a main repair, not complete
production self-repair or RC acceptance. The production runtime is unchanged.

## Reproduced defects

At baseline `e4ab636c4bb0d68a84269b26d62024338e24ffb2`, two added regression tests
failed: the first peer restarted before a later peer's changed configuration was
rejected, and a newly introduced unknown shared-state writer was not detected
when peers resumed. Tests now require denial **before any enrolled restart**.
These failures are retained, not removed from the regression suite.

The additional real local-model run at `7c11254283590b02c4a23a50104f8ac4afe37864`
failed on 2026-09-09 07:43:25 UTC after verified investigation: the returned patch
had an extra `reasoning` key. Strict validation correctly prevented activation.
Its report is retained (`xaventra-docker-repair-emkh01`); the Linux checkout's
dirty marker was an untracked dependency symlink, not edited tracked sources.
This result is not relabeled a clean or successful model run. The shared-peer
6/6, publication 6/6 and state 4/4 checks passed separately in that checkout.

The fix preserves the four-key schema. Exactly this observed formatting error
may request one fresh governed candidate, with a distinct Outcome run and fresh
tool evidence, within the original 90-second generation deadline. Rejected hashes
and run IDs remain in the repair record. Unknown authority/path/command fields,
ambiguous searches, no-ops and changed source/oracle remain terminal rejections.
There is no model-granted activation and no infinite retry loop.

## Evidence gates

- Unit regression: peer preparation, lost create/start replies, immutable
  configuration, unknown writers, rollback direction, stale generation and
  previously stopped peers. Simulated Engine, not live Docker proof.
- Actual Docker acceptance: `scripts/check-repair-peers.mjs`, using controlled
  fixture authority and real Linux containers/volumes. Case-level report records
  exact source SHA, dirty status, version and timestamps, including failures.
- Existing publication, state, Doctor, sandbox and cross-platform lifecycle /
  packaged Desktop checks remain unchanged and required.
- Candidate promotion requires every applicable CI job green for the exact SHA.

## Executed acceptance

Runtime source: `cd6ef3684dc580a01e73d3f7c0c629caef3fbbc5`.
[CI 34325848507](https://github.com/samuelvoltarius/xaventra/actions/runs/34325848507)
passed all **10/10** jobs. Downloaded reports confirm this SHA and clean source
for Docker/sandbox/controller/admission; packaged Desktop reports identify the
same source and pass on Windows, macOS and Linux.

| Gate | Result | Evidence class |
| --- | --- | --- |
| Core regression | PASS: 213 files, 1,455 tests | Local Windows at the runtime SHA; three-OS CI also green |
| Desktop regression | PASS: 7 tests | Local Node tests; packaged UI/Core/daemon separately in three-OS CI |
| Signed controller / tool admission | PASS: 4/4 and 5/5 on each OS | Actual disposable processes/HTTP, fixture authorities |
| Shared-state peer migration | PASS: 6/6 | Actual Linux Docker, CI and separate arm64 run at 07:56:55 UTC |
| Automatic publication / state copy | PASS: 6/6 and 4/4 | Actual Linux Docker, CI and separate arm64 runs |
| Full-source sandbox | PASS: 6/6 | Actual four-phase isolated containers in CI; no live symptom claim |
| Doctor-to-Docker original operation | PASS: three runs, 7/7 each | Real local model, native tools, sandbox, signed fixture activation and HTTP/rollback |
| Runtime / Desktop dependency audit | PASS: zero findings | Separate audits; full Core development tree still has two moderate advisories |
| Production adoption / full external writer coverage | OPEN | No production runtime change; prerequisites below |

All three corrected live-model runs are clean-source Linux arm64 at the runtime
SHA. Exact completion times and activation identities:

- 2026-09-09 07:52:11 UTC: `repair-d5d5387e-1f77-4db7-8933-2108811df333`.
- 2026-09-09 07:53:49 UTC: `repair-3cb3798b-9e31-4f04-a0bb-3e34474b7787`.
- 2026-09-09 07:55:30 UTC: `repair-e0932d42-fae8-4720-9f5e-9a42e79e4805`.

These are three controlled fixture runs, not a general success-rate benchmark.
They use prepared fixture images; the automatic publisher and shared-peer path
are tested separately. They do not prove one combined production model-to-publisher
rollout. The preceding failed model run remains in the record. Final documentation
promotion still requires all ten checks on its exact final SHA; see the
[candidate CI](https://github.com/samuelvoltarius/xaventra/actions/workflows/ci.yml?query=branch%3Acodex%2Frepair-adoption-2.78.19).

## Still open

Existing production writable-bind adoption and exclusive restart ownership;
actual remote sink enforcement and complete installation writer inventory;
automatic peer inventory advancement between releases; installation-specific
peer application health; the combined original production fault to recovery
proof. Signatures/native installer and all existing RC gates remain in scope.
No old production containers, memories, tokens, keys or configurations were copied
into this public release.
