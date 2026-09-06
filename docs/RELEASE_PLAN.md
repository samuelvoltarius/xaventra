# Reliability release loop

Every iteration: reproduce -> isolate -> fix -> regression -> real acceptance ->
document -> synchronized version bump -> scan -> push candidate -> CI -> main.
Preserve negative results. No mocked proof is substituted for live execution.

## Current bounded gates

1. Core source installs from a clean checkout on Windows, Linux and macOS.
2. Local model chooses real tools and returns the observed result.
3. HTTP ingress authenticates, handles malformed requests and reaches execution.
4. Scoped conversation memory survives process restart, correction and reset.
5. Policy, allow-lists, budgets and evidence apply to every execution round.
6. Native Desktop packages build and are smoke-tested on each advertised OS.
7. Full daemon startup/shutdown and channel dispatch are tested without touching
   production state; live Telegram delivery is a separately credentialed check.
8. Multi-node lease, task takeover and memory convergence are proven in controlled
   failure tests; local subsystem probes alone do not close this gate.
9. Comparable, artifact-verified tasks run against reference agents before any
   claims about better completion, speed or autonomy.
10. Signed binary releases, checksums and install/rollback instructions precede
    broad consumer binary distribution.

No automatic production rollout, token replication, unreviewed third-party code
execution or weakened approval gate is permitted to make these checks green.
Unavailable hardware, signing identities or service credentials remain explicit
external prerequisites, not invented successes.

## Evidence-linked RC inventory

Status: **not RC-ready**. A bounded pass closes only the stated checks, not the
whole advertised product. `2.78.2` below means commit
`f300d1a04bca42072618677ff4115e727a870072`, with
[candidate CI](https://github.com/samuelvoltarius/xaventra/actions/runs/33993416173)
and [main CI](https://github.com/samuelvoltarius/xaventra/actions/runs/33993649700).
For the current revision, exact-commit CI reports are mandatory before main moves;
Desktop reports identify their `sourceRevision`, OS and package version.

### 2.78.6 acceptance checkpoint — 2026-09-06

Runtime/source commit `933edc45ffc9cff50e10017a54134d03439c79c6` passed all seven
jobs in [candidate CI 34029584042](https://github.com/samuelvoltarius/xaventra/actions/runs/34029584042).
This includes clean source installs, 1132 Core tests, compiled lifecycle, nine
new response-contract/API cases and packaged Desktop checks on all three OSes.
Hosted provider responses are scripted, not live-model claims. Separate Windows
real-provider native/REST acceptance passed 8/8 on this commit at 11:13 UTC,
with the original checks/exclusions intact. See [scope and reproduction](VERIFICATION_2.78.6.md).
Any subsequent documentation-only attestation must also pass exact-commit CI
before main promotion. No full RC label, binary publication or production deploy.

| Gate | Status | Evidence / missing acceptance |
|---|---|---|
| Clean installs and upgrades | Partial | 2.78.2 clean CI source installs on three OSes; full native installer/update acceptance outstanding. |
| Real model and tools | Partial | [2.78.6 native/REST 8/8 and response-contract regression](VERIFICATION_2.78.6.md); prior [2.78.5 full-daemon/Desktop 6/6](VERIFICATION_2.78.5.md). The retained 7/8 negative is not erased. Neither is a 100-task product score. |
| Authenticated HTTP ingress | Bounded pass | 2.78.2 actual daemon authenticated status and unauthenticated rejection, plus ingress regressions. |
| Memory/correction/reset/resume | Partial | Scoped restart recall, cross-user isolation and bounded explicit correction-response enforcement pass in 2.78.6; general instruction handling and complete native/distributed mission resume remain outstanding. |
| Policy, validation and evidence | Partial | Core release regressions and real file-tool evidence; full advertised workflow/risk matrix outstanding. |
| Packaged Desktop | Partial | [2.78.5 full daemon and restart](VERIFICATION_2.78.5.md), scripted cross-platform checks plus separate real local-provider Windows run. Exact-commit CI reports required; native dialogs/capture/installers remain open. |
| Daemon and channels | Partial | [2.78.2 compiled lifecycle on all three OSes](VERIFICATION_2.78.2.md); separately credentialed live channel delivery outstanding. |
| Distributed HA and memory convergence | Open | Requires controlled multi-node partitions, fencing, takeover and reconciliation; subsystem probes do not suffice. |
| Critical/high release defect closure | Open | The response-contract defect is reproduced and fixed; the full advertised risk matrix, cumulative budget/fallback attribution and distributed failure paths are not yet accepted. No blanket absence-of-high-risk-defects claim. |
| Recovery and upgrade documentation | Partial | Versioned source reproduction/rollback guidance exists; native installer recovery, actual upgrade/rollback and distributed recovery procedures need matching live evidence. |
| Reference-agent comparison | Open if claimed | No parity/superiority claim without matched tasks, budgets and independently checked artifacts. |
| Signed installers and recovery | Open / external prerequisites | Signing identities/notarization plus actual install/update/rollback acceptance and checksums outstanding. |

Next useful rounds: cumulative usage and inference attribution; native dialogs/capture and installer acceptance; typed
inference-host attribution across fallback; controlled distributed failure and
mission-resume tests. Do not remove advertised features to make the table
green. Unavailable credentials/signing may block individual gates, not all safe
engineering work.

### 2.78.7 bounded Doctor candidate

[Doctor delivery/runtime verification](VERIFICATION_2.78.7.md) separates artifact
integrity/configuration fixtures from actual GGUF diagnosis quality. The retained
0.5B invented-port/provider response is an open quality failure, not a passing
benchmark. Delivery, integrity and fail-closed handling can be fixed without
claiming the weights are fully qualified. Candidate exact-SHA three-OS CI must
pass before main promotion. No production, weights or RC publication authorized.
