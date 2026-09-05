# Nova Production Operations

This guide describes the Nova 2.72 production invariants. It complements the
configuration reference; it does not replace the Mesh lease, release or Tool
Execution authorities implemented in code.

## Node roles

| Role | Runtime behavior |
|---|---|
| Main | Holds `nova-main` and every active channel lease with fencing tokens. |
| HA standby | Heartbeats and replicates governed state; channels remain disconnected until takeover. |
| Worker | Executes typed Mesh work with channels disabled and `NOVA_MAIN_ELIGIBLE=false`. |
| Rollback host | Runtime may be staged, but the service remains disabled. |
| Interactive client | User-facing development/Codex node; credentials remain User × Node. |

Runtime profiles describe capabilities and hardening. They never override the
lease authority or silently promote a worker.

## Pre-release checklist

1. Update SemVer in `package.json`, both package-lock entries and the changelog.
2. Run `npm run typecheck`, `npm test`, `npm run build`,
   `npm run check:build`, `npm run check:catalogs`,
   `npm run check:assurance`, and `npm run check:release`.
3. Confirm the active Main owns a fresh fenced lease and no critical mission or
   approval is in progress.
4. Create one signed, hash-addressed artifact. Never rebuild independently on
   each worker.
5. Activate Spark as canary, then eligible workers/standbys. Preserve
   node-local configuration, Mesh identity, state and credentials.
6. Require signature/hash validation, runtime version marker, health,
   heartbeat and a persisted rollout receipt. Roll back on any failed gate.

The Pi rollback runtime may be updated without starting its disabled service.
That is recorded as staged, not as a verified active-node receipt.

## Telegram ownership and recovery

Only the live `nova-main` and `telegram` lease holder may poll or send. A 409
from `getUpdates` means another process is using the same bot token. Nova 2.72.1
stops immediately and revalidates authority twice before retrying. A legacy
process without this guard must be stopped or invalidated by rotating the token
through BotFather.

After token rotation, install the replacement only as a local secret on Main
and eligible standby nodes. Never write it to Git, release artifacts, Memory,
Supabase, Mesh envelopes, logs or the Capability Graph.

## Rollback

- Docker profiles restore the previous verified image and persistent volumes.
- systemd profiles restore the previous verified runtime tree.
- A rollback does not restore or copy OAuth/channel credentials; those remain
  node-local throughout.
- A demoted Main must be fenced before the replacement sends external actions.

## Evidence to retain

Retain the release ID, artifact hash, signature result, per-node activation
receipt, runtime marker, heartbeat, validator output, rollback result if any,
duration and cost in the Outcome Ledger and Nova Trust view.
