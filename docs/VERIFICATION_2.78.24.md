# 2.78.24 — Discovery probe noise

Scope: repeated AI discovery requests to a non-AI HTTP service on a common TTS
port. This is an incorrect protocol probe, not a port-binding conflict. No
foreign application is stopped, reconfigured or treated as an AI capability.

## Evidence and reproduction

- Source baseline: `f26c89c3aa5d496e0de4425ceb96e0031ee1c207`.
- Baseline scanner repeats all localhost protocol probes every five minutes;
  it has no persistent negative cache or explicit endpoint exclusions.
- Local unit regression: nine new checks pass. Full Windows regression:
  221 files / 1,521 tests passed. Final exact-commit CI must pass before
  promotion; these results are not RC acceptance.
- Actual compiled Windows loopback HTTP acceptance: 8/8 pre-commit checks,
  including exclusion, repeated 404, child-process cache reuse, positive AI
  fixture, HTML rejection, retry expiry, body deadline/size and redirect refusal.
  The retry-expiry clock and AI payloads are controlled fixtures, not live models.
- Cross-platform CI runs the same compiled script and retains `report.json`
  with source revision, dirty status, platform and individual results. Exact
  candidate CI must be green before main, including all existing gates.
- Production rollout and post-change request cadence require separate operator
  evidence. Local tests do not claim that a running node has been updated.

```sh
npx vitest run src/mesh/discovery-probe.test.ts
npm run build
node scripts/check-discovery-probes.mjs
```

## Recovery and limits

[Environment discovery guide](ENVIRONMENT_DISCOVERY.md) documents node-local
exclusions, finite retry periods, cache reset and unchanged configured model
routes. No automatic installation, foreign process termination, claim of
complete service identification or general autonomy/RC acceptance is introduced.
Rollback requires the retained previous container/image and backed-up runtime;
old versions ignore the new exclusion variable and resume their previous probes.
