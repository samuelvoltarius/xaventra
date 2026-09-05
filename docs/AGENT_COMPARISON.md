# Practical comparison: Xaventra, Hermes and OpenClaw

Reviewed 2026-09-05 against the projects' primary documentation. This is a
capability and delivery-gap review, **not** a head-to-head benchmark. Documentation
can show that a feature is offered; it cannot establish its success rate.

| Area | What the reference projects document | Xaventra evidence / next gate |
|---|---|---|
| Installation | Hermes provides native Windows and Unix installers plus dependency bootstrap; OpenClaw documents native/WSL and desktop onboarding. | 2.78.0 adds common source setup and a three-OS CI matrix. Automatic Node provisioning, signed end-user packages and service setup remain separate work. |
| Desktop-to-runtime connection | Both offer desktop access to the agent runtime; OpenClaw supports local or remote gateways. | Core-backed Electron client exists. IPC tests are not a full packaged Windows/macOS/Linux UI acceptance suite. |
| Tools and skills | Hermes documents toolsets/procedural skills; OpenClaw has a skill installation and metadata contract. | Typed registry, narrow worker catalog, approval gates and evidence exist. New acceptance requires actual model-selected file tools; broader browser/coding tasks still need live suites. |
| Memory | Hermes documents agent memory/skills; OpenClaw documents persistent memory and recall. | Scoped conversation restart, correction and isolation are tested separately from fact/graph subsystems. Cross-node memory takeover is not proven by local restart. |
| Autonomy | Both expose longer-running agent workflows. | Goals, policy, checkpoints and guarded execution exist. Allow-lists and budgets now gate all native execution rounds. This does not prove unbounded autonomous reliability. |
| Operations | Both document install/update/diagnostic paths. | Doctor, signed mesh release and fencing exist. Live multi-node failover, full channel handover and signed binary distribution require independent proof. |

## What we adopted in this release

One installer contract with OS-specific entry points; persistent scoped sessions;
explicit optional dependencies; bounded execution before side effects; repeatable
real-model acceptance; and an evidence matrix instead of inferring product quality
from tool counts or mocked benchmark scores. These are independently implemented
patterns, not a wholesale integration of either project.

## Next measured comparisons

Use the same model, hardware, task prompts, time/cost budget and allowed workspace.
Preserve failed runs. Start with file editing plus tests, browser research with
sources, multi-turn correction, interruption/resume and duplicate-action prevention.
Only then compare completion, false-success rate, latency and cost. No result from
Xaventra's subsystem suite supports claiming superiority over another agent.

Sources: [Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation),
[Hermes repository and feature documentation](https://github.com/NousResearch/hermes-agent),
[OpenClaw installation and platforms](https://docs.openclaw.ai/install),
[OpenClaw skills](https://docs.openclaw.ai/skills),
[OpenClaw memory](https://docs.openclaw.ai/concepts/memory).
