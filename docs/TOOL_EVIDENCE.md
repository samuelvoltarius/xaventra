# Correlated tool evidence

Xaventra does not treat a successful tool name as proof that the current request
was fulfilled. The Execution Kernel records a receipt for each verified execution:

- unique call ID;
- executed tool name;
- SHA-256 of canonical arguments;
- SHA-256 of the structured result;
- explicit current-request targets matched by the execution arguments.

The completion validator accepts only unique receipts for tools admitted by the
binding TaskContract. When a file request contains machine-comparable paths/file
names, or a web request contains an explicit URL, every target must be covered. For example, reading
`a.txt` does not complete “read `a.txt` and `b.txt`”. Discovery, an unrelated
health check, duplicate IDs and successful but uncorrelated results do not close
the task.

Only explicit syntactic targets are inferred. Xaventra does not pretend that a
vague phrase such as “the server” is equivalent to a particular host. Typed host,
service, message-recipient and other domain target contracts remain future work.
Hashes bind evidence for audit; they are not signatures and do not independently
prove a remote node identity. Mesh evidence still requires its signed transport,
lease and fencing checks.

Provider tool-call IDs are retained in model-facing follow-up messages. Direct
native paths create their own unique execution receipt. The OpenAI Agents backend
also enters the Kernel budget gate before effects and uses its idempotency key as
the local execution receipt. This follows the same general separation described
by the official OpenAI Agents SDK between tool call/result items and resumable
run state, without making that SDK Xaventra's authority:
https://openai.github.io/openai-agents-js/guides/results/

The design also follows the durable-execution rule that nondeterministic tool I/O
belongs in recorded activities rather than inferred workflow state:
https://docs.temporal.io/ and
https://github.com/temporalio/documentation/blob/main/docs/ai/index.mdx

## Verification

```sh
npm ci
npm run build
node scripts/check-tool-budget.mjs
node scripts/check-tool-budget.mjs --live http://YOUR-LOCAL-MODEL:8000 MODEL_ID
```

The scripted suite uses the compiled native runner, real disposable files, policy,
Outcome Ledger and independent validator. Its partial-two-file case deliberately
returns a successful first read and a final model answer without reading the second
file; the task must fail validation. The live variant proves normal one- and
two-file operation with an explicitly selected local model. Neither test is a
production Telegram, Desktop, Mesh failover or distributed-resume proof.

Rollback selects the previous verified artifact. There is no state migration.
Older persisted contracts without `requiredToolTargets` remain readable; their
legacy evidence path is not silently reinterpreted.
