# Repair tool-admission boundary

Version 2.78.17 adds an **opt-in** coordinator. It is not automatic production
enablement or proof that every process/API/database writer has been fenced.

## Protocol and trust

Registered tool handlers obtain an independently persisted permit before running.
The permit binds node, action UUID, tool, epoch and opaque execution token. A
maintenance ticket atomically closes admission across all configured members.
The controller waits for actual handler completion before modifying a runtime.
Caller/UI timeout does not settle the ledger. Lost replies must not replay tools.

The root-owned coordinator pins membership, node public keys and `settledTools`
out of band. The first registry completion-bounded handler is the original
built-in `read_file`; other handlers conservatively become uncertain. A plugin
with the same name does not inherit bounded completion. Shell commands, detached
processes, deployments and remote APIs need separately validated completion and
reconciliation adapters. Do not add names merely to bypass uncertainty.

Nodes cannot close/reopen maintenance. A separate operator identity starts it;
release requires a separate controller-signed receipt matching the entire ticket,
old/new runtime identities and independently observed repair or rollback. An
unreachable release endpoint preserves the receipt and closed admission. Querying
controller status retries release without repeating deployment. Expiry never
reopens admission. Old release retries cannot reopen a newer owner's hold.

State-copy authority now requires both a signed drain observation and a fresh
external-writer attestation. Missing tool-drain configuration fails closed.
`toolActionsDrained:true` **always** accompanies `externalWritersQuiesced:false`
in the drain protocol: the latter comes from another deployment-specific owner.
The authority reads current lease/grant after drain RPC, not before waiting.

## Explicit operator configuration

Build the source, then install the compiled closure outside runtime-owned mounts.
No service is installed by these instructions or automatically enabled on update.
Use independently generated, node-local keys; never reuse test keys or put private
keys in config examples, source, Git, model context, shared memory or Mesh payloads.

`node scripts/repair-drain.mjs /protected/drain-config.json` runs on a configured
loopback port. The root-owned config specifies:

- `port`, existing protected `stateRoot`, `authorityPrivateKeyFile`,
  `operatorPublicKeyFile`, `receiptPublicKeyFile`;
- `nodes`: explicit node ID to `{publicKeyFile, settledTools}` mapping;
- optional `observers`: read-only observer ID to public-key-file mapping.

The runtime's `XAVENTRA_REPAIR_DRAIN_CLIENT_FILE` points to a private per-node
JSON file with `url`, `actor`, `privateKey`, `authorityPublicKey`. Its only private
key is that node's admission identity. Restrict the file to its runtime user and
exclude it from shared volumes, backups intended for publication and tool reads.
Non-loopback RPC requires HTTPS via an operator-managed authenticated gateway.
Keep the same runtime setting present after replacement; missing configuration
means legacy non-participation, not a global guarantee.

Controller config adds `drainUrl`, `drainOperatorPrivateKeyFile` and
`drainAuthorityPublicKeyFile`. The authority config adds `drainUrl`,
`drainObserverId`, `drainObserverPrivateKeyFile`, `drainAuthorityPublicKeyFile`.
Observers cannot acquire permits or alter maintenance. All operator files must
pass existing root ownership, no-link and permissions checks.

## Crash and recovery limitations

The coordinator is a single writer with a retained crash lock. Clean restart
reloads its ledger. A vanished member, unknown action or expired ticket requires
operator reconciliation; never delete the lock or mark actions settled by age.
The initial implementation intentionally offers no generic "clear uncertain"
API. Full ledger or membership changes also fail closed. Back up the complete
private coordinator directory with its receipt/state evidence and prevent other
restart owners from starting a second writer.

Linux production writes flush the state file and rename directory before permit
acknowledgement. Windows process tests do not claim power-loss durability.
Unregistered direct module calls and daemon/background writers are not covered
by the registry wrapper. Source-mirror advancement, artifact preparation, full
external-writer fencing, exclusive production restart ownership and original
production symptom verification remain necessary before unattended activation.

## Reproduction and evidence

```sh
npm run build
npm test -- src/doctor/repair-drain.test.ts src/doctor/repair-drain-server.test.ts src/doctor/repair-controller-server.test.ts src/tools/repair-admission.test.ts
node scripts/check-repair-drain.mjs
```

The compiled test uses actual signed loopback HTTP and two disposable node
processes. It proves pending writes, rejection on another node, completed file
writes, lost-process persistence and coordinator restart. Its final test-only
release is operator-owned fixture recovery, not a live Mesh or container claim.
HTTP regressions separately require valid independent receipts for reopening.
Reports retain failures under `.nova-data/repair-drain-qa/`. Three-OS CI runs the
same compiled script; broader Docker/model/state acceptance remains separate.
