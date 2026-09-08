# 2.78.16 Docker repair evidence

This is bounded feature acceptance, not production activation or RC approval.
Core and Desktop versions are synchronized. Negative reports remain retained.

## Clean continuous local-model run

Source: `e9722f4493226e0780c7d0299f0f24db31ce9dca`, `sourceDirty: false`,
Linux arm64, real local Qwen, completed 2026-09-08T17:31:29.608Z. This used a
disposable HTTP application and synthetic fault, not production Xaventra data.

| Evidence | Result |
| --- | --- |
| Native Doctor investigation using current HTTP tool result | 1/1 |
| Native candidate with real source/test reads and isolated four-phase sandbox | 1/1 |
| Owner gate denies missing approval | 1/1 |
| Signed external Docker activation; independent original operation; case resolution | 1/1 |
| Duplicate approval refused and baseline source unchanged | 1/1 |
| Actual wrong-candidate rollback restores original operation | 1/1 |
| Separate real volume snapshot and negative controls | 4/4 |

Investigation: `doctor-research-a83dc470-9045-4e2f-8f15-afc4f615968c`.
Candidate: `doctor-candidate-b509c962-ab1e-404c-8b7a-9e1b69d71be7`.
Proposal: `patch_06a1c9d5-9417-4575-92d1-17997d620f90`.
Activation: `repair-b5e87d2e-08a4-48d5-b793-894f7114e47f`.
Original assertion expected a newly randomized value; the model was not given a
hard-coded replacement. The trusted fixture publisher prepared the image from
the sandbox-verified patch. This is not a generic production image builder.

That checkpoint used fixture authority in the activation driver. The subsequent
acceptance script connects the actual separate signed HTTP grant/lease service
and adds a seventh grant-denial/acceptance check. Its lease and operator grants
are still fixtures, not live Mesh authority. Final CI artifacts distinguish this
explicitly; do not retrospectively relabel the earlier six-check run.

## Source/platform verification

At the clean checkpoint above: Windows Core 205 files / 1403 tests, Desktop
7 tests, build/typecheck/catalog checks and public-history secret scan passed.
[Candidate CI](https://github.com/samuelvoltarius/xaventra/actions/runs/34257358111)
is retained regardless of later results. Three subsequent short-lifetime authority
tests ensure signed decisions cannot outlive grants, tickets or drain evidence.
All ten jobs for the final candidate must be green before normal main promotion.

The CI Docker job uses a **scripted model** with real native execution, Docker,
sandbox and HTTP probes. Windows/macOS evidence covers their jobs, not a claim
that Linux Docker state migration was tested on those hosts. Reports include
source SHA, dirty state, case results and evidence class.

## Open production prerequisites

- Protected administrative installation and four distinct signing identities.
- Prepared signed release artifacts and matching source-mirror advancement.
- Genuine deployment-specific in-flight-task drain and external-writer fencing.
- Controlled adoption of existing containers and isolated rollback data.
- The original production symptom reproduced and independently verified after activation.

No production daemon, container, configuration, user data, credentials or lease
was changed by these tests. The helper's fixture quiescence is not distributed
consistency proof. No generic database migration/API compensation, arbitrary
repair capability, full fleet acceptance or RC completion is claimed.

Earlier failed runs exposed missing Doctor source-read evidence, Docker image
alias handling and Engine false/null inspect normalization. Their reports are
kept alongside successful runs, not deleted or downgraded into passes.
