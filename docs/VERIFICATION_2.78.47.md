# Xaventra 2.78.47 verification

## Scope

This candidate fixes one reproduced production tool-routing defect. A request
that explicitly named `health_status` received only the five Core tools because
the keyword matcher correctly did not treat `health` inside `health_status` as
a separate word. Capability discovery found the tool afterward, but the local
model did not reliably load the owning pack and returned no tool evidence.

## Invariants

- Only an exact registered tool identifier in the current primary instruction
  is admitted by this path; substrings of larger identifiers do not match.
- The worker contract remains capped at 24 tools.
- Tool authorization, policy, fencing, budgets, idempotency, execution and
  independent validation remain unchanged.
- Mentioning a tool is not evidence that it ran. Terminal success still needs a
  correlated verified receipt from the Execution Kernel.
- No private configuration, credential, node address or user memory is part of
  this public change.

## Evidence classes

| Evidence | Status | Boundary |
|---|---|---|
| Reproduced live 2.78.46 request | Failed closed: 5 tools, `nova_capabilities` only, no `health_status` receipt | Live production, pre-fix |
| Focused router and worker restriction regressions | 16/16 passed locally | Source/process |
| Full Core regression | 233 files / 1609 tests passed locally | Source/process |
| Benchmark probe regression | 13/13 passed after one retained transient timeout in an earlier full run | Source/process |
| Typecheck | Passed locally | Source/build |
| Build | Passed locally | Source/build |
| Desktop unit regression | 12/12 passed locally | Packaged-client source/process |
| Exact candidate CI | 10/10 jobs passed for `c60ccaae5ed706bae0e7a4e9a4454633b2bb257e` in [run 35734345371](https://github.com/samuelvoltarius/xaventra/actions/runs/35734345371) | Hosted Ubuntu, Windows and macOS |
| Complete public-history secret scan | Gitleaks 8.30.1: 126 commits / about 11.08 MB, zero findings | Repository history |
| Signed release and post-update live tool receipt | Pending | Release/live production |

The pre-fix production response correctly refused to claim a verified health
result. That negative is retained. Release acceptance requires a post-update
live run with an actual `health_status` tool receipt; a model response or tool
inventory lookup alone does not close the gate.
