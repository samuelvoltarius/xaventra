# 2.85.0 integrated source candidate

Base: `08f7d0a`, all nine 2.85 integration packages, plus six review corrections.
Core and Desktop versions are synchronized. This is not a production receipt.

## Review regression evidence

- Before correction, three focused regressions failed: routine cycles counted
  as completed work, measured disappearance labelled repaired, and opaque
  success-rate reporting. Those failures were not waived.
- Whole-request introspection tests cover the compound model/why question and
  same-session model-name follow-up, with unrelated-context counterexamples.
- Model metadata tests bind the exact configured alias and endpoint, reject
  ambiguous entries and private paths, and preserve uncertainty on failure.
- Responsibility reconciliation retires stale proposal visibility without
  changing activation policy or reviving rejected responsibilities.

## Local checks (2026-10-03)

- Core suite and final repeat: 680 files passed, 4,658 tests passed, 2 skipped
  on each run (final run: 189.12 seconds).
- Typecheck, compiled build/freshness and generated catalog consistency pass.
- Desktop: 23 tests passed.
- Assurance passes using an isolated, empty-MCP test configuration, not a copy
  of production settings. Initial missing-configuration failure is retained;
  external agent-comparison evidence remains a warning. Runtime dependency
  audit reports zero advisories.
- Gitleaks 8.30.1 scanned 617 public-repository commits with zero findings.
- Staged candidate secret scan and `git diff --check` pass.

## Desktop build-chain remediation

- Initial candidate CI `37100573324` failed all three Desktop dependency audits;
  its three Desktop smoke jobs and repair jobs passed. The failed gate was not
  waived. No production runtime exploit was established.
- User-approved build-only migration pins `electron-builder 27.0.0-alpha.9`.
  The locked graph contains no `got`, `cacheable-request` or
  `http-cache-semantics` copies; Desktop audit reports zero vulnerabilities.
- Three focused download contracts pass: fresh download and headers, checksum
  rejection including cached-artifact revalidation, cache reuse, cancellation,
  and HTTP/network retry classification. Existing 23 Desktop tests pass.
- Local Windows unpacked, NSIS and portable builds pass. These are unsigned
  compatibility builds, not signing or end-user installation acceptance.
- CI additionally builds configured platform installers without publishing.

Pending: exact updated candidate CI, main CI, signed publication and
independent activation checks. Scripted/local tests do not prove live model,
Telegram, operating-system installation or multi-node acceptance.
