# Trusted execution

Nova owns orchestration, routing, tools, memory, validation and approvals. The
OpenAI Agents SDK is an optional agent-loop backend, not the system authority.

## Runtime authority

The execution order is:

1. `TaskContract` defines the goal, expected artifacts, success criteria,
   allowed changes, budgets, tests and approval policy.
2. An `AgentBackend` runs the task. `nova` remains the default;
   `openai-agents` is opt-in.
3. Nova's tool policy decides which tools are visible and which calls require
   approval. Tool handlers continue to run through Nova's registry.
4. The `ExecutionKernel` validates actual tool results and artifacts.
5. The append-only `OutcomeLedger` stores route, tool evidence, validation,
   checkpoint and final outcome events.
6. The existing dashboard exposes those runs in its **Trust** tab.

## Enabling the SDK backend

Set the environment variable and restart Nova:

```text
NOVA_AGENT_BACKEND=openai-agents
```

The initial rollout applies to local subagent execution. The main native runner
already emits the same contracts and ledger records, so both paths can be
compared before changing the primary runtime.

External SDK tracing is disabled. The SDK uses `NovaModelProvider`, which sends
model requests through Nova's existing local, mesh and cloud resolver.

## Durable state

Outcome events are stored by day under `.nova-data/outcome-ledger/`. Serializable
backend checkpoints are stored under `.nova-data/outcome-ledger/checkpoints/`.
Tests must instantiate `OutcomeLedger` with a temporary directory and must never
write test runs to the default production location.

## Outcome routing and capabilities

The AI scanner remains the discovery authority. Its verified probes and mesh
heartbeats are normalized into `.nova-data/capability-graph.json`. The outcome
router consumes hardware/runtime capability evidence from this graph and the derived
`.nova-data/outcome-router-samples.json` projection. The canonical Learning
Coordinator admits a sample only after Execution Kernel validation plus
independently checkable tool/test evidence. Samples are principal-scoped,
integrity-checked and durable across restart; benchmark, fixture, synthetic and
response-only outcomes are rejected. It is shadow-only by default and records
recommendations without changing the user's configured route. Active mode also
requires explicit sample/success/rate thresholds, task allowlisting and canary
selection. Benchmark results never unlock production routing.

The projection is written by the fenced Main's single Learning Coordinator.
It is restart-durable on that runtime root; replication or takeover convergence
of this derived file is not claimed by this checkpoint.

## Idempotency, resume and compensation

Native and SDK tool calls use deterministic idempotency keys. Completed calls
are replayed from `.nova-data/idempotency.json`, not executed twice. Rollback is
available only when a tool registered a concrete compensation handler. SDK
checkpoints contain the serializable run input, so Trust approval and resume can
reconstruct a run after restart.

## Mesh fencing

Exclusive service leases use compare-and-set updates, monotonic epochs and
fencing tokens. Mesh task claims are atomic and refresh `claimed_at` while work
is active. A stale worker cannot finish a task after takeover because completion
is filtered by its fencing token. The optional Supabase `exec_sql` RPC applies
only additive `ADD COLUMN IF NOT EXISTS` migrations; takeover stays disabled if
the evidence columns cannot be verified.

## Benchmark lab

`src/benchmark/benchmark-lab.ts` defines 60 non-destructive scenarios across
discovery, routing, tools, resume, memory, mesh, Doctor, channels, governance and
proactivity. Reports measure completion, real tool execution, resume, memory,
latency, cost, unnecessary questions and false completion independently.
