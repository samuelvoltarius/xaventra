# Update completion recovery

The shared update activation controller persists lock ownership bound to the
exact signed ticket. After a successful install or verified rollback, replay
can finish interrupted completion and remove only that attempt's lock. It does
not repeat activation. Unknown legacy ownership and another attempt's ownership
remain fail-closed; do not remove such locks automatically.

Regression: `src/core/update-activation.test.ts`. Isolated acceptance:
`node --import tsx scripts/check-update-completion-resume.mjs`.
The latter terminates a real child process during completion, then starts two
fresh processes to verify reconciliation and replay, with exactly one durable
fixture activation. The retained temporary directory contains the evidence.
This is process/filesystem fixture evidence, not systemd, Docker, production
fencing, signed publication, or native updater enrollment acceptance.
