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

Candidate `2e051cbc4c09d1a3e19be440d9900b4b88376244` passed all ten jobs in
[CI 36577688221](https://github.com/samuelvoltarius/xaventra/actions/runs/36577688221).
The first attempt failed only the macOS artifact-service upload after five
network timeouts; the failed job rerun passed without changing source or gates.
Downloaded Windows/Linux/macOS 2.78.58 reports each pass ten packaged UI,
five isolated Core and seven full-daemon checks. These use a scripted provider,
not Telegram. A complete 155-commit candidate history scan found no secrets.

Pending: this evidence commit's own CI, main CI and signed publication.
No full RC claim. Recovery must preserve the prior native program,
runtime, channel credentials and workstation input journal; stop and verify the
new process before restoring the previous selection. Never start a second
Telegram consumer or unlock a personal session as a recovery shortcut.
