# 2.84.0 one window, fewer questions, honest learning

- Integration branch `claude/release-2.84.0` on top of 2.83.0 (8835a62).
  Desktop redesign 635cd03 merged first. Packages, each with green CI on the
  exact head before merge: A doctor/cases b4d8d29 (36954021579), B memory
  a566485 (36954412472), C forge/router/scout 0ca1ea0 (36955241272), D live log
  6bf7c34 (36953223324), E software scout a4f27ac (36973784914). Source: owner
  requests 01./02.10.2026, private list VERBESSERUNGEN_2.84.0.md.
- Integration fixes from the owner's morning report 02.10. (red tests first,
  counter-checked against the old code): responsibilities start without an
  activation card while every L2 step keeps its own card
  (responsibilities.test.ts, missions/trust-ladder/delegation tests), Nachtwache
  host `local` named by node id, a held-back question listed once in the report
  (briefing.test.ts), scout title names only the target node; learning-flow
  uses the one `ownerKernelRun`. Integration CI 36972472881 green (e9dcfbb).
- Full suite on the integration commit: all files green except the local
  worktree-only `repair-publication` case.

Pending: candidate CI, main CI, signed publication, rollout to five nodes,
Desktop API token on the Spark, live check: `/memory` shows a local embedder
(not `hash:v1`), no activation cards for responsibilities, Desktop UI served
by the Main.
