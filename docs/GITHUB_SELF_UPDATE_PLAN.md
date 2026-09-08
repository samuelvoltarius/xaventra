# GitHub-backed self-update: current gap and implementation contract

Status: **design / not implemented or enabled by 2.78.12**.

## What exists

`src/core/slash-commands.ts` routes `/update` to local status and `/update deploy`
to `src/core/auto-updater.ts`. The latter builds/tests a local release, signs a
manifest, requires Main fencing authority and uses typed sequential node profiles
with health/rollback receipts. Its periodic check compares local package versions;
it does **not** discover or download a new upstream GitHub release.

`src/infra/auto-update.ts` separately fetches/pulls Git and rebuilds in place.
It is reachable through the `check_updates` / `pull_update` tools in the complete
registry. It is not a safe upstream integration:
it stashes live changes, detects dependency changes from commit subjects and
tolerates stash-restore conflicts. `src/core/self-update.ts` is another local
patch-proposal mechanism, not the canonical upstream release channel.

These paths must converge on one update authority. Do not wire automatic polling
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
