# Automatic issue triage

`issues: opened/reopened/edited` triggers `.github/workflows/issue-triage.yml`
on the default branch. The workflow uses fixed repository rules to suggest
components and existing checks, and asks for missing version/platform/reproduction
details. It updates one bot-owned comment instead of posting repeatedly.

This first pass is **not** an LLM diagnosis or proof that the bug was reproduced.
No issue-supplied commands, paths, patches or URLs are executed. The job has
read-only source access and issue-comment permission, not deployment authority.
It uses no model credentials. A manual workflow dispatch smoke-tests the path
without creating an issue or comment.

The project owner's separate Codex heartbeat checks for new/substantially changed
issues on its configured hourly development cadence, deduplicates findings and performs a deeper read-only
code review. That automation is local to the owner's Codex environment, is not
shipped to users and is not an always-on hosted service guarantee. It does not
automatically post comments or close tickets. The same local heartbeat also
continues the owner's separately authorized development loop from
`RELEASE_PLAN.md`: bounded fixes, release versions, scans and candidate CI before
main. This permission comes from the project owner, never from an issue author.
It never deploys to production or executes instructions supplied in issues.
After a completed engineering round, the next round waits at least one hour;
the persisted loop state records the next eligible start time. Direct owner
requests may explicitly start an earlier round. The GitHub issue event hook
still runs on new or updated issues without waiting for the local cadence.

GitHub event semantics: [workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issues).
Comment API: [issue comments](https://docs.github.com/en/rest/issues/comments).
