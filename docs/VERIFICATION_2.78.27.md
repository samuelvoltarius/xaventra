# Xaventra 2.78.27 verification

## Reproduction

Spark was online. The earlier Tailnet check failed because Tailscale on the
Windows caller was stopped. Read-only LAN and trusted SSH checks established:

- `gx10-c809` reachable at `192.168.0.94`;
- vLLM listening on port 8000 and `/v1/models` returning HTTP 200;
- `xaventra-spark` 2.78.20 running healthy;
- internal Xaventra `/v1/health` returning 200 on loopback port 18789.

With the same exact-answer prompt and `max_tokens=128`, default reasoning spent
the whole allowance in hidden reasoning and returned `content: null` with
`finish_reason: length`. At `max_tokens=512` it eventually returned the answer
after 10,093ms and 240 completion tokens.

## Implemented boundary

- Deterministic effort selection: fast/tool turns `none`; complex text-only
  turns preserve low/medium/high policy effort.
- Local OpenAI-compatible requests forward `reasoning_effort`; Ollama maps
  `none` to `think: false`.
- vLLM `reasoning` and legacy `reasoning_content` are parsed into protected
  response metadata.
- Reasoning-only output can trigger one budget-accounted non-thinking retry.
- Tool calls remain valid even with empty visible text.
- Python interpreter discovery has one 3.5-second aggregate deadline and a
  one-second per-launcher ceiling after Windows CI exposed a hanging alias.

## Current evidence

- Focused policy/provider regression: **10/10**, passed.
- Complete Core regression: **225 files / 1,546 tests**, passed with
  process-local Git long-path support; no test was skipped or weakened.
- TypeScript typecheck: passed.
- Build: passed.
- Runtime catalogs: current.
- Desktop regression: **7/7**, passed with an isolated workspace-local temp
  directory.
- Dependency audit: Desktop has zero known vulnerabilities. Core has no known
  high/critical vulnerability; npm reports two moderate development-only
  findings in Vitest 3.2.7 / `@vitest/mocker`. The offered fix is a breaking
  Vitest 5 upgrade and is not silently folded into this runtime patch.
- Exact runtime candidate `f892f77579e3c1f0e75af74132ec556e11789c4e`
  passed all ten jobs in
  [CI 35463459896](https://github.com/samuelvoltarius/xaventra/actions/runs/35463459896),
  including Windows/Linux/macOS verify and packaged Desktop smoke, isolated
  repair, managed repair and Docker repair. The preceding candidate failed on
  Windows because Python launcher discovery exceeded the test deadline; that
  failure was retained and fixed rather than retried away.
- Actual compiled Xaventra client against Spark:
  - `none`: **405ms**, **4** completion tokens, exact `SDK_FAST_OK`;
  - `low`: **1,085ms**, **20** completion tokens, exact `SDK_FAST_OK`;
  - non-thinking, required function call: **1,183ms**, structured
    `health_status`, 17 completion tokens, zero reasoning characters.

The direct API pre-check also returned `SPARK_FAST_OK` in 530ms/5 tokens with
`reasoning_effort: none` and in 423ms/5 tokens with
`chat_template_kwargs.enable_thinking: false`.

## Open gates

- Final documentation commit CI and normal `main` promotion.
- Production Telegram/Desktop adoption and latency observation.
- Typed semantic tool targets, durable evidence resume, complete memory
  correction and remaining HA/RC gates.

No production node, model server or container was changed during this candidate.
