# 2.80.1 Hotfix: rollout findings and a callback security fix

Base: main 2.80.0 (93ee6f8), branch `claude/hotfix-2.80.1`. Findings 1 to 3
were observed live on the Spark on 01.10.2026 (14:20 to 14:33) after 2.80.0
was rolled out on all four nodes; finding 4 came from a code review.

## Findings and causes

1. Knotenprofil missing on the Main. `mesh-peer-state.json` on the Spark had
   no `profile` for ns1, ns2 and the NAS. Workers send the profile on start,
   on change and every 6 h (`shouldPublishProfile`, `startMeshDataPlane`);
   the Main restarted after the workers and had no profile for up to 6 h.
2. False NAS alert ("Erreichbarkeit unbekannt: SSH fehlgeschlagen").
   Source: L21 node health, pass 2 (`checkAllNodes`), which SSH-probes config
   nodes "not covered by mesh". Coverage was only an exact address match; the
   config entry "Nas" and the mesh node `xaventra-nas` use different
   addresses, so the NAS was SSH-probed. The Spark has no SSH key for mesh
   workers by design.
3. Phantom vLLM on ns2 (`vllm@xaventra-ns2:8000`, verificationSource=probe,
   status=running). The id is the AIScan "mesh advertisement" phase 4 format.
   The 60 s graph snapshot broadcast overwrote ns2's own runtime list in the
   Spark's peer state (`peerStateWithCapabilities`), discovery then read ns2's
   runtimes from that snapshot (`discoverNodes`, legacy path), which still
   carried a persisted ns2 runtime, and phase 4 re-labelled it as a probe with
   ns2's current heartbeat time. The 2.79.x fix only dropped heartbeat
   runtimes.
4. Security: two Telegram callback branches had no sender or role check:
   node install (`ni:`, model name reached a shell command, local or over
   ssh) and skill release (`skill_ok:` / `skill_no:`).

## Fixes

1. Heartbeats carry `bootId` and `profilesHeld` (bounded to 64 ids). A node
   that sees a new boot id, or is not in the list, sends its profile once on
   the next tick; retry at most every 5 min (`decideProfilePublish`). Peers
   without the fields never trigger a resend. The profile stays bound to the
   authenticated source node.
2. `configNodeCoveredByMesh`: a config node matching a mesh node by mesh node
   id, `mesh.update.nodes` mapping, address, name or `<prefix>-<name>` node id
   is not SSH-probed; mesh nodes are judged by the signed heartbeat (pass 1).
   Nodes outside the mesh are still probed. No SSH access was added.
3. A snapshot no longer replaces a peer's own advertisement in peer state;
   phase 4 entries carry `metadata.source = 'mesh-advertised'` and the node id,
   are stored as heartbeat evidence on that node and dropped once its heartbeat
   stops listing them; a heartbeat that lists `ai_services` also drops running
   network runtimes from earlier probes that it does not list (a current probe
   re-adds them in the same ingest); peer snapshots no longer carry probe
   runtimes about third nodes, and the receiving node's own entry is refused
   even before its first ingest (`setLocalNodeId`).
4. `ni:` and `skill_ok:`/`skill_no:` resolve the pressing user's principal
   and require the owner role. Model names must match a strict allowlist; a
   local install runs via `execFile` without a shell; remote installation is
   refused with a pointer to the mesh catalog.

## Tests (red before the fix)

- `src/mesh/peer-profile-resend.test.ts` (6): Main restart with new boot id
  and empty peer state, missing profile, compatibility, bounded list, source
  binding.
- `src/layers/L21-node-health-mesh.test.ts` (3): mesh NAS with fresh
  heartbeat and a different config address is neither SSH-probed nor alerted;
  matching rules; a non-mesh node is still probed.
- `src/mesh/capability-graph-probe-phantom.test.ts` (4): the live sync loop
  (ns2 broadcasts runtimes and snapshot, Spark discovery, phase 4, ingest,
  merge) reproduced exactly `vllm@xaventra-ns2:8000`, probe, running, with a
  fresh verifiedAt before the fix; after it, no running runtime on ns2 and
  `resolveVllmFallback` returns the Spark endpoint.
- `src/channels/telegram-callback-install.test.ts` (7): non-owner `ni:` and
  `skill_*` rejected, metacharacter model names rejected without execution,
  remote refused, valid owner callback runs `execFile('ollama', ['pull', ...])`.

## Counter-probes (fix reverted alone, test red)

- Profile: forced resend disabled → Main-restart test red; boot-id trigger
  disabled → boot-id test red.
- L21: coverage filter disabled → NAS test red (SSH probe and alert).
- Graph: snapshot guard off → peer-state test red; heartbeat drop rule off →
  live-loop test red; mesh-advertised as probe → binding test red;
  third-node filter off → snapshot test red.
- Telegram: whole fix reverted → 6 of 7 tests red.

## Gates

- `npx tsc --noEmit -p .`: 0.
- `npm run -s catalogs:generate` (3 changed) then `npm run -s check:catalogs`: current.
- Full suite (`vitest run --maxWorkers=2`): 502 files passed, 3384 tests passed, 1 skipped, exit 0.
- Gitleaks on every staged commit: no leaks.

Pending: candidate CI on `claude/hotfix-2.80.1`, merge to main, signed
publication and rollout. Live checks after rollout: on the Spark,
`mesh-peer-state.json` has `profile` and `bootId` for ns1, ns2 and the NAS
within a few minutes of a Main restart; no new "Nas — Probleme erkannt"
journal entry; capability graph has no running runtime on ns2 and the vLLM
fallback resolves to the Spark; a non-owner `ni:` callback is answered with
"Nur der Owner".
