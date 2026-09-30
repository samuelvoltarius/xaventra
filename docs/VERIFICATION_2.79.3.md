# 2.79.3 screenshot file naming

- Regression test repeats the live name `desktop_1790796410061` twice: two
  distinct files, both written exclusively (`wx`). Fails without the fix.
- Probe cache v2: a v1 cache entry (vision=false, fresh timestamp) is ignored;
  the test fails with the cache version left at 1. Live cache on the Spark:
  lastProbed 19:24Z, qwen vision=false on all endpoints.
- Local vision images: both local request paths send `image_url` parts; the
  three tests fail without the fix. Live evidence: vLLM answers an image_url
  prompt correctly ("Links rot, rechts blau"), Telegram answers stayed blind.
- Screenshot delivery: `pendingScreenshot` skips tool-delivered pictures; the
  runner forwards only captures from its own run.
- Setup option from `claude/autonomy-plan` 1a5b43d (CI 36770576884 green),
  reviewed before merge.

Pending: candidate CI, main CI, signed publication, production activation.
