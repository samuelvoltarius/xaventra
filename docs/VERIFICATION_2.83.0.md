# 2.83.0 closed learning loops

- Integration branch `claude/release-2.83.0` on top of 2.82.0 (cac9e4d).
  Packages, each with green CI on the exact head before merge: A cases
  c099875 (36947689171), B learning 6daaafa (36947167071), C proposals
  efba394 (36947704403), D curve 9f727c6 (36947416749), E runtime 09188c1
  (36949574478). Source of the ten points: owner request 02.10.2026
  ("extrem wichtig"), private list VERBESSERUNGEN_2.83.0.md.
- Integration fixes with red tests first: the combined bug-finder source
  passes measured successes through (combine-sources-successes.test.ts —
  without it no case would ever close); accepted/declined suggestions reach
  the evening learning curve (suggestion-summary.test.ts).
- Full suite on the integration commit: all files green except the local
  worktree-only `repair-publication` case.

Pending: candidate CI, main CI, signed publication, rollout to five nodes
(the lab VM joins the trusted-node list), live check on the Spark: learning
runtime online, no RAM warning from the vLLM reservation, Werkzeug-Schmiede
can build.
