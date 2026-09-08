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
| Core regression | Local 202 files / 1370 tests pass, including routing and replay-preservation controls; exact candidate full CI remains mandatory. |
| Build/typecheck | New standalone Doctor entrypoints explicitly included in compilation. Initial missing build output and unsupported RequestInit cache option were reproduced and corrected. |
| Windows activation | Real signed HTTP/controller/child upgrade and rollback: 4/4 preliminary dirty-tree cases. Final clean exact-SHA CI required. |
| Linux managed adapter | Source `80169f5bc98ae3369b5619a22d5a8a23ca7feee7`: actual managed root/non-root 5/5 in the managed-repair job of [CI 34250403838](https://github.com/samuelvoltarius/xaventra/actions/runs/34250403838). Final attestation still needs its own complete CI. |
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

Initial Linux managed acceptance rejected the CI fixture's writable/non-root
ancestor path before starting an application. Those CI failures remain retained.
The fixture now provisions a root-owned `/srv` tree and a protected copy of Node,
with traversable read-only source directories for the unprivileged runtime.
Production permission checks are unchanged; the executable is checked too.
The copied executable's retained UID 1001 was independently observed in the
negative run; explicitly setting and asserting root ownership fixed provisioning.

Clean live-model source `e837dce5ad4b95ac6e6852a49130249a710e575a` passed diagnostic
evidence and exact candidate generation (2/2) on Windows with local Qwen. Run IDs:
`doctor-research-69a79449-a060-4fa0-a3d4-89493eb31451` and
`doctor-candidate-4a0b8458-b689-4956-ad9e-1ba2ad083056`. No source/config mutation
or activation occurred in this model test. Private raw logs are not published.

The managed Linux 5/5 receipt covers actual signed activation under a separate
UID, denied controller-canary writes, stale-second-patch rejection, bad-candidate
rollback, startup-failure restoration and tampered-artifact rejection. The
controller HTTP protocol's separate 4/4 tests cover real disposable processes on
Windows/Linux/macOS. The earlier isolated Docker job retains all six checks.
None of these fixture boundaries is relabeled as full-production acceptance.

Use [the operator and recovery guide](REPAIR_ACTIVATION.md). Missing deployment
identity, authority service, prepared signed artifacts, profiles or source-mirror
advancement are explicit prerequisites, not grounds to enable a permissive path.
