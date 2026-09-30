# 2.79.1 clarification and provenance fix

Patch release on top of the deployed 2.79.0.

- Clarification gate: pending questions expire after 30 minutes; small talk and
  greetings do not resume a pending action. Regression tests reproduce the live
  30.09.2026 case (26-hour-old screenshot question, "Wie geht's dir ?"); with the
  previous gate 11 of 42 gate tests fail.
- Governance provenance bounded to 32 entries (origin + newest). Regression tests
  reproduce the NAS record with 1566 entries; all three fail without the fix.
- Replication excludes operational notes and expired records; terminal
  operational notes are pruned after 24 hours on the replication cadence.
  Live Spark store: 1010 of 1012 records were such notes. Both tests fail
  without the fix.

Local Core regression: 472 files / 3,190 tests pass (one skipped). An earlier run had one
wall-clock budget test (`next-level.test.ts`, 252 ms vs 250 ms) missed under
full parallel load and passes 3/3 alone. Typecheck passes.

Pending: candidate CI, main CI, signed publication, isolated CLI acceptance on
Spark with the real model, production activation.
