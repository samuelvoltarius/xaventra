# Nova Agent Landscape Audit — August 2026

Status: current primary-source review, not a self-reported benchmark.

## Decision

Nova should remain its own runtime. We should adopt proven interaction and
execution patterns, not embed whole competing frameworks as a second
orchestrator. Nova's differentiator is the combination of a governed execution
kernel, independently validated Tool Evidence, an Outcome Ledger, a capability-
aware hardware mesh, fenced high availability and user-scoped memory.

The next intelligence gain comes from better allocation and better feedback:

1. choose the right cognitive depth before the model call;
2. retrieve only the right memory and skills;
3. investigate uncertainty before asking the user;
4. execute through one typed authority;
5. validate the real outcome;
6. learn only from that validated outcome.

## Primary-source comparison

| System | Strongest current patterns | Nova already has | What Nova should adopt |
|---|---|---|---|
| Hermes Agent | One messaging gateway for 20+ platforms, edit-in-place streaming, native clarification controls, session search, procedural skills, background completion notifications, multiple terminal backends and optional memory providers | Unified channels, natural-language control, governed memory, skill maturity, typed tools, Direct Mesh | Mobile-first message lifecycle, silent editable progress, session search UX, capability/toolset discovery, background completion rather than polling |
| Agent Zero | Full Dockerized Linux desktop, DOM-annotated browser, live document cowork, strong project isolation, model presets, profiles, scheduled tasks, subagents, MCP and A2A | Mission workspaces, browser runtime, profiles, bundles, MCP, ACP, typed subagents, scheduling | Make Project a first-class operator surface combining workspace, instructions, governed memory, secret references and model policy; add visible desktop/document cowork |
| OpenHands | Reproducible Docker/process/remote sandboxes, composable V1 agent SDK, skill-triggered progressive disclosure, agent server boundary | Native/process/container sandbox registry, workspace isolation, progressive skill loading, one execution boundary | Persist an environment fingerprint with every mission checkpoint and support reproducible remote workspace reconstruction |
| Letta | Explicit attachable memory blocks, archival memory, shared read/insert archives and agent-specific context | Governed facts, compact continuity, goals, beliefs, workflow episodes, causal memory and federated memory | Expose a bounded per-mission working set as an auditable projection; allow attach/detach by scope without creating another fact store |
| LangGraph | Step checkpoints, durable resume, interrupts, replay and fork/time travel | Native checkpoints, idempotency, compensation, approval resume and HA takeover | Add read-only checkpoint history plus sandbox-only fork/replay; never replay an external side effect without its idempotency/compensation contract |
| AutoGen | Typed event streams, teams, graph workflows, termination conditions, streamed inner events and distributed worker runtime | Lifecycle events, subagent teams, one orchestrator, typed Mesh tasks and OTel | Make agent/team events a stable UI stream; add explicit termination policies to every delegated team run |
| CrewAI | Simple crew/flow authoring, persisted state, resume, structured output, guardrails and human triggers | Mission contracts, planner/worker/validator, durable resume, approvals and structured tools | Borrow the approachable flow-authoring UX only; do not add a second flow runtime |
| OpenAI Agents SDK | Handoffs, sessions, tool/input/output guardrails and built-in hierarchical tracing | SDK backend already integrated behind Nova, stronger Tool Evidence gates and OTel | Keep it as an optional planner/backend; map its trace/handoff events into Nova Outcome/OTel and never bypass Nova's tool executor |

## What we deliberately do not copy

- Autonomous skill or memory writes based only on model confidence. Nova stores
  learned procedures only after independently validated outcomes.
- A free shell as the universal tool. Production execution stays typed, scoped,
  evidence-producing and approval-aware.
- Another state machine, graph runtime or memory authority. Adapters may provide
  storage or planning, but Nova remains the canonical executor.
- Raw chain-of-thought in Telegram or Trust. Nova exposes decisions, evidence,
  uncertainty and validator results, not private reasoning text.
- Shared secrets inside project memory, Mesh or model context. A project may
  reference a node-local secret; it may not contain the secret value.

## Nova 2.73 implementation direction

### 1. Adaptive Cognitive Policy

One deterministic policy classifies every turn before the first model call:

- cognitive mode: `fast`, `balanced`, `deep`, or `research`;
- task class and uncertainty;
- working versus long-term memory depth;
- number of planning alternatives;
- context, token, tool and timeout budgets;
- whether fresh external evidence is mandatory;
- maximum useful subagent fan-out.

The policy may allocate resources but may never grant more autonomy. RBAC,
Execution Preflight, leases, Tool Gates and PATCH_GATE remain authoritative.

### 2. Messaging lifecycle

Each request owns a single visible lifecycle:

`ack/progress (edited in place, silent) -> clarification/approval -> final/error`

Markdown tables become vertical mobile cards. A final answer removes its
progress bubble. Internal reasoning stays blocked. Optional Trust footers should
later show model, node, actual tool count, duration, evidence and cost without
overloading normal chat.

### 3. First-class Project surface

Unify existing Nova concepts in the dashboard without moving their authority:

- Mission Workspace reference;
- project instructions and `AGENTS.md`;
- user/tenant-scoped governed memory view;
- node-local secret references;
- capability bundle and model policy;
- goals, runs, artifacts and checkpoints.

### 4. Auditable working set

Create a bounded projection for the current mission containing only selected
goals, canonical facts, supported beliefs, relevant procedures and open
decisions. Trust shows why each item was attached and allows an operator to
detach it. The underlying records remain in their current authoritative stores.

### 5. Sandbox time travel

Trust should list checkpoint history and offer `inspect`, `replay in sandbox`
and `fork in sandbox`. Production replay remains disabled unless every completed
effect is idempotent or has a verified compensation handler.

### 6. Visible computer and document cowork

Add an operator-controlled workspace canvas backed by the existing browser,
LSP, code runtime and Mission Workspace. Nova should stream snapshots, diffs and
artifacts; promotion remains an explicit Trust action.

### 7. Background completion

Long-running tools and Mesh tasks should publish a completion event. The channel
gateway subscribes once and edits the existing run card, avoiding polling loops
and repetitive messages.

### 8. Outcome-trained intelligence

Train model/tool/node routing, skill confidence and error recovery only from
production runs whose validator completed. Track calibration as well as success:
when Nova says 80% confidence, similarly scored decisions should succeed about
80% of the time.

### 9. Adversarial memory evaluation

Expand Memory benchmarks beyond recall into stale-fact resistance,
contradiction handling, user isolation, temporal ordering, correction
supersession and malicious prompt-memory rejection.

### 10. Fair external benchmark

Use Nova's shared evidence contract to compare the current versions of Hermes,
Agent Zero, OpenHands and supported SDK backends. An unavailable system is not
scored. Model prose never satisfies an evidence requirement. Publish completion,
tool correctness, resume, memory precision, latency, cost, questions and false
completion rate.

## Sources

- Hermes Agent: https://hermes-agent.nousresearch.com/docs/
- Hermes messaging gateway: https://hermes-agent.nousresearch.com/docs/user-guide/messaging
- Hermes tools and toolsets: https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference
- Hermes memory providers and user modeling: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers/
- Agent Zero: https://github.com/agent0ai/agent-zero
- Agent Zero memory: https://github.com/agent0ai/agent-zero/blob/main/docs/guides/memory.md
- Agent Zero projects/profiles/model presets: https://github.com/agent0ai/agent-zero/blob/main/docs/guides/usage.md
- Agent Zero A2A: https://github.com/agent0ai/agent-zero/blob/main/docs/guides/a2a-setup.md
- OpenHands SDK design: https://docs.openhands.dev/sdk/arch/design
- OpenHands sandboxes: https://docs.openhands.dev/openhands/usage/sandboxes/overview
- OpenHands skills: https://docs.openhands.dev/sdk/guides/skill
- Letta memory blocks: https://docs.letta.com/tutorials/attaching-detaching-blocks/
- Letta shared archival memory: https://docs.letta.com/guides/agents/multi-agent-parallel-execution/
- LangGraph persistence: https://docs.langchain.com/oss/javascript/langgraph/persistence
- LangGraph time travel: https://docs.langchain.com/oss/javascript/langgraph/use-time-travel
- AutoGen AgentChat: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html
- CrewAI: https://docs.crewai.com/
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/
- OpenAI Agents SDK guardrails: https://openai.github.io/openai-agents-js/guides/guardrails/
