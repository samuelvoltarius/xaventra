# 2.78.58 desktop-use candidate

Focused change: daemon policy loading, authenticated owner context, typed input
and an optional dedicated X11 workspace. Unfinished native updater development
is not part of this candidate.

Prior local workstation acceptance observed actual capture, click/key effects,
changed image bytes and duplicate suppression. This does not prove Telegram
delivery or acceptance of this exact release. Production activation remains
separate from source tests and signed publication.

Local Core regression passes 269 files / 2,003 tests. The first run failed a
temporary Git fixture at the Windows path-length limit; the retained rerun
enables Git long paths without changing assertions. Desktop regression passes
12 tests; build, catalogs and layer checks pass. The compiled Windows daemon
passes seven lifecycle checks with a scripted loopback model. Staged secret
scan is clean. These are local, pre-commit results.

Pending: exact-candidate CI, evidence CI, main CI and signed publication.
No full RC claim. Recovery must preserve the prior native program,
runtime, channel credentials and workstation input journal; stop and verify the
new process before restoring the previous selection. Never start a second
Telegram consumer or unlock a personal session as a recovery shortcut.
