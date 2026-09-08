# Isolated repair experiments

`self_evolve` now awaits a real Docker boundary before queueing a proposal;
`/patch approve` repeats verification. The legacy tool alias uses that same
entry point. There is no host-Node or project-copy fallback. Missing image,
unavailable limits, failed tests or uncertain cleanup reject the proposal.

## Operator preparation (not automatic installation)

Use a dedicated development/sandbox Docker engine, preferably a disposable VM.
It must support Linux containers and cgroup v2 memory, CPU and PID limits.
Do not give generated code Docker credentials or mount the Docker socket into
the experiment. The trusted control process needs engine access; that access is
powerful and belongs outside the untrusted sandbox. Containers share a kernel;
this is not a microVM or proof against kernel/runtime vulnerabilities.

From a reviewed clean checkout with the exact release lockfile:

```text
node scripts/build-repair-sandbox.mjs
```

The script builds a dependency-only image using a temporary context containing
only the two package manifests and Dockerfile. Dependency lifecycle scripts are
disabled. Building may use the network; experiments never do. Review dependencies
and pin the Dockerfile base image digest in your release process. The resulting
local `sha256:...` image ID is printed. Configure it in the trusted runtime's
`XAVENTRA_REPAIR_SANDBOX_IMAGE` environment. Tags and model-supplied image values
are not accepted; automatic pulling/installing is disabled. Rebuild when the
lockfile changes. The image must not contain secrets or declare volumes.

Windows PowerShell: `$env:XAVENTRA_REPAIR_SANDBOX_IMAGE = 'sha256:...'`.
Linux/macOS shell: `export XAVENTRA_REPAIR_SANDBOX_IMAGE='sha256:...'`.
These host platforms require a working **Linux** Docker engine. Windows native
containers and cgroup v1 are not supported by this adapter; it fails closed.

## What is executed

Only canonical tracked source/fixtures/documentation/manifests are sent as
bounded bytes, not mounts. Runtime configurations, environment files, private
memory, keys, node_modules, linked files and directories are excluded/rejected.
This is not a substitute for keeping the source repository secret-free.
Dependencies come from the immutable image. Input size is limited to 64 MiB and
20,000 files. Only existing `src/` files may be patched; the input patch cannot
target test-oracle files. Running generated code can still influence in-process
tests, so this does not make their semantics independently trustworthy.

Each compiler or test invocation gets its own non-root container with no network,
read-only root, no capabilities, no-new-privileges, private IPC, 128 PIDs, 4 GiB
RAM/no swap, two CPUs and bounded temporary filesystems/output/time. Actual
cgroup values are checked before execution. Containers are force-removed and
absence checked after every command, including failure. Child deadlines use
SIGKILL; the engine-side removal also terminates descendants. Operators may
shorten `XAVENTRA_REPAIR_SANDBOX_COMMAND_TIMEOUT_MS` (1000–180000), never exceed
the fixed three-minute maximum per command. Uncertain cleanup stops
verification and requires operator reconciliation. Host process crashes still
require checking leftover `xaventra-repair-*` containers; do not start a competing
repair while ownership/cleanup is uncertain.

| Phase | Source | Required evidence |
|---|---|---|
| Baseline | Original snapshot | Recorded compiler result and unchanged regression suite |
| Candidate | Exact replacement | Build and full regression suite |
| Rollback | Fresh original snapshot | Original hash and baseline results reproduced |
| Recovery | Fresh candidate snapshot | Candidate hash and full checks reproduced |

Optionally supply `reproductionTest`, an existing tracked `src/**/*.test.ts` file.
It is excluded only from the original baseline suite, then executed separately:
real failing assertions are required before repair and after rollback. It is
included in the **full** candidate/recovery suites and must pass separately too.
No-tests, timeout or runtime/import failures are not accepted as reproduction.
`reproductionPassed` records this bounded test result. `symptomVerified` always
stays false: candidate source can influence in-process tests (including replacing
matchers), so even real passing assertions are not an independent recovery oracle.
An independent original live probe and PATCH_GATE are still required. A compiler
failure is a supported baseline if the candidate compiles and rollback reproduces
the original failure. Infrastructure failures are never accepted as baseline.

## Acceptance, limits and recovery

For the subsequent approved activation path in 2.78.15, see
[independent activation and recovery](REPAIR_ACTIVATION.md). The running daemon
no longer performs the legacy Git/build/restart transaction. It checks the exact
unchanged sandbox snapshot before issuing a bound external activation request.
Sandbox `symptomVerified` remains false; only the independent controller's
original live predicate can provide the distinct recovery evidence.

Run `npm run build`, then `node scripts/check-repair-sandbox.mjs` with the image
configured. This uses a disposable Git fixture and actual containers, verifies
host/config/environment/network/dependency boundaries, repairs a failing test,
reverts it, reapplies it and attempts a forbidden host write. Reports, including
failures, go to `.nova-data/sandbox-qa/report.json`. It is not a full product or
live Doctor-model benchmark. The separate normal CI retains all product tests.

Sandbox rollback means restoring disposable original source and rerunning its
checks, not undoing external actions or restoring a deployed database. Production
rollout, original live health-probe recovery and safe approved Git transaction
remain unaccepted. Stop self-evolution, preserve proposal/evidence records and
use your reviewed deployment rollback procedure for production issues. Never
infer permission to restart a node from a passing sandbox result.

Container restrictions follow the official [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/).
