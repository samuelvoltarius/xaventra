# 2.78.7 — Doctor artifact delivery and runtime contract

This is a bounded source change, **not RC acceptance**. It does not deploy any
production service, publish weights, retrain a model or prove autonomous repair.

## Reproductions and implemented boundaries

- The previous downloader referenced a nonexistent Core release. A configured
  artifact mirror now works in native compiled ESM; no guessed release tag.
- The initial compiled negative reproduced `doctorModel: "off"` being ignored
  even with an exact-size installed filename. Keep that failed report.
- Local HTTP fixtures cover verified fresh download, 200 restart, 206 resume,
  relative redirects, corrupt/truncated/oversized responses, timeout, locking,
  exact-origin credentials, CLI failure and preservation of the previous file.
- SHA-256 pins match `models/SHA256SUMS`. Engine-native parsing is invoked only
  after integrity checks. Stubbed-native tests prove retry after initial absence,
  rejected corrupt bytes, disable/dispose and inference-error context cleanup.
- The trained fix-plan response format is independently validated and adapted
  to the existing diagnosis API. Real system-message placement and bounded
  grammar generation support it. Model output never grants repair approval.
- Uncorroborated configuration/wizard proposals are rejected. Unavailable
  diagnosis/review is explicitly unverified, not clean or successful.

## Evidence classification

Source regression, local fixture transport, compiled ESM and actual GGUF
inference are separate checks. Three-OS CI runs the compiled fixture script:

```sh
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run check:doctor
npm run test:desktop
```

The fixture check writes an exact source revision, version, platform and case
results into a unique QA root. Reports are retained even on failure; hosted CI
does not receive private mirrors, models or credentials and claims no inference.
Exact candidate CI and final revision must be verified before main promotion.

Local candidate source regression passed **178 files / 1166 tests**, seven
Desktop bridge tests, build/typecheck, catalogs and the assurance gate. The
compiled artifact script passed five fixture cases on Windows. Hosted Linux and
macOS evidence is pending the candidate's exact-commit CI at this checkpoint.

Separate Windows local checks downloaded actual pinned GGUF bytes through HTTPS
from an operator mirror and loaded them using the native GPU backend. This proves
artifact delivery/loading only. The 0.5B model produced an invented replacement
port/provider change in a synthetic refused-connection case. A first structural
smoke judge was too weak to catch this; its report is retained and superseded by
the stricter semantic check. The failure is not a passing diagnosis benchmark.
An earlier malformed response and native grammar-generation failure are also
retained; neither counts as a successful model outcome.

The 1.5B comparison also failed semantic inspection: it confused connection
refusal with a port already in use. This concrete contradiction is now rejected
independently and returns the explicit unverified rule fallback. The smoke judge
was strengthened to detect both failures. Neither model has a passing quality
claim from this round; the older structural-only reports are retained, not erased.

## Open gates

- Broad Doctor quality and repair safety, including all shipped quantizations,
  clean-system negative controls, known/unknown causes and adversarial evidence.
  Existing agent/chat scores do not close this gate. Fixing downloads does not
  establish whether targeted retraining is necessary.
- Public artifact-source approval, provenance/base-license and training-data
  privacy review before any new redistribution. No implicit upload of weights.
- Native binding availability, installer signatures/notarization and actual
  install/update/rollback on all platforms remain separate RC requirements.
- Distributed HA, channel handover and the rest of the release inventory remain
  open; this patch is not an RC label or a complete product-quality assertion.

See [setup, custom pins and recovery](DOCTOR_MODELS.md). Keep known-good artifacts
and private configuration backups; do not bypass an integrity failure by using
an unchecked older downloader.
