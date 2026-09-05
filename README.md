# Xaventra

<p align="center">
  <img src="assets/xaventra-icon.png" width="180" alt="Xaventra logo">
</p>

> A governed, self-hosted autonomous agent operating system with verifiable
> tool execution, durable user-scoped memory and a resilient multi-node mesh.

[![License: MIT](https://img.shields.io/badge/License-MIT-14B8A6.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-4F7CFF.svg)](package.json)

Xaventra is built for work that must continue after the chat message ends. It
discovers local and remote AI runtimes, routes tasks to suitable nodes, executes
typed tools through one governed kernel, records real evidence, validates the
outcome independently and can resume from durable checkpoints.

This repository contains the complete TypeScript Core runtime, the Electron
Desktop client, the browser dashboard, the optional infrastructure profiles and
the validation suites. It is intended both for people who want to run one
self-hosted assistant and for contributors building a resilient agent platform.

The project was previously named **Nova**. Compatibility identifiers such as
`NOVA_*`, `.nova-data` and persisted `nova-*` node IDs remain intentionally
stable during the first public migration release. See
[BRAND_MIGRATION.md](BRAND_MIGRATION.md).

## Why Xaventra

- **One execution authority:** Planner -> Worker -> Tool Evidence -> Validator.
- **Verified tools:** model prose never proves that an action happened.
- **Provider discovery:** local and remote vLLM, Ollama, llama.cpp and compatible
  runtimes are inventoried with health, models and measured capabilities.
- **Multi-node mesh:** encrypted direct transport with optional durable relay,
  leases, fencing and fail-closed takeover.
- **Governed memory:** user-scoped facts, sessions, outcomes, tombstones and
  resumable checkpoints without credential replication.
- **Safe autonomy:** diagnosis may be automatic; risky mutations require
  sandbox evidence, regression tests and an approval gate.
- **Desktop control plane:** rooms, specialists, nodes, model placement, Trust,
  Memory and Studio without creating a second runtime authority.
- **Defensive security:** Blue-Team workflows for inventory, triage, IOC matching
  and evidence-based containment proposals.

## Current state

Xaventra 2.78.2 is a versioned source release. Native Windows, Linux and macOS
setup entry points share one installer, and CI exercises the Core on all three
systems. A configured LLM is required; optional browser, GPU and Desktop
dependencies have their own install steps. Signed Desktop binaries and live
multi-node channel takeover remain separate release gates, not implied promises.
See the [verification record](docs/VERIFICATION_2.78.2.md) and
[platform guide](docs/PLATFORMS.md) before distributing a deployment.

Owner access requires a configured Telegram identity or an explicit grant from
the local CLI or authenticated Desktop. OS mode and chat phrases do not grant
administrator access. See the [2.77.2 authorization review](docs/AUTHORIZATION_REVIEW_2.77.2.md).
Keep development APIs private: without `NOVA_API_TOKEN`, REST is allowed only on
loopback. Remote binding requires a token; remote deployments also need a
trusted TLS ingress. The installer creates a random local token without printing it.

If you want to help immediately, start with
[the development guide](docs/DEVELOPMENT.md) and choose one bounded issue from
the [public release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md).

## Architecture

```text
User / Telegram / Desktop / REST
               |
               v
       Xaventra Execution Kernel
       intent -> plan -> policy
               |
               v
        typed Tool Executor ------> Tool Evidence
               |                         |
               v                         v
       Node / model router         Independent validator
               |                         |
               +------------+------------+
                            v
                  Outcome Ledger + Memory
                            |
                            v
                  checkpoint / resume / learn
```

The Main is the only node allowed to own fenced channels and the authoritative
control plane. Workers advertise tools and models, execute signed jobs and
return evidence. A standby may become Main only through a valid lease and
fencing token; Xaventra never guesses through a network partition.

## Requirements

- Node.js 22 or newer
- npm
- At least one local or cloud LLM route
- A `xaventra.config.json` configuration (the installer creates it)

Docker, Tailscale, Supabase, Neo4j and OpenTelemetry are optional and depend on
the deployment profile.

## Quick start

```bash
git clone https://github.com/samuelvoltarius/xaventra.git
cd xaventra
sh install.sh
npm run cli -- setup
npm start
```

Windows PowerShell:

```powershell
git clone https://github.com/samuelvoltarius/xaventra.git
Set-Location xaventra
./install.ps1
npm run cli -- setup
npm start
```

The legacy `npm run nova` and `nova` CLI aliases remain available during the
brand migration.

Both installers require Node.js 22+ and npm, preserve existing configuration and
leave messaging channels disabled. If PowerShell script execution is restricted,
use `node scripts/setup.mjs`; no system-wide execution-policy change is needed.
Optional features: `./install.ps1 -Desktop -Browser -Native` or
`sh install.sh --desktop --browser --native`. These options download platform
dependencies and may require system libraries. See [platforms](docs/PLATFORMS.md).

New installs use `xaventra.config.json`. An existing `nova.config.json` is read
in place only when the new filename is absent. Files are never merged or copied;
when both exist, Xaventra's filename wins.

After startup, use the CLI or open the configured REST/Desktop surface. You do
not need Telegram, a Mesh or external infrastructure for a local development
instance.

### Pick the right starting path

| Goal | Start here |
|---|---|
| Run one local instance | [Quick start](docs/QUICKSTART.md) |
| Understand configuration | [Configuration](docs/CONFIGURATION.md) |
| Build or fix Core | [Development guide](docs/DEVELOPMENT.md) |
| Work on Desktop/Studio | [Desktop guide](docs/DESKTOP.md) |
| Add a provider or model runtime | [Provider discovery](#provider-and-model-discovery) and `src/llm/` |
| Add a governed tool | [Tools guide](docs/TOOLS.md) and `src/tools/complete-registry.ts` |
| Work on Memory | [Memory guide](docs/MEMORY.md) |
| Run multiple nodes | [Mesh guide](docs/MESH.md) |
| Understand trust and validation | [Trusted execution](docs/TRUSTED_EXECUTION.md) |
| Prepare a public release | [Public release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md) |

## Verify the installation

```bash
npm run typecheck
npm test
npm run build
npm run check:build
npm run check:layers
```

To test genuine model tool selection and conversation continuity, configure
`XAVENTRA_EVAL_BASE_URL` and `XAVENTRA_EVAL_MODEL`, then run
`npm run benchmark:acceptance`. It uses disposable files and fresh worker
processes. `benchmark:full` is a **subsystem-probe suite**, not an autonomous task
completion score. Neither suite alone proves Telegram takeover or all hardware.

Start without rebuilding only after a successful build:

```bash
npm run start:fast
```

## Configuration

Never commit live credentials. Copy the example configuration and provide
secrets through node-local environment variables or an approved secret store.

| Compatibility variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI API route |
| `ANTHROPIC_API_KEY` | Anthropic API route |
| `GEMINI_API_KEY` | Google model route |
| `TELEGRAM_BOT_TOKEN` | Telegram on an eligible fenced Main |
| `NOVA_NODE_ONLY=true` | Worker mode; disables channels |
| `NOVA_NO_TELEGRAM=true` | Disable Telegram on this node |
| `NOVA_API_TOKEN` | Bearer authentication for the REST API |
| `NOVA_PATCH_GATE_TOKEN` | Approval token for queued self-modification |

`XAVENTRA_*` aliases will arrive through a versioned configuration migration.
Existing nodes retain `NOVA_*` until backup, rollback and failover tests pass.

## Provider and model discovery

Xaventra separates three facts that are often mixed together:

1. A provider integration is installed.
2. Authentication is available on this user and node.
3. A model endpoint is live and has passed a capability probe.

Provider manifests declare IDs, protocols, static models and discovery modes.
Runtime refresh adds live models. The catalog publishes authentication status,
never secret values. Mesh nodes advertise hardware, runtime health, models,
context size, VRAM/RAM, measured speed and validated tool outcomes.

## Desktop

```bash
npm run desktop:install
npm run desktop:dev
```

Package the native client:

```bash
npm run desktop:package
```

Xaventra Desktop connects to the authoritative Main. It does not contain a
second agent runtime. Specialists are reusable roles; nodes are real Xaventra
instances; rooms select topic, specialists, preferred nodes and routing policy.

See [docs/DESKTOP.md](docs/DESKTOP.md).

## Multi-node deployment

Profiles include `home`, `server`, `nas`, `worker` and `developer`. Profiles
select capability bundles but never override election eligibility, leases or
channel fencing.

- [Production operations](docs/PRODUCTION_OPERATIONS.md)
- [Mesh release updates](docs/MESH-RELEASE-UPDATES.md)
- [Telegram high availability](docs/TELEGRAM.md)
- [Mesh architecture and transport](docs/MESH.md)

Do not copy node identities, OAuth tokens or private Mesh keys between hosts.
Each node creates its own identity and reports only safe capability state.

## Memory and learning

Xaventra keeps one governed memory authority. Reusable information carries
principal scope, provenance, confidence, lifecycle, version and tombstones.
Only independently validated production outcomes may train active routing or
promote reusable skills. Benchmark fixtures and model answers cannot become
production truth.

## Doctor and self-repair

```text
diagnose -> gather evidence -> propose -> sandbox -> regression
         -> rollback test -> PATCH_GATE -> canary -> validate
```

Doctor diagnosis and patch execution are deliberately separate.

## Security model

- Credentials remain local to `user x node`.
- Refresh tokens never enter Memory, Mesh or the Capability Graph.
- Remote control endpoints require authentication and HTTPS outside loopback.
- Tool permissions are role- and lifecycle-gated.
- Self-repair and generated skills are inert until validated and approved.
- Singleton channels require a valid lease and fencing token.
- A worker cannot turn model prose into Tool Evidence.

Before opening a public issue, redact tokens, host addresses, user data and
private logs. See [SECURITY.md](SECURITY.md) for responsible disclosure.

## Repository map

| Path | What belongs here | Start with |
|---|---|---|
| `src/core/` | canonical message, execution, goal, belief and outcome contracts | `message-pipeline.ts`, `execution-kernel.ts`, `outcome-ledger.ts` |
| `src/llm/` | provider manifests, adapters, model discovery and failover | `provider-manifest.ts`, `nova-llm-sdk.ts` |
| `src/routing/` | outcome-based model and node selection | `outcome-router.ts` |
| `src/tools/` | typed tool catalog, routing and execution boundaries | `complete-registry.ts`, `tool-router.ts` |
| `src/validation/` | independent validation of real tool outcomes | `tool-validator.ts` |
| `src/memory/` | governed facts, retrieval, reusable assets and tombstones | `memory-governance.ts`, `memory-asset-catalog.ts` |
| `src/learning/` | verified-outcome learning and skill maturation | `learning-coordinator.ts`, `personal-skill-compiler.ts` |
| `src/mesh/` | transports, capabilities, signed jobs, leases and fencing | `mesh-transport-router.ts`, `capability-graph.ts` |
| `src/doctor/` | diagnosis and evidence-led repair research | `index.ts`, `failure-research-coordinator.ts` |
| `src/desktop/` | authoritative Core API used by Desktop | `desktop-api.ts` |
| `desktop/` | Electron operator client and Nova Studio UI | `main.cjs`, `renderer/` |
| `src/dashboard/` | browser Trust and operator dashboard | `public/` |
| `dashboard/` | experimental legacy gateway client; not the Core Control Plane | its local README and limitations |
| `src/benchmark/` | isolated evidence-based scenarios and comparisons | `benchmark-cli.ts` |
| `infra/` | optional observability, memory and coordination services | service-specific README files |
| `deploy/` | deployment profiles and signed release support | profile definitions |
| `docs/` | public architecture, operation and contribution guides | `DEVELOPMENT.md`, `ARCHITECTURE.md` |

### The authority rule

Before adding code, find the existing owner of that state or decision. Xaventra
deliberately has one Execution Kernel, one tool execution path, one governed
Memory authority and one Outcome Ledger. New adapters and UIs project those
authorities; they must not create a second executor, memory store or truth path.

## Development workflow

```bash
npm install
cp xaventra.config.example.json xaventra.config.json
npm run typecheck
npm test
npm run build
npm run check:catalogs
npm run check:assurance
```

Tests must use temporary data roots. Never point tests at production memory,
outcomes, identities or configuration.

For each change:

1. Identify the authoritative subsystem; do not create a parallel state path.
2. Add an isolated regression test.
3. Capture real tool evidence.
4. Run typecheck, relevant tests and build.
5. Update documentation and generated catalogs when contracts change.
6. Bump SemVer intentionally only when preparing a release.

The fastest way to make a useful contribution is:

1. Reproduce one concrete behavior with a small isolated test.
2. Locate its authority using the repository map above.
3. Change only that path and keep compatibility identifiers stable.
4. Validate the real outcome, not the wording of a model response.
5. Document the new contract and any rollback behavior.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for worked examples, test
isolation rules, debugging commands and the definition of done.

## Contributing

Contributions to this public source preview are welcome. Start with a
small issue stating the expected outcome, affected authority and validation
method. Pull requests should include tests and must not weaken Tool Evidence,
principal isolation, fencing, PATCH_GATE or credential boundaries.

Good first areas:

- provider manifests and safe discovery adapters
- documentation and reproducible setup checks
- isolated benchmark scenarios
- accessibility and Desktop usability
- defensive Blue-Team parsers
- typed compensation handlers

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

When opening an issue, include: expected outcome, current evidence, affected
authority, risk level and how success can be verified. That is enough for
another contributor or agent to continue the work without private context.

## Project status

The codebase is undergoing the Nova -> Xaventra public-brand migration. Public
packaging is not complete until secret scanning, clean-clone installation, full
tests, Desktop packaging and release artifacts pass on supported platforms.

## License

MIT. See [LICENSE](LICENSE).

Third-party adaptations and acknowledgements are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). A machine-readable
[CycloneDX SBOM](SBOM.cdx.json) and the
[commercialization guide](docs/COMMERCIALIZATION.md) document the additional
release obligations. Do not remove these notices from redistributed builds.

Xaventra was created by Alfred Aigner and is developed with its contributors.
