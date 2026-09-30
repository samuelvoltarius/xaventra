# 2.79.2 vision probe, workstation desktop, v5 grants

- Capability probe: regression test models a reasoning model (answer only
  after ~60 thinking tokens); vision, code and reasoning are detected with the
  fix and missed without it (2 of 3 tests fail). Live evidence: Spark vLLM
  answers an image prompt with content=null at max_tokens 15 (finish_reason
  length) and correctly with a larger budget.
- Workstation desktop: session plan chooses XFCE only when both xfce4-session
  and dbus-run-session exist; otherwise the previous minimal desktop.
- v5 grants: dynamic grant block verified in a rolled-back transaction on the
  live coordinator.

Pending: candidate CI, main CI, signed publication, production activation.
