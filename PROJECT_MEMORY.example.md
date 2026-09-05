# Xaventra local project memory

Copy this file to `PROJECT_MEMORY.md` for a private deployment. The resulting
file is ignored by Git and must never contain credentials or private keys.

## Product invariants

- One Execution Kernel, one authoritative orchestrator and one state machine.
- Model output is never Tool Evidence.
- Doctor diagnosis is separate from mutation and PATCH_GATE.
- Credentials and OAuth state remain local to user x node.
- Automated failover requires a valid coordination authority and fencing token.

## Local topology

Document node IDs, roles and eligibility here without committing the file.

## Release status

Record signed release IDs, validation receipts, rollback state and unfinished
production work here.

