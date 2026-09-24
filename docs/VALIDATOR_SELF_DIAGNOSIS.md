# Validator failures enter the existing Self-Doctor

The runner persists an explicit `diagnosticEligible` marker with terminal
`validator-rejected` outcomes. Benchmarks, internal Doctor runs, policy blocks
and failures already escalated through the tool-failure path are excluded.
No tool failure or successful receipt is invented.

The existing authorized autonomy cycle reconciles the most recent 200 outcomes,
admitting at most ten new cases per cycle before dispatching the existing
FailureResearchCoordinator. This recovers a crash between outcome persistence
and queue creation within that bounded window. It is not an unlimited historical
backfill. Autonomy must be enabled and hold its existing authority.

Cases use a stable hash of principal and run ID. Reconciliation does not reopen
an existing case or replay the user's action. The global diagnostic queue receives
only a correlation digest and allowlisted failed criterion kinds, not private
requests, URLs, identity values, tool outputs or validator prose. This protects
user context but means diagnosis cannot reconstruct private target details.

Hardware and node awareness reuse the existing read-only diagnostic tools:
`health_status`, `nova_introspect`, `nova_capabilities`, `mesh_nodes`,
`nova_trace_stats` and `find_capability`. A listed capability is not proof of
availability: the worker must produce a correlated terminal Kernel receipt.
Missing evidence remains unknown, never healthy by default.

The existing repair path still requires proposal, isolated sandbox, regression,
rollback evidence, PATCH_GATE and independent live verification. A verified
diagnosis is not a verified repair. Native production updater enrollment and
hardware-specific recovery remain separate requirements; this bridge grants no
shell, Docker exec, installation or deployment privileges.

## Verification scope

`validator-failure-escalation.test.ts` checks durable reconciliation, principal
separation, bounded intake, exclusion of policy/approval/internal cases, privacy,
authority denial and a controlled diagnostic receipt followed by restart without
redispatch. The actual autonomy dispatch test checks the reconciliation hookup.
These are isolated tests, not Spark hardware or Telegram acceptance.
