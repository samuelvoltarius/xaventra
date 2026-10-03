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

Pending: exact candidate CI, main CI, signed publication and
independent activation checks. Scripted/local tests do not prove live model,
Telegram, operating-system installation or multi-node acceptance.
