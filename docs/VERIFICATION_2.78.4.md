# Xaventra 2.78.4 verification record

This is a bounded source reliability release, not a full-product RC or signed
binary distribution. Exact-commit hosted CI is required before main updates.

## Reproduced failures

1. A packaged Desktop read a real temporary file successfully. Core recorded
   `desktop:<principal>` in the Outcome Ledger, but the Desktop Trust endpoint
   filtered by `<principal>`. Opening the linked run returned HTTP 404.
   Governed Memory had the same scope mismatch.
2. After the read, `/status` was flattened together with the entire room
   transcript into a new user message. Instead of command dispatch it entered
   the model/kernel again. Retained negative reports include both assertions.
3. Visual inspection of the denied file case found a contradictory badge:
   the tool failed, but its badge said no evidence was needed. A new assertion
   reproduced this on the packaged binary. Required incomplete actions now
   say unverified; absent action metadata remains explicitly unknown.

The fix resolves execution identity with the same explicit channel mapping,
without rewriting history, prefix guessing or opening other users' records.
Native session checkpoints already restore room/bot context; current requests
now stay intact instead of receiving a duplicate transcript as new instructions.

## Repeatable acceptance

Run `npm run build`, `npm run desktop:build`, then
`npm run check:desktop-core`. Linux uses a virtual display via `xvfb-run -a` and
requires the packaged Chromium sandbox helper; running as root is rejected.

Five groups launch the actual native package against production Desktop API,
message pipeline, native runner, typed file tool, lifecycle policy, independent
validator and Outcome Ledger code:

- Explicit Main authority and actual packaged-version identity.
- Keyboard file task, real file contents, completed validator and exact linked
  Outcome; open the Trust dialog with its real button and close it normally.
- A following slash command dispatches without another model/Outcome run.
- Canonical memory scope and Trust lists; other-user/unscoped records rejected.
- A forbidden fixture file is denied; no leaked contents or verified completion.

The model is a deterministic loopback fixture. The minimal Core state does not
start the full daemon, production providers, remote nodes or channels. The
loopback Desktop API uses its documented development mode: this is not an
OAuth, remote-token, TLS, installer, signing or HA test. Seeded governed Memory
checks its projection/scope, not automatic extraction or live-model recall.

CI retains per-OS JSON reports and synthetic screenshots, including failures.
Reports identify source revision, version and platform. Local exploratory
keyboard/mouse checks also covered drafts, auto/pin selection, settings, actual
Trust evidence and the minimum viewport. Initial test-authoring mistakes and
an interrupted exploratory session were retained, not counted as product proof.

## Remaining gates

Local checks: 165 Core test files / 1,075 tests, seven Desktop bridge tests,
the ten simulated-API UI groups and five real-Core-component groups passed on
Windows. A separate real local `qwen` native-runner/REST acceptance run passed
8/8 at 2026-09-06 08:07:52 UTC. That separate run proves bounded tool/restart/
correction/isolation behavior, not live-model Desktop or full-daemon coverage.
Windows packaging remains unsigned; no unsigned binary is distributed.

Full daemon-to-packaged-client lifecycle, real-provider Desktop runs, channel
delivery, distributed takeover/memory convergence, native OS integration and
signed installer/update/rollback still require separate acceptance. Auto-route
node metadata may be absent from the isolated run; the UI displays unknown
rather than inventing it. No full UI, end-to-end HA or comparative-agent score
is inferred from these five groups. See [RC inventory](RELEASE_PLAN.md).
