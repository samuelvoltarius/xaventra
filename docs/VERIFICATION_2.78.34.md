# Xaventra 2.78.34 verification

## Scope

This candidate closes one bounded RC blocker: distributed Capability Graph
state must converge across removal, process restart and controlled successor
merge without stale resurrection or loss of concurrent runtime evidence.
Credential material must not cross the graph's persistence/replication
boundary.

## Evidence classes

| Class | Result | Evidence |
|---|---|---|
| Source regression | Passed locally | Capability Graph and orchestrator tests cover read-time freshness, tombstones, later verified revival, delayed snapshots and structural credential removal. |
| Compiled process acceptance | Passed on Windows | `npm run check:capabilities` uses actual compiled graph/orchestrator APIs in isolated child processes before removal, after restart, during successor convergence and after another restart. |
| Hosted CI | Passed | Candidate `f53b2805d8bac6ee2fbc558717770de271493e13` passed all ten jobs in [CI 35516002178](https://github.com/samuelvoltarius/xaventra/actions/runs/35516002178), including compiled capability acceptance on Windows, Linux and macOS. |
| Physical-node / live transport | Not claimed | No physical Mesh partition, provider login, remote model probe or production node was used. |

## Local acceptance

- TypeScript typecheck: passed.
- Build: passed.
- Focused Capability Graph/orchestrator regression: 21/21 passed.
- Compiled capability acceptance: passed, including successor convergence after
  restart, delayed predecessor input, runtime removal and credential exclusion.
- Full Core regression: 228 files / 1,563 tests passed.
- Runtime catalogs are current. Assurance passed after generating the isolated
  development configuration; its only remaining notice is the documented lack
  of an artifact-verified external-agent comparison.
- Staged Gitleaks 8.30.1 scan: zero findings. The complete public history at
  the candidate (98 commits / 10.78 MB) also has zero findings.

## Known limits

- Timestamp ordering assumes a successful runtime observation is within the
  existing freshness/skew window; invalid or excessively future observations
  remain unavailable.
- This change does not prove physical-node failover, live provider auth,
  production Mesh delivery or hardware discovery.
- Native signing/notarization remains dependent on configured external
  identities.
- This evidence attestation requires its own exact green CI before normal
  fast-forward promotion and signed release publication.
