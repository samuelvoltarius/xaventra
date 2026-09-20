# Xaventra 2.78.35 verification

## Scope

This checkpoint hardens Outcome Router shadow learning. It does not activate
production routing, deploy a node or claim that one model is better than
another.

## Source contract

- `LearningCoordinator.recordValidatedRun` is the only production admission
  bridge into the routing-sample projection.
- Each sample contains only route/outcome metrics, a one-way principal hash and
  evidence references. Request text, tool arguments, tool output and credentials
  are not stored.
- Benchmark, fixture, synthetic and response-only outcomes are rejected.
- Decisions consume only the requesting principal's samples. Aggregate status
  is observability-only and never activation-eligible.
- User invalidation tombstones the matching derived sample.
- Modified or partially written persisted samples fail closed by hash/schema
  validation.
- The fenced Main's single Learning Coordinator is the writer authority. This
  checkpoint proves local process restart, not concurrent multi-writer merge or
  cross-node replication of the derived projection.

## Acceptance classes

| Class | Evidence | Limit |
|---|---|---|
| Source regression | Outcome Router admission, restart, scope, tamper and invalidation tests | In-process fixtures |
| Compiled process acceptance | `npm run check:outcome-router` starts a writer and a fresh reader process over one disposable store | Local processes, not physical nodes |
| Hosted OS verification | CI runs the compiled acceptance on Windows, Linux and macOS and retains `report.json` | Await exact candidate SHA |
| Production | None | No node, channel, config or router mode changed |

The compiled acceptance must show 20 accepted principal samples activating only
that principal in explicit active test mode; 19 samples, another principal,
anonymous context and aggregate status remain closed. It also inserts terminal
validation-shaped ledger events directly and proves they are not training data.

## Open gates

Production sample collection and shadow observation remain necessary before any
real active-mode decision. Cross-node projection convergence, physical-node/channel failover, broader install and
update acceptance, remaining Desktop Trust/approval/resume paths, fair external
comparison and external native signing/notarization prerequisites also remain
open in the RC plan.
