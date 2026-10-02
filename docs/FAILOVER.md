# Main failover: succession with full knowledge (2.86 package K)

Status: library + automated acceptance in a simulated five-node mesh.
**Not active on any live node.** No live configuration was changed; the
current production setup (only one Main-capable node, `mesh.coordination.mode
= supabase`, no witnesses) keeps working exactly as before. This document is
the runbook for the later live test — it describes, it does not execute.

## What it guarantees

| Owner decision (02.10.) | Mechanism | Code |
|---|---|---|
| Main chosen automatically by suitability | `rankNodes('main', nodes)` — measured strength, `main-ineligible` nodes never lead | `src/mesh/succession-ranking.ts` (stub until package J) |
| Successors in order, several failures | On a vacancy the best *reachable* eligible node goes first; candidate *i* waits *i* × grace before it may try | `src/mesh/succession.ts` |
| Never two Mains | Lease needs ⌊n/2⌋+1 witness approvals per TTL (one witness per node); local deadline ends 1 s before the witness lease; every journal replica rejects older epochs (`fenced`); an emergency Main yields before a majority Main is elected | `witness-quorum.ts` (`decideQuorumLease`), `quorum-witness.ts`, `state-journal.ts` |
| New Main knows everything | Every change of missions, cards, planner, thoughts, responsibilities, decisions, procedures, memory governance and tools is a signed, encrypted, hash-chained journal entry; committed only after ≥ 2 other nodes confirmed it; snapshots + checksum; the successor replays up to the last confirmed entry and **refuses** to take over if a confirmed entry is missing | `state-journal.ts`, `state-file-mirror.ts` |
| No majority → safety mode **and** owner emergency release | Safety mode: no Main, nothing consequential, owner notified on every reachable channel. The best-placed reachable node sends a one-time code (hash-only storage, bound to that node, ≤ 30 min, single use, 5 attempts) | `succession.ts`, `emergency-release.ts` |
| Secrets on all nodes, unlock only with majority | Secret bundle encrypted once; data key split k-of-n (Shamir); each node holds one share sealed to its own X25519 key; holders release a share only after verifying the requester's majority lease themselves (or the owner code) | `secret-shares.ts` |
| Telegram only on the elected Main | Existing Telegram lease rules stay; additionally `canStartTelegramPoller()` is true only for the acting Main with an unlocked token | `succession.ts` |
| Nothing in the cloud | Journal, snapshots, shares and witnesses live on the mesh nodes only | — |

## Roles per node

Every node is witness, journal replica and share holder. Only the ranking
decides who may become Main; a storage node (e.g. NAS) carries
`main-ineligible` and stores ciphertext only (it never needs the journal key).

States: `follower` → `main` (majority lease) · `safety` (no majority) →
`emergency-main` (owner code) → `follower` (majority back).

## Failure matrix (five nodes, majority = 3)

| Failed | Reachable | Result |
|---|---|---|
| 0 | 5 | Best-ranked node is Main. |
| 1 (the Main) | 4 | After the lease TTL the next in rank takes over with the replayed state. |
| 2 | 3 | Still a majority: next in rank takes over; commits need the 2 remaining replicas. |
| 3 | 2 | No majority anywhere: safety mode on both, owner notified; owner code can start an emergency Main on the best-placed node (separate branch, reconciled later). |
| Old Main returns | — | Its renewal fails, its writes are fenced, it follows; once stable and caught up the current Main hands back (higher epoch), never two at once. |

## Who can unlock what

- **Journal content** (Main knowledge): every Main-eligible node holding the
  journal secret (proposed env name `NOVA_STATE_JOURNAL_SECRET`, not read by
  any code yet; ≥ 32 chars, HKDF). Storage-only
  replicas never get it.
- **Secret vault** (Telegram token etc.): nobody alone. k shares are needed
  (proposal 3 of 5). Holders release only to a node that holds the majority
  lease *as seen by the holder*. With ≤ 2 nodes left this is impossible by
  design — then only the owner can help: emergency code (holders verify it once
  each) plus, if configured, the owner's offline recovery share
  (`ownerShare: true`, shown once at sealing, kept by Alfred).
- Plaintext secrets exist only in memory of the acting Main, are redacted in
  JSON/inspect/String and wiped on step-down. Nothing is written in plaintext
  to disk or logs; the emergency code appears only in the owner notice.

## Activation prerequisites (not done; owner decision)

1. Witness on every Main-capable node and on the NAS
   (`src/mesh/quorum-witness.ts`, now with `/v1/lease/peek|release`).
2. Peer keys with role `system` for each other node (otherwise
   `succession.request` envelopes are rejected by `MeshPolicy`).
3. Journal secret distributed to the Main-eligible nodes only.
4. Vault sealed once on the Main (k = 3 of 5, optional owner share), share
   files + X25519 node keys stored per node (mode 0600).
5. Daemon wiring: `SuccessionNode.tick()` every 10 s, `scanStateFileChanges`
   on the acting Main, `materializeStateFiles` before services start on a new
   Main, `registerSuccessionEndpoint` on every node, Telegram start gated by
   `canStartTelegramPoller()`.

## Live test runbook (describe only — run later with Alfred)

Preconditions: all five nodes on the same release; witnesses healthy
(`GET /health`); `/status` shows one Main; a fresh snapshot exists; Alfred is
reachable on the App and Telegram; a rollback window is agreed.

1. **Baseline.** Record Main, epoch, journal `lastSeq`/checksum on every node.
   Create one test mission, one card and one planner job (marked `TEST`).
2. **Main off (Spark).** Stop the daemon on the Spark (not the host).
   Expected within lease TTL + grace (≈ 30–45 s): the next-ranked node is Main,
   epoch +1, checksum equals the baseline + test items, exactly one Telegram
   poller (check `getUpdates` 409 conflicts: none).
3. **Second failure.** Stop the new Main. Expected: the third-ranked node takes
   over with the same checksum; commits still confirmed by the 2 remaining
   replicas.
4. **No majority.** Stop one more node (2 left). Expected: safety mode on
   both, one owner notice per node, a code only from the best-placed node, no
   Telegram poller anywhere, consequential tools refused.
5. **Emergency release (optional).** Alfred returns the code to that node.
   Expected: emergency Main, notice "Notbetrieb", changes marked as branch.
6. **Return.** Start the stopped nodes. Expected: emergency Main yields, the
   best-ranked node becomes Main (epoch +1), the branch is reconciled
   (conflicts reported to the owner), all nodes converge to one checksum.
7. **Stale Main.** Freeze (`SIGSTOP`) the Main for > TTL, then resume it.
   Expected: it steps down on its next tick, its writes are rejected
   (`fenced`), no second poller.

Abort criteria: two nodes report `isActingMain`, two Telegram pollers, a
checksum mismatch after takeover, any plaintext secret in logs. Rollback:
stop succession ticks, restore `mesh.coordination.mode = supabase`, start the
Spark as before.

## Open points

- Package J `rankNodes` (measured facts incl. uptime/network/disk) replaces the
  stub in `succession-ranking.ts`.
- Daemon wiring and key/share provisioning (see activation prerequisites).
- Emergency code delivery when the Telegram token is locked: the notifier list
  should contain a channel that works without vault secrets (App push / local
  dashboard).
- Owner recovery share: decide yes/no and where it is kept.
- Witnesses as independent processes on separate hosts (today co-located per
  node), and a quorum certificate in the journal promotion so replicas need not
  trust the promoting node's epoch claim.
