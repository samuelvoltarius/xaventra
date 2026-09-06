# 2.78.9 — current inventory and private host boundaries

Status: candidate, not RC-ready. No production or private database changed.
Base: `07c88dcd3487e0c33b5135395ff213e30a383d49`. Exact candidate commit and CI
attestation will be recorded after all applicable checks pass.

Local Windows results: 184 files / 1227 Core tests, seven Desktop bridge tests,
ten compiled inventory/host-storage cases, typecheck/build, catalog checks and
assurance checks passed. Provider/SSH processes in focused security tests are
mocked; compiled inventory acceptance forbids networking entirely.

## Targeted security-fix result

Outcome: **fixed for new plaintext host writes and inventory-implied prompt
authority**, not migration or a full SSH audit. The shared `ssh-tool-hosts.ts`
writer now governs SSH connection metadata, host commands and correction updates.
New passwords and malformed/legacy rewrites fail explicitly. Only node-local
environment-reference names can be stored for unattended password resolution.
The pipeline/environment formatter emits credential-free inventory, not consent.
Host-management aliases enforce request-scoped Owner/Admin permission.

An independent read-only investigation and one candidate review traced the
writers/callers. Follow-up tests confirmed missing-reference behavior, explicit
key-auth override, ordinary password connection success without password
persistence, host add/update/delete, and correction consistency. A rejected host
write cannot publish its IP as a completed correction; credential-bound address
changes require explicit host management. The original write triggers now reject
without altering files; ordinary credential-free operations still pass.

Ordered checks: syntax/type/build passed; original and alternate triggers plus
legitimate controls passed; full Core/bridge/catalog/assurance regression passed.
Legacy plaintext reconnect remains read-only for compatibility. Native remote SSH,
all subprocess authentication variants, OS secret provisioning and operator-file
migration were deliberately not exercised and are not claimed fixed.

## Reproduced failures

- Ten new inventory tests initially failed: post-boot discovery was invisible;
  stopped/offline/stale/expired/tombstoned entries still routed from cached state.
- Additional negative controls exposed installed/configuration evidence being
  treated as usable setup capabilities and hard-coded installation suggestions.
- Three host-storage controls initially failed: new plaintext credentials were
  persisted, legacy files silently rewritten, malformed files overwritten.

Original failure logs remain in ignored local diagnostics; they were not removed
or reclassified as successes. Host prompt source inspection additionally found
blanket administrative permission inferred from an inventory entry. No actual
execution-kernel authorization bypass was claimed or demonstrated.

## Verification scope

- Core regression tests: real implementation with isolated temporary data.
- Compiled acceptance: real graph/store APIs and process restart, synthetic
  scanner/enrolled-node inputs. Ten cases, no networking or SSH/model inference.
- Host add/lookup/reference and command tests: simulated identities, local
  environment and filesystem only; no credential or production connection.
- CI: source installs and packaged Desktop/lifecycle jobs on Windows, Linux and
  macOS are required for the exact candidate SHA before main promotion. Scripted
  provider fixtures are not live-model acceptance.

Reproduction: `npm ci --ignore-scripts`, `npm run typecheck`,
`npm test -- --maxWorkers=2`, `npm run build`, `npm run check:capabilities`,
`npm run test:desktop`, `npm run check:catalogs`, `npm run check:assurance`.

The public history/private-host indicator and secret scans found no operator
host database or credentials in the checked public history/package. Negative
searches have bounded coverage and are not proof of universal secret absence.
No formal full-repository security audit completion is claimed.

## Recovery / limits

See [environment discovery and host migration](ENVIRONMENT_DISCOVERY.md).
Rollback the source candidate by selecting the previous verified source revision,
not by deleting runtime data. Legacy credential files are intentionally not
automatically migrated; reverting code also restores its old unsafe write behavior.
Native installer rollback, real cross-node failover/discovery, all SSH execution
variants and autonomous installation acceptance remain separate open gates.
