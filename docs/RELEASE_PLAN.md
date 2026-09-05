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
