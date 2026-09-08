# 2.78.15 repair activation verification

Baseline: `e1a47d54a18f3248464cc7c33ea0fcce168aa819` (2.78.14).
Candidate work is on `codex/doctor-activation-2.78.15`; exact candidate CI and
artifact `sourceRevision` fields are required before main promotion.

The removed approval path interpolated patch descriptions into shell Git
commands, stashed/force-checked-out user work, tolerated emitted build failure,
scheduled a name-based restart and reported success before live recovery.
The replacement has no shell/Git mutation/restart sink in the running daemon.
Queued proposal identity, snapshot/oracle, explicit approval and an independent
external controller now govern activation. Legitimate proposal-only calls remain
supported; unbound direct apply requests must migrate to proposal-ID approval.

Validation records:

| Gate | Evidence class / status |
|---|---|
| Candidate scope, safe approval and controller state | Focused source regression; scripts never execute hostile metadata on the host. |
| Core regression | Local preliminary 202 files / 1367 tests pass; added replay-preservation guard requires final full CI. |
| Build/typecheck | New standalone Doctor entrypoints explicitly included in compilation. Initial missing build output and unsupported RequestInit cache option were reproduced and corrected. |
| Windows activation | Real signed HTTP/controller/child upgrade and rollback: 4/4 preliminary dirty-tree cases. Final clean exact-SHA CI required. |
| Linux managed adapter | CI-only root controller / unprivileged runtime acceptance required; not replaced with scripted driver evidence. |
| Original semantic recovery | Independent immutable HTTP predicate, before-fault / after-healthy / failed-candidate rollback. Limited to that predicate, not overall product correctness. |
| Doctor model quality/full autonomous chain | Open: source parsing/Kernel integration and real sandbox/controller checks are separate from live-model-to-production acceptance. |
| Production/fleet/40 modules/RC | Open; no production changed or full acceptance claimed. |

The independent review found a second-patch baseline risk: an unchanged source
mirror could generate B without A. The managed adapter now binds the previous
artifact sourceHash to the approved baseline; a specific two-patch negative is
retained in Linux acceptance. Earlier rollback-on-spawn-failure, env-only
reconciliation and writable controller-state configurations were corrected.

An additional live local-model candidate run exposed an actual routing defect:
the JSON-only candidate follow-up was advertised zero diagnostic tools despite
its explicit Kernel contract. The retained negative run produced no validated
candidate. Complete outer contracts now drive the immutable tool plan rather
than being silently reduced by keyword routing; role/lifecycle/budget gates and
explicit empty-tool contracts remain enforced. A subsequent dirty-tree local
Qwen run passed both diagnostic evidence and exact candidate JSON (2/2), with
no application or config mutation. Use `XAVENTRA_RESEARCH_QA_PATCH=1` alongside
the existing opt-in research QA endpoint to reproduce this separate model check.
Neither this model check nor scripted receipts is a full autonomous repair run.

Use [the operator and recovery guide](REPAIR_ACTIVATION.md). Missing deployment
identity, authority service, prepared signed artifacts, profiles or source-mirror
advancement are explicit prerequisites, not grounds to enable a permissive path.
