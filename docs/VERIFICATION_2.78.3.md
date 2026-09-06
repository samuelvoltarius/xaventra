# Xaventra 2.78.3 verification record

This is a bounded Desktop reliability iteration, not a full-product RC.

## Reproduced before the fix

On the actual Windows 2.78.2 package, selecting a different model erased an
unsent draft. An HTTP 401 left only a wake-up message, with no settings control.
Sending in alpha then opening beta displayed alpha's pending text in beta.
Exploratory testing also found that finishing a background reply replaced an
open settings form and discarded its unsaved input; the package check now
reproduces and guards that case too.
An additional negative bootstrap test found that a missing `controlPlane` was
accepted. The client now requires affirmative Main authority instead of treating
absent metadata as compatibility permission; that failure is also retained.
The new automated package check failed on the old binary at its five-second
settings-availability assertion; that negative report was retained locally.

The old UI check launched the source/development Electron entry, inherited the
operator's profile and expected a live Core. It did not send a chat message and
invoked full-display capture. It was not suitable as an isolated RC gate.

## Evidence and reproducibility

`npm run desktop:build && npm run check:desktop-ui` launches the packaged app,
asserts `app.isPackaged`, exact package version and a disposable profile path.
It uses real Electron, preload IPC, HTTP, keyboard/mouse and profile persistence.
The HTTP Core responses are explicitly **simulated**, with synthetic users,
models, history and nodes. No real provider call, signature, installer, channel
delivery or Mesh takeover is claimed by this test.

The ten groups cover package identity; prompt setup access after authentication
failure; recovery; exact-node model pin/auto with draft preservation; scrolling,
specialist toggle and navigation; failed-send restoration with no retry; one
keyboard submission and one primary response; room-local drafts and delayed
responses; preferences and relaunch; primary controls at minimum window size.
Desktop bridge tests additionally check the separate five-second bootstrap and
configured chat deadlines. Linux uses an explicit stable executable name.

Local verification on 2026-09-06: 164 Core files / 1,073 tests, seven Desktop
bridge tests, typecheck, build, catalog freshness and assurance passed. The
separate real local-model acceptance passed 8/8 at 06:24 UTC. Its reports stay
in the ignored benchmark directory; no production node was modified.

The local Windows package passed all ten groups, including discarding drafts
on a principal change. GitHub's `desktop-smoke`
jobs build and run these checks on Windows, Linux and macOS. Use the report's
`sourceRevision`, platform and version to identify the exact tested candidate;
the workflow's presence alone is not a passing platform result. Reports and
synthetic screenshots are uploaded even after failure. Profiles are excluded.

The first candidate [3352f26 CI](https://github.com/samuelvoltarius/xaventra/actions/runs/34016489907)
exposed a Linux Electron launch failure despite a successful package build;
this failed result is retained rather than treated as a skip. The disposable
Linux runner installs the packaged Chromium sandbox helper's required ownership
and mode, with browser launch diagnostics enabled. The renderer sandbox is not
disabled. Packaging explicitly uses `--publish never`; building a candidate
must not implicitly publish binaries. Launch failures now preserve a report
even when the browser automation library terminates on an unhandled rejection.

[Candidate c67cc51](https://github.com/samuelvoltarius/xaventra/actions/runs/34016849392)
passed six jobs but timed out in macOS's initial app-metadata check. The Desktop
main process synchronously checked OS encryption availability while reading
ordinary preferences. [Electron documents that keychain calls may block for
user input](https://www.electronjs.org/docs/latest/api/safe-storage). Token-free
startup now leaves encryption availability unprobed; actual credential storage
and use still check it. The Linux `basic_text` fallback is explicitly rejected.
Regressions make any keychain access from a token-free config read/save fail.

## Remaining limits

- Drafts survive view changes, not process restart; preferences do persist.
- No automatic resend after ambiguous delivery; review before retrying.
- Native installer execution, upgrade/rollback, binary signing/notarization,
  live channels and distributed failover remain open.
- Native folder picker, desktop-capture permissions, all Studio modules and
  every specialist/enrollment action need additional interaction coverage.
- General Core regression tests and the separate eight-case real local-model
  acceptance suite remain required; a simulated UI reply is not agent evidence.

See the [RC gate inventory](RELEASE_PLAN.md). No production service is modified
by this test suite or by the source release loop.
