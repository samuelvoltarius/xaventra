# Local model recovery

From 2.78.52, a valid tool-call-only response counts as usable inference.
It is not proof that the tool executed; normal Kernel policy and validation
still apply. Successful inference clears the model's automatic hold but keeps
its historical statistics for routing scores.

Healthy candidates are preferred. If every eligible candidate is held, one
actual request per model per minute may use a 15-second recovery deadline.
The admission timestamp is written before network I/O and survives restart.
Duplicate mesh routes for one model share that budget. Subsequent rounds
rotate routes. No new model, endpoint, credential or tool authority is created.
An unavailable or unwritable admission store fails closed. Known permanent
exclusions remain excluded. The store assumes the existing single-daemon
ownership of its runtime directory; this is not a distributed recovery lease.

Session failure holds are endpoint-specific and expire after one minute.
An expired performance cooldown is not itself evidence of model health.
Do not delete the performance file to recover availability: that also destroys
failure evidence. Inspect the current endpoint and model, then use the signed
update controller to install a release containing this change. Rollback uses
the existing controller backup; optional admission metadata is backward-compatible.

Reproduce with `node scripts/check-local-model-recovery.mjs` after building.
It runs real HTTP and fresh processes against a scripted provider in isolated
runtime directories. A live-model and Telegram check are separate evidence.
