# 2.78.21 upstream discovery and download evidence

## Scope

The previous `/update deploy` could only distribute the current local build;
with no enrolled profiles it refused. It did not download GitHub releases.
The separate legacy tool could mutate/reset the running checkout. This candidate
adds verified upstream staging and removes that unsafe legacy mutation. It does
not implement the missing independent upstream activation controller.

## Evidence and limits

- Windows working-tree full Core regression: 216 files, 1486 tests passed.
  No earlier failure was deleted or changed into a success.
- Focused upstream and local-updater regressions initially passed 27/27; two
  additional signed-descriptor/listing negatives passed in the full regression.
- Compiled Windows x64 acceptance: 7/7 over a real loopback HTTP server, generated
  disposable publisher key, actual staged files and persisted restart status.
  Also checks revoked trust/cache mismatch, role denial, corrupt bytes and no
  false deployment completion. This is not a GitHub-hosted package or live Mesh.
- Separate real public GitHub discovery at 2026-09-09T13:07:01.951Z returned
  `no-eligible-release`, not a download success. No releases were published for
  the sake of obtaining a passing test. No GitHub token was required.
- Desktop bridge regression: 7/7. No new packaged-Desktop feature is claimed.
- The same compiled HTTP-fixture suite is now included in the existing CI
  Windows/Linux/macOS matrix, with failure reports retained as artifacts.

Candidate: `codex/github-update-2.78.21`. Exact-source results are available in
[candidate CI](https://github.com/samuelvoltarius/xaventra/actions/workflows/ci.yml?query=branch%3Acodex%2Fgithub-update-2.78.21).
Pending CI must not be read as passed. Promotion requires the entire relevant CI,
not only a successful subset. Source commit is provided by that immutable run.

## Still open — no production self-update claim

1. Approved public publisher identity and immutable packages built from exact
   green CI, including independently verified source/artifact provenance.
2. Node-local upstream activation controller, exact release/node approval,
   lease/fencing, persistent rollout reconciliation and writable-state recovery.
3. Real GitHub-to-container canary upgrade and rollback on enrolled nodes.
4. Previously observed production shutdown hang and early startup errors.

The app has not received Docker-root access, signing keys or SSH credentials.
No production container, runtime configuration, user memory or Telegram identity
was changed by this source-development round. This is not RC or complete repair.
