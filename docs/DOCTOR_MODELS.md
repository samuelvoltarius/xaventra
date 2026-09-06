# Doctor models: installation, integrity and recovery

Doctor uses local GGUF inference through node-llama-cpp, separate from the chat
provider. A chat benchmark does not establish Doctor diagnosis quality. A Core
upgrade or branding change does not by itself require weight retraining.

## Trusted artifact source

Configure a trusted HTTPS mirror in your private `xaventra.config.json`:

```json
{
  "doctorModel": "auto",
  "doctorModelMirror": "https://your-model-host.example/models"
}
```

`XAVENTRA_DOCTOR_MODEL_MIRROR` overrides the mirror for a single environment.
Legacy `nova.config.json` is read in place when the preferred file is absent.
No runtime configuration is published. There is no implicit private GitHub token
requirement. The removed `v2.58.0` release URL was not an available public release.
Without an approved default/mirror, installation explicitly fails with guidance.
HTTP is allowed only for loopback fixtures; HTTPS downgrade and URL credentials
are rejected. GitHub authorization is sent only to the exact HTTPS GitHub origin,
and removed across origins. Mirror URLs are not logged.

From a source checkout (Node 22+):

```sh
npm run doctor:list
npm run doctor:download
npm run doctor:download -- --model 0.5b-q5km
```

For a built/package installation: `xaventra doctor --download`, or
`node dist/llm/download-models.js --model 0.5b-q5km`. Commands work on Windows,
macOS and Linux. Download failure sets a nonzero exit code. `doctorModel: "off"`
prevents download and loading. Automatic selection reserves 40% of total RAM as
the model budget; no fitting model means no automatic load. An explicit variant
is an operator override and never silently falls back to a different variant.

The stable legacy filenames identify the six pinned artifacts, not the application
brand. Their checksums are compiled into the package; `models/SHA256SUMS` is checked
against them in regression tests. GGUF files themselves are not in Git or npm.
Model redistribution/provenance, base-model licenses and training-data privacy
must be checked before adding a new public source or artifact version.

## Manual import and custom models

Place the exact pinned GGUF in the runtime working directory's `models/` folder.
The runtime verifies its full hash before native parsing. Inventory means only
presence and exact size; status separately identifies verified/loaded state.
Custom filenames remain supported with explicit `doctorModel`,
`doctorModelSha256` (64 hex characters) and `doctorModelSizeBytes` pins. No path
traversal or unpinned custom GGUF is accepted. Treat these pins as operator trust
decisions, never as values supplied by model output or untrusted issue text.

## Resume and recovery

Downloads use `.gguf.download` files and an exclusive `.gguf.lock`. A valid 206
must describe the exact remaining pinned range. A 200 restarts from byte zero.
Both exact size and SHA-256/GGUF checks must pass before same-directory rename;
the old file is not deleted first. Failed partials remain available for diagnosis
or resume. Corrupt complete partials are redownloaded. Transfers have a 30-minute
overall limit and a 30-second idle limit.

After a hard process/host crash, first confirm no downloader owns the artifact,
then remove only that artifact's stale `.lock` and retry. Never delete a live
download lock. Keep the original failure report. After model installation or
repair, a previously unavailable Doctor can retry in the same process. Restart
an already loaded Doctor to adopt replacement weights; do not replace its files
while native inference is active.

Diagnosis generates a typed fix plan with `requires_confirmation: true`.
`safe_fixes` is a model's proposed category, not permission to execute. The API
always returns `autoApply: false`; sandbox, regression, rollback and PATCH_GATE
remain independent. Invalid output falls back with `fromModel: false`, never a
claimed model success. An unavailable code review reports warning, not clean.
Generic error diagnosis also rejects configuration/wizard proposals without
independent typed evidence that those keys/steps exist. This is not a general
semantic correctness proof: suggestions and confidence still need validation.
Structured `ask_secret` proposals are rejected by generic error diagnosis: it
has no trusted credential-request channel or verified setup requirement. Use a
validated setup flow for credentials, never a model-provided link. This narrow
typed check is not a general detector for misleading natural-language advice.

Review and code-fix responses also require complete, correctly typed JSON.
An empty object, contradictory clean review or empty code proposal is rejected.
Model initialization failure produces an unverified fallback/warning or no fix,
not an uncaught success path. Accepted reviews still carry `verified: false`;
proposed code always carries `safe: false`. Neither replaces independent tests.
Telemetry records operation, timing and validation status, not raw error text.
`schema_validated` means only the output contract passed, not semantic correctness.

## Verification and upgrades

Run `npm run build`, `npm run check:doctor` and the Core suite. Hosted fixtures
exercise transport/configuration, not native inference. An optional local check
can use `node scripts/check-doctor-artifacts.mjs --mirror <trusted HTTPS base>
--model <exact filename> --inference`. It writes only to a unique temporary root,
downloads and verifies the real GGUF, and performs a synthetic diagnosis with
no tool execution. It retains failed reports and raw synthetic output locally.
Do not publish raw model output without review. This is a bounded smoke check,
not a full safety/repair benchmark or proof that retraining is unnecessary.

After building, `npm run check:doctor-validation` exercises the actual compiled
Doctor API with a scripted engine in an isolated module graph. Its experimental
VM flag belongs only to that test harness, not normal application startup. CI
runs it on Windows, Linux and macOS without downloading models.

For separate native model-quality evaluation, provide an existing pinned file:

```sh
npm run benchmark:doctor -- --model-file /absolute/path/nova-doctor-0.5b-q5km.gguf
```

On Windows use an absolute Windows path instead. The runner verifies the source
hash, copies it to a unique temporary root and generates 14 synthetic diagnoses
with no tool execution, training or download. A case passes only when the schema,
runtime parser and independent bounded oracle all pass. Reports retain those
three outcomes separately, model/hash, source revision/dirty status and budget;
an unverified fallback is not counted as a model success. Nonzero exit on a failed
case is intentional. Never publish raw output/configuration without review.
These authored pattern checks are not a full semantic judge, held-out training
certification or autonomous repair benchmark. Current negative model results
remain an open gate; see [2.78.8 evidence](VERIFICATION_2.78.8.md).

Back up private configuration and known-good artifacts before upgrading. A bad
new artifact must not displace an existing verified one. Source rollback uses the
previous tested commit and its synchronized Core/Desktop package files; do not
roll back to an unchecked downloader to bypass integrity failures. Native
installers, signatures and actual platform upgrade/rollback are separate RC gates.
