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

Exact run results are recorded after execution; an unexecuted gate is not a pass.

## Still open

Existing production writable-bind adoption and exclusive restart ownership;
actual remote sink enforcement and complete installation writer inventory;
automatic peer inventory advancement between releases; installation-specific
peer application health; the combined original production fault to recovery
proof. Signatures/native installer and all existing RC gates remain in scope.
No old production containers, memories, tokens, keys or configurations were copied
into this public release.
