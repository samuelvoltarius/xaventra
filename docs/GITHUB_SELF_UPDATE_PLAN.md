# GitHub-backed self-update: current gap and implementation contract

Status: **discovery/staging in 2.78.21; publisher and independent container
controller implemented in 2.78.22**. See [enrollment and recovery](CONTAINER_UPDATES.md).
Live publisher enrollment and production canary are separate acceptance gates.

## Implemented command contract (2.78.21)

- `/update check` and `check_updates` read published releases from the pinned
  `samuelvoltarius/xaventra` repository. No Git clone, shell or GitHub token is
  required. Stable excludes prereleases; `mesh.update.github.channel: "rc"`
  explicitly includes RCs. Drafts and commits without a release are not eligible.
- `/update prepare <release-id>` requires Owner/Admin and rechecks the exact
  displayed release before downloading. A changed candidate needs a new choice.
- `/update deploy <release-id>` verifies and submits to the independently enrolled
  controller. Missing enrollment/grant fails closed. Accepted is not installed;
  signed status persists outside the replaced application. Adding SSH profiles
  does not replace controller enrollment; never expose the raw Docker socket.
- `/update status` distinguishes upstream discovery/staging from local Mesh
  rollout status. `/update deploy-local` is the explicit compatibility operation
  for distributing a **local build**, not an upstream release.
  Already enabled local-build installations with SSH profiles and no `github`
  block retain their existing `/update deploy` behavior for compatibility.
- The old `pull_update`/`pullAndRebuild` path fails closed. It no longer stashes,
  pulls, installs packages, resets or overwrites a live checkout.

Operator configuration is under `mesh.update.github`:

```json
{
  "channel": "stable",
  "publisherKeys": {
    "your-publisher-key-id": "OPERATOR_ENROLLED_ED25519_PUBLIC_KEY_PEM"
  }
}
```

No private key belongs here. Obtain and verify publisher fingerprints separately;
never enroll a key from the release itself or substitute a node's Mesh identity.
The existing enabled Main update checker polls GitHub when this block exists,
with notification deduplication; automatic activation is not enabled by polling.
Explicit checks also work without enabling the Mesh rollout.

The release must contain `xaventra-update.json`, an envelope with `keyId`,
`payload` and base64 Ed25519 `signature` over the exact UTF-8
`JSON.stringify(payload)` bytes. Payload shape:

```json
{
  "schema": 1,
  "repository": "samuelvoltarius/xaventra",
  "version": "2.79.0",
  "commit": "EXACT_40_CHARACTER_LOWERCASE_GIT_COMMIT",
  "minUpdater": "2.78.21",
  "artifacts": [{
    "name": "xaventra-linux-arm64.tar.gz",
    "platform": "linux",
    "arch": "arm64",
    "size": 12345,
    "sha256": "EXACT_64_CHARACTER_LOWERCASE_SHA256"
  }]
}
```

The version must match the release tag (`v2.79.0`). Each platform/architecture
and asset name must be unique. Windows is `win32`; supported descriptors use
`linux`, `darwin`, `win32` and `arm64`/`x64`. This descriptor acceptance is **not**
native-install certification. A publisher signature authenticates the declaration;
it does not independently prove that CI passed or that the package matches source.
An approved CI publication workflow still has to establish those guarantees.

Packages are streamed to `.nova-data/upstream-updates`, maximum 256 MiB each,
with free-space checks, exclusive temporary files, hash/size checks and atomic
promotion. They are not extracted or executed. Aborted partial downloads are
removed; successful packages and manifests stay available for an eventual
controller that must reverify them. Do not manually extract over a live runtime.
Metadata is capped, requests time out, redirects are restricted to GitHub's
release-asset host, successful checks cache for five minutes and failures back
off for one minute. Trust/channel/platform/version changes invalidate the cache.
A truncated 100-entry listing reports unknown rather than a false current result.

Protocol source: [GitHub releases API](https://docs.github.com/en/rest/releases/releases)
and [release assets API](https://docs.github.com/en/rest/releases/assets).

## Previous implementation and retained local-build path

`src/core/slash-commands.ts` routes `/update` to local status and `/update deploy`
to `src/core/auto-updater.ts`. The latter builds/tests a local release, signs a
manifest, requires Main fencing authority and uses typed sequential node profiles
with health/rollback receipts. Its periodic check compares local package versions;
it does **not** discover or download a new upstream GitHub release.

`src/infra/auto-update.ts` separately fetches/pulls Git and rebuilds in place.
It was reachable through the `check_updates` / `pull_update` tools in the complete
registry. The in-place mutation has now been removed because it was not a safe upstream integration:
it stashes live changes, detects dependency changes from commit subjects and
tolerates stash-restore conflicts. `src/core/self-update.ts` is another local
patch-proposal mechanism, not the canonical upstream release channel.

Activation paths must converge on one update authority. Do not wire automatic polling
to the old in-place pull/rebuild implementation.

## Desired user experience

- `/update` or “Update Xaventra”: discover an eligible release and show version,
  verified origin, changes, applicable nodes, risks and required approval.
- `/update check`: read-only discovery, never mutation or restart.
- `/update deploy`: explicit Owner/Admin authorization for the exact prepared
  release and node set, enforced by the current Main lease/fencing token.
- `/update status`: persisted per-node download, verification, canary, restart,
  acceptance and rollback state; never claim “started” before work is accepted.
- Automatic discovery is separate from automatic installation. Unattended
  installation requires an explicit policy, maintenance window and budget.
  A new commit on any branch is not a production release authorization.

## Required implementation

1. Publish immutable upstream release artifacts from a reviewed exact commit
   after green relevant CI. Include version, commit, platform/architecture,
   checksums, signed manifest, compatibility and minimum updater requirements.
   Respect stable/RC channels; do not treat arbitrary candidates as stable.
2. Add bounded, cached GitHub discovery with expiry/backoff and a pinned trusted
   repository. Reject drafts, disallowed prereleases, malformed versions and
   untrusted download destinations. Offline/rate-limited checks report unknown,
   never “up to date” based on a failed request.
3. Verify upstream publisher identity separately from mesh identity. A Main
   signature over downloaded bytes is not proof those bytes came from a trusted
   publisher. Never download a new trusted key from the same untrusted manifest.
4. Stage artifacts outside the running installation. Preserve configuration,
   Telegram credentials, user stores and keys; never embed them in releases.
   Take verified backup/checkpoints before migration. Reject dirty unmanaged
   source checkouts rather than silently stashing or overwriting user changes.
5. Use an explicitly authorized node-local updater/controller for activation.
   A Docker runtime without host access cannot replace its own container by
   wishing it so. Do not mount an unrestricted Docker socket or grant general
   shell/sudo access merely to make updates work. Use typed bounded operations.
6. Reuse Main lease/fencing and sequential canary receipts. Persist release and
   next action so a new authorized Main can resume without a second rollout.
   Workers cannot acquire Telegram polling authority through an update. Health,
   real version, minimal chat/tool checks and data-schema acceptance are required
   before advancing. On failure stop and restore the verified previous artifact
   and data state; irreversible migrations need a separately approved plan.
7. Test untrusted signatures/hashes, wrong architecture, failed downloads,
   concurrent deploy requests, disk exhaustion, migration/health failure,
   restart midway, lease loss and explicit rollback. Run real installation,
   upgrade and rollback acceptance on each advertised platform, separately from
   mocks. Native signing/notarization prerequisites remain external gates.

## Completion criterion

An enrolled installation discovers the new trusted release, an authorized user
starts it with `/update deploy`, and the controlled cluster updates without
manual SSH or lost user data; rejection/rollback tests also pass. Until that is
demonstrated, GitHub self-update remains **open** in the release plan. No updater
has been enabled and no production restart authorized by this design document.
