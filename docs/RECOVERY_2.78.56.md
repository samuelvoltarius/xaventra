# URL clarification and replicated memory recovery

A URL retry containing one dated GET example now resolves its reference before
the model call. This is not permission to execute pasted shell, and policy,
target evidence, multiple-target ambiguity and destructive-action checks remain.

Memory projection retraction is local bookkeeping, not a new content version.
Previously each terminal snapshot import advanced updatedAt, making peers
exchange it again and append full records with ever-growing provenance.
The fix preserves the authoritative version/timestamp during projection cleanup.
Regression covers repeated exchange, process restart, tombstones and audit bytes.

Existing audit files and provenance are not deleted or rewritten. This change
stops the reproduced amplification among corrected peers, not all audit growth.
Older mutually replicating peers can still amplify records; operators must
inventory versions and update participating nodes through approved procedures.
Keep disk headroom and verified independent backups. Do not remove the audit:
it is used to recover a damaged primary store. Rotation/archival requires a
separate recovery-compatible design. A rollback to the previous code can revive
the replication problem and must be monitored accordingly.

Source/process tests are not live Telegram acceptance or a complete RC claim.
