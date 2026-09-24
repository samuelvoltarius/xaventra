# 2.78.55: conversation, target evidence and diagnostic continuity

This release distinguishes clear operational announcements from execution
requests, binds Markdown URL destinations correctly, and admits eligible failed
Kernel validation into the existing persistent read-only Doctor workflow.
See CONVERSATION_INTENT.md, URL_TARGET_BINDING.md and VALIDATOR_SELF_DIAGNOSIS.md.

Local source regression: 243 files / 1739 tests passed. Typecheck, build,
generated catalogs and diff checks passed. Desktop tests passed 12/12 after
using a writable test TEMP directory. The initial wrong Desktop test path and
subsequent default-TEMP EPERM failures are retained as verification limitations,
not hidden by changing tests.

An actual model answered three isolated conversation cases with no attempted
tool effects. The operational announcement received an acknowledgement, not a
target clarification. This checks routing, not factual correctness of every
generated instruction. A real loopback HTTP fixture observed one matching GET
and rejected wrong evidence targets. Doctor restart/authority tests use controlled
receipts; they do not prove production repair or live hardware recovery.

Exact-commit candidate, evidence, main and signed publisher results must be
recorded before promotion/activation. Production installation and Telegram
acceptance are separate from all source tests. No RC-ready claim is made.
