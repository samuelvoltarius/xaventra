# Nova Agent Harness Upgrade

Nova adopts selected orchestration patterns without replacing its own runtime,
memory, mesh, governance, or identity. The authoritative path remains:

`request -> lifecycle policy -> execution kernel -> tool evidence -> validator -> outcome ledger`

## The ten implemented capabilities

1. **Scoped lifecycle** — `EffectScope` owns hooks, commands, tools, child
   scopes, abort signals, and deterministic LIFO cleanup.
2. **Reversible plugins** — plugin registrations return disposers. Development
   hot reload is cache-busted and allowed only by the `developer` runtime
   profile. Built-in tool names cannot be shadowed.
3. **Generated runtime catalogs** — tools, config, persistence paths, modules,
   profiles, and bundles are derived from source. `npm run check:catalogs`
   fails if committed catalogs are stale.
4. **One guarded tool pipeline** — monotonic preflight guards can only deny or
   abstain. Lifecycle policy, validation, repair evidence, observers, and the
   final frozen model-facing outcome share one execution path.
5. **Continuable subagents** — conversations have durable IDs and checkpoints,
   survive process restarts, and keep a stable `subagent:<id>` principal across
   local and Mesh providers.
6. **Semantic developer runtime** — normalized LSP operations provide symbols,
   definitions, references, and diagnostics. Code execution uses a bounded,
   network-free Mission container and never host `eval`.
7. **Native sandbox providers** — Linux Landlock or Bubblewrap and macOS
   Seatbelt are capability-probed. Requested native isolation fails closed when
   no functional provider is available.
8. **Tool-result pruning** — the model receives a deterministic bounded view
   with the full result hash. Outcome Ledger and Tool Evidence keep the full
   verified result.
9. **Profiles and bundles** — `home`, `server`, `nas`, `worker`, and `developer`
   resolve explicit capability bundles. Node role, Main eligibility, channel
   fencing, and developer-only hot reload are validated at startup.
10. **ACP boundary** — the official Agent Client Protocol SDK exposes Nova to
    compatible clients. ACP is read-only by default. Write mode requires
    `NOVA_ACP_WRITE=1`, an isolated Git worktree, normal RBAC/lifecycle checks,
    and explicit promotion outside ACP.

## Natural-language operation

No slash command is required. The Smart Tool Router selects:

- `lsp_query` for semantic code questions;
- `code_runtime_run` for isolated code execution;
- `continuable_subagent_start` and `continuable_subagent_followup` for durable
  worker conversations;
- `runtime_capabilities` when Nova needs to inspect available providers.

## Configuration

```json
{
  "runtime": {
    "profile": "home",
    "bundles": [],
    "hotReload": false,
    "acpEnabled": false
  }
}
```

Use `developer` only on a trusted development node. Production nodes must keep
hot reload disabled. ACP does not copy OAuth tokens, credentials, or private
keys into Mesh, Memory, catalogs, or client sessions.

## Verification

```bash
npm run catalogs:generate
npm run check:catalogs
npm run typecheck
npm test
npm run build
npm run check:layers
npm run check:assurance
npm run check:release
```

Generated files live in `docs/generated/` and must not become an independent
state authority. They are documentation and release evidence derived from the
runtime source.
