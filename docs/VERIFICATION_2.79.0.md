# 2.79.0 review-fix and fencing candidate

Breaking release. It closes the findings of two complete code reviews, adds
lease fencing and wires the read-only Nachtwache into the autonomy loop.
Mesh protocol and configuration change: all nodes must move together, and
existing configurations need peer `publicKey`/`roles`, numeric `allowFrom`,
trusted-node lists and a shared continuity signing key before start.

Fencing ships in `observe` mode. Migration `sql/mesh-coordination-v5.sql` is
applied separately, only after every node runs this release. `enforce` follows
only after drills in `observe`.

Local Core regression passes 469 files / 3,164 tests (one skipped) with Git
long paths enabled for the Windows path-length limit; typecheck and catalog
check pass. These are local, pre-commit results.

Pending: candidate CI, evidence commit CI, main CI and signed publication.
No full RC claim. Production activation, fencing migration and `enforce` are
separate steps. Recovery must preserve the prior native program, runtime and
channel credentials; never start a second Telegram consumer.
