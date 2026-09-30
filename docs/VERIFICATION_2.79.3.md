# 2.79.3 screenshot file naming

- Regression test repeats the live name `desktop_1790796410061` twice: two
  distinct files, both written exclusively (`wx`). Fails without the fix.
- Probe cache v2: a v1 cache entry (vision=false, fresh timestamp) is ignored;
  the test fails with the cache version left at 1. Live cache on the Spark:
  lastProbed 19:24Z, qwen vision=false on all endpoints.

Pending: candidate CI, main CI, signed publication, production activation.
