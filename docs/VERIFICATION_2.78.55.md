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

Runtime candidate `4a07d43ef026590f127bdadab7bad32d34f8470b` passed all ten
jobs in [CI 36073603718](https://github.com/samuelvoltarius/xaventra/actions/runs/36073603718),
including real isolated repair/rollback and managed activation. Downloaded
exact-revision reports confirm Doctor API 15/15 and artifact checks 5/5 on
Windows, Linux and macOS. Packaged Desktop reports on each OS pass 10/10
interaction and 5/5 Core integration checks. These are controlled tests, not
production repair proof. The full 144-commit history and staged patch passed
Gitleaks with zero findings.

This evidence-only commit requires its own green CI before normal main
fast-forward. Exact main CI and signed publisher verification remain mandatory
before activation. Production installation and Telegram acceptance are separate
from all source tests. No RC-ready claim is made.
