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
For this 2.78.3 revision, exact-commit CI reports are mandatory before main moves;
Desktop reports identify their `sourceRevision`, OS and package version.

| Gate | Status | Evidence / missing acceptance |
|---|---|---|
| Clean installs and upgrades | Partial | 2.78.2 clean CI source installs on three OSes; full native installer/update acceptance outstanding. |
| Real model and tools | Bounded pass | [Separate 8/8 real-model run](VERIFICATION_2.78.2.md), not a 100-task agent score. |
| Authenticated HTTP ingress | Bounded pass | 2.78.2 actual daemon authenticated status and unauthenticated rejection, plus ingress regressions. |
| Memory/correction/reset/resume | Partial | [Scoped restart/correction checks](VERIFICATION_2.78.0.md); complete native/distributed mission resume outstanding. |
| Policy, validation and evidence | Partial | Core release regressions and real file-tool evidence; full advertised workflow/risk matrix outstanding. |
| Packaged Desktop | Partial | [2.78.3 real Electron interaction groups](VERIFICATION_2.78.3.md), simulated HTTP Core; retained per-OS CI reports. Remaining native integrations explicitly listed there. |
| Daemon and channels | Partial | [2.78.2 compiled lifecycle on all three OSes](VERIFICATION_2.78.2.md); separately credentialed live channel delivery outstanding. |
| Distributed HA and memory convergence | Open | Requires controlled multi-node partitions, fencing, takeover and reconciliation; subsystem probes do not suffice. |
| Reference-agent comparison | Open if claimed | No parity/superiority claim without matched tasks, budgets and independently checked artifacts. |
| Signed installers and recovery | Open / external prerequisites | Signing identities/notarization plus actual install/update/rollback acceptance and checksums outstanding. |

Next useful rounds: connect the isolated packaged client to an actual isolated
Core for governed tool/validator/outcome acceptance, then native installer and
distributed failure tests. Do not remove advertised features to make the table
green. Unavailable credentials/signing may block individual gates, not all safe
engineering work.
