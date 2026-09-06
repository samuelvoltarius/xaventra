# Changelog

## [2.78.8] — 2026-09-06

- Reject empty, incomplete, wrong-type and contradictory Doctor reviews instead
  of treating them as clean. Require nonempty code/explanation in fix proposals;
  model output cannot authorize automatic application.
- Catch model initialization failures in diagnosis, review and fix APIs. Keep
  unavailable results explicitly unverified and raw error inputs out of telemetry.
- Reject structured credential requests from generic error diagnosis after a real
  GGUF answered a filesystem error with an invented API-key request. Credential
  entry belongs to validated setup, never model-supplied links.
- Add compiled Doctor API validation to all three hosted OS jobs, using a clearly
  scripted engine. Add a separate 14-case local GGUF quality runner with authored
  synthetic inputs, independent bounded checks and retained negative reports.
- Synchronize Core/Desktop versions. This is not model retraining, model
  qualification, production deployment or RC acceptance. See the
  [verification record](docs/VERIFICATION_2.78.8.md).

## [2.78.7] — 2026-09-06

- Doctor artifacts now use a shared, independently versioned registry with exact
  sizes and pinned SHA-256. Remove the nonexistent hard-coded Core release URL.
- Read configured mirrors and doctorModel/off using native ESM imports. Download
  through HTTPS with validated resume ranges, restart on ignored Range, bounded
  transfer, credential-origin checks and verified atomic replacement.
- Verify GGUF integrity before native loading; retry after initial absence or
  failed initialization. Automatic model selection respects its RAM budget.
- Align diagnosis with the trained fix-plan contract, a real system-message role
  and constrained JSON generation. Independent validation still rejects malformed
  output; model suggestions never authorize PATCH_GATE or claim execution.
- Compiled artifact acceptance in three-OS CI. See [Doctor setup and recovery](docs/DOCTOR_MODELS.md)
  and [verification boundaries](docs/VERIFICATION_2.78.7.md). No retraining or
  production rollout; broad Doctor quality is a separate gate.

## [2.78.6] — 2026-09-06

- Enforce bounded explicit current-turn response constraints in the independent
  validator. A correction repeating the superseded value is not success.
- At most one text-only format repair: no tools, no approval bypass, deadline
  and token limits, retained validation attempts and accounted repair usage.
- Validate message-output hooks before persistence; protect exact replies from
  legacy persona rewrites/verbose footers and check delivery transformations.
- Remove mission execution triggered by model response text. Explicit user
  commands and governed typed mission tools remain available.
- Legacy reflection respects the current-turn kernel during historical recall.
- Preserve non-streaming local OpenAI/Ollama token usage. Missing local pricing,
  streaming and complete multi-round/fallback attribution remain separate work.
- Nine compiled REST/Desktop-API response cases in three-OS CI; isolated worker
  environments, retained failures. [Evidence and limits](docs/VERIFICATION_2.78.6.md).

## [2.78.5] — 2026-09-06

- Daemon and CLI now mutate the canonical state object instead of a stale copy.
  Late readiness, channel and memory initialization become visible to consumers
  such as Telegram's startup gate.
- Preserve an explicitly configured local model/endpoint when opportunistic
  discovery is empty; do not replace a working model with the invented ID
  `unknown`. Keep local selection separate from same-name cloud discoveries.
- Return correlated assistant/tool messages through the native runner and
  daemon LLM adapter; retain tool-call IDs and per-call budgets. An exhausted
  tool loop retains observed evidence instead of returning a blank response.
- Explicit history-only answers cannot repeat external actions. Policy blocks
  stop recovery rather than triggering capability/repair loops, and prevent
  successful validation even after an earlier successful tool.
- Checkpoints retain run references so recall can recover actual historical
  tool receipts from the ledger, scoped to user/channel/room/bot. Failed or
  invalidated evidence is excluded; old receipts never count as a new action.
- Main no longer starts the old ungoverned integration gateway on port 3002.
  Use the authenticated daemon REST API. Dashboard defaults now match Desktop:
  loopback port 3011, honoring `dashboard.host`/`enabled`. A bind conflict fails
  closed without changing ports or silently starting another gateway.
- Serialize Desktop model selection while a save is pending, retaining drafts
  and preventing a late pinned response from overwriting the return to Auto.
- Add six full-daemon packaged Desktop acceptance groups, including real file
  evidence, scoped Trust/Memory, complete process restart and denied reads.
  Scripted cross-platform CI and explicitly selected real-provider Windows
  acceptance are separate gates. [Evidence and limits](docs/VERIFICATION_2.78.5.md).

## [2.78.4] — 2026-09-06

- Resolve Desktop Trust and governed Memory through the same channel-bound
  principal mapping as the actual message pipeline. A user can open their own
  verified run; other users and unscoped runs remain inaccessible.
- Keep the current Desktop message intact. Native room/bot session checkpoints
  already restore history; flattening old turns into the new request broke
  slash commands and treated past instructions as current task intent.
- Add five native packaged Desktop-to-Core acceptance groups on Windows,
  Linux and macOS: actual file execution, linked validator/Outcome details,
  following commands, scoped Memory/Trust and policy-denied file reads.
  The CI model is scripted, not a real-model benchmark or full-daemon proof.
- Label failed required actions as unverified, never as needing no evidence.
  Missing action metadata is unknown rather than an implied no-tool success.

## [2.78.3] — 2026-09-06

- Keep connection setup usable while Core is unreachable or authentication
  fails. Bound bootstrap retries separately from the long-running chat budget;
  stale retries cannot overwrite an opened settings form.
  Missing Main-authority metadata fails closed instead of opening a chat.
- Defer OS keychain access until an actual credential operation; plain startup
  and preference reads cannot block on a keychain prompt. Reject the Linux
  `basic_text` backend for token storage/decryption instead of calling it secure.
- Preserve per-room session drafts and reading positions across model changes,
  specialist selection and navigation. Restore a failed submission for review,
  with no automatic resend. Keep delayed/pending replies in their original room.
  A completed background reply no longer discards unsaved settings edits.
- Stop inferring tool execution from elapsed time or another request's global
  progress message. Show the actual configured Enter-key behavior.
- Replace the development-only, nonisolated Desktop check with ten real
  packaged-client interaction groups and HTTP contract fixtures. Exercise chat,
  failure/recovery, model routes, room state, scrolling and persisted preferences.
- Add Windows/Linux/macOS package-and-interaction CI with retained reports and
  screenshots. Keep real-model, live channel, HA and signed installer gates
  separate. [Verification scope](docs/VERIFICATION_2.78.3.md).

## [2.78.2] — 2026-09-05

- Replace CLI and npm name/port-based process killing with a per-instance,
  authenticated, loopback-only graceful-stop channel. No terminating PID signal
  is sent by the CLI. Actual process exit is required before restart; stale,
  missing or mismatched authority and replacement processes fail closed.
- Keep the control credential local in the ignored runtime data directory.
  Shutdown cleanup cannot remove a replacement process's ownership marker.
- Add `xaventra:stop` / `xaventra:restart`; legacy aliases use the same path.
  Document older-daemon and supervised-service handling explicitly.
- Add real two-process isolation and CLI restart-refusal regressions. Run the
  compiled daemon's boot, authenticated REST status and normal CLI shutdown in
  a disposable runtime in all three OS CI jobs.
- Document the owner's hourly development-loop cadence, separate from the
  immediate GitHub issue hook. [Evidence and limits](docs/VERIFICATION_2.78.2.md).

## [2.78.1] — 2026-09-05

- Fix the workspace working-directory assurance check for canonical path aliases
  such as macOS `/var` and `/private/var`. Existing-directory identity is required;
  different directories, missing paths and regular files remain rejected.
- Print failed assurance check details instead of an opaque boolean assertion.
- Add cross-platform directory-alias regression cases and preserve the first
  candidate's macOS CI failure in the [verification record](docs/VERIFICATION_2.78.1.md).
- Keep Core, Desktop, lockfiles and the software bill of materials synchronized.

## [2.78.0] — 2026-09-05

### Runtime and evidence

- Make native backend completion depend on the independent kernel validator.
- Persist bounded, redacted conversation checkpoints by user, room and bot;
  restore them after restart and reset the matching summary without logging out
  unrelated users. No unscoped legacy transcript is automatically imported.
- Fix plural file requests losing the file tool pack. Enforce task allow-lists,
  deadlines and call budgets before execution, including recovery rounds.
- Retain unpruned evidence in the Outcome Ledger and verify late follow-up tools.
- Add real-model acceptance with fresh processes, file reads, authenticated REST,
  corrected memory and user isolation. Label the older suite as subsystem probes;
  prose is not evidence and failed/empty benchmark suites return a nonzero exit.
- Honor test isolation for background learning. Improve explicit response-format
  adherence without turning model statements into verified facts.

### Installation and operations

- Introduce native PowerShell and POSIX shell installers backed by one Node
  implementation. Preserve configuration, generate a local API token, keep
  channels disabled and offer opt-in browser/native/Desktop dependencies.
- Use `xaventra.config.json` throughout new setup and docs; read existing
  `nova.config.json` only as an in-place fallback.
- Test Core and installer prerequisites on Windows, Linux and macOS in CI.
- Handle malformed REST inputs without unhandled exceptions, bound request
  bodies, default to loopback and require authentication for remote binding.
- Exclude runtime configuration from Mesh bundles; remove a hard-coded legacy
  deployment shortcut. Deployment remains governed by the normal tool path.
- Add a bounded GitHub issue first-pass workflow with fixed code-path suggestions,
  deduplicated bot comments and a write-free smoke mode. Issue text is data,
  never executable instructions. No automatic patch, merge or deployment.

Evidence scope and remaining distribution gates: [verification](docs/VERIFICATION_2.78.0.md).

## [2.77.2] — 2026-09-05

### Security

- Remove implicit owner privileges from OS mode, including lookups of unknown
  identities. Keep authorization at the shared multi-user boundary.
- Record explicit/configured privilege provenance. Revoke legacy owner/admin
  records without a verifiable grant; affected operators must reauthorize
  through their configured Telegram identity, local CLI or authenticated Desktop.
- Bind role checks to the originating channel. A colliding raw user ID from
  another channel cannot inherit an existing privileged identity.
- Enforce tool policy and role checks at the shared execution boundary, including
  recovery and follow-up rounds. Replace model-supplied identity/consent fields
  with trusted context, and preserve that context in local CLI slash commands.
- Add runtime regression tests for OS mode, persisted roles, cross-channel IDs
  and legitimate owner/admin grants, alongside the chat-override regression.

This is the public source preview from a fresh, scanned Git history. No private
deployment data is included and no production node was updated. Desktop binary
packaging and production migration retain their separate verification gates.

## [2.77.1] — 2026-09-05

### Fixed

- Preserve provider API base paths during model discovery; reject external
  catalog paths and redirects, ignore placeholder credentials, and expire
  stale probes. Trusted plugin manifests now reach the Desktop catalog.
- Keep Desktop client identity stable on first launch, clear the old token
  when switching Core endpoints, support IPv6 loopback, and reject explicit
  reads inside private or generated workspace directories.
- Reject incomplete dependency-audit responses instead of reporting zero
  vulnerabilities; detect nested wallet artifacts.
- Correct clean-clone build/setup order, preserve existing settings in the
  setup wizard, start examples without fictitious peers, and repair PM2 setup.
- Seed isolated configuration in CI, exercise Desktop bridge regressions, and
  require explicit operator enablement for website publication.
- Apply compatible Core dependency fixes and update the optional Next.js
  dashboard dependencies; remove its unused PWA plugin, repair source encoding
  and a stale type import, and clearly label its non-authoritative legacy status.
- Replace private Python installation paths with current-user paths and align
  generated PM2 deployment scripts with the CommonJS configuration filename.

This is a private source review candidate. Production nodes are unchanged.

## [Unreleased] — Xaventra public migration

### Added

- Introduced **Xaventra** as the public product identity with a new application
  icon, landing page, public README, contribution guide, security policy and
  explicit brand-migration contract.
- Added `xaventra`, `xaventra-daemon`, `xaventra-boot`, `xaventra-watchdog` and
  `xaventra-acp` command names while retaining the existing `nova*` aliases for
  a bounded compatibility window.

### Changed

- Core and Desktop package identities now use `@xaventra/*`; Desktop packaging,
  window identity and public UI labels use Xaventra.
- Persisted `NOVA_*` variables, `.nova-*` directories, node IDs and lease names
  remain stable until a separately tested data and failover migration exists.

### Security

- Excluded wallet files and credential/archive artifacts from the public source.
  The public repository uses a fresh object database, not the old private Git
  history. Retirement of historical credentials and cleanup of old private
  hosting objects remain private operational work, not part of this export.
- Removed the tracked generated `dashboard/dashboard.tar` archive; public builds
  must create artifacts from source.

## [2.77.0] — 2026-08-29

### Security

- Drei Sicherheitsprüfungen liefen fail-open: umschloss ein `try` die Prüfung
  selbst, ließ das `catch` die Aktion durch. Auf einem Root-System hieß das,
  dass ein Fehler *in* der Kontrolle die Kontrolle aufhob. Alle drei sind
  jetzt fail-closed und melden den Grund:
  - Code Guardian (`complete-registry.ts`) lehnt Codedateien ab, wenn die
    AST-/Sandbox-Prüfung nicht durchlaufen kann, statt ungeprüft zu schreiben.
    Metriken sind davon getrennt und dürfen weiter für sich scheitern.
  - Der Kill-Switch lehnt Shell-Befehle ab, wenn sein Zustand nicht ermittelbar
    ist, statt den Befehl trotz aktivem Not-Aus auszuführen.
  - Die Rechteprüfung im Agenten-Runner überspringt das Werkzeug, wenn die
    Prüfung selbst wirft, statt es auszuführen.
- `execution-preflight` klassifizierte jede nicht-destruktive Aktion gleich:
  `allReadOnly ? 'safe_auto' : 'safe_auto'`. Rein lesende Aktionen werden
  jetzt als `observe` eingestuft, womit die Risikobewertung und die
  Autonomie-Leiter erstmals wirklich unterscheiden.

### Fixed

- Autonomes Lernwissen konnte spurlos verschwinden: Bei unlesbarem JSON gab
  `loadKnowledge()` eine leere Liste zurück, die der nächste Speichervorgang
  festschrieb. Die beschädigte Datei wird jetzt beiseitegelegt, der Vorfall
  protokolliert, und alle Schreibvorgänge in L17 und L7 laufen atomar über
  `atomic-storage`.
- Der Watchdog startete nie: `require.main === module` wirft in einem
  ESM-Paket einen ReferenceError, bevor irgendein `try` greift. Ersetzt durch
  einen `import.meta.url`-Vergleich.
- Das Screenshot-Werkzeug rief `require('node:fs')` in einem Event-Handler
  auf — in ESM ein ReferenceError mitten in der Rückgabe.

### Added

- Fähigkeits-Gedächtnis angeschlossen. `capabilities-store` war vollständig
  toter Code: weder `recordCapability` noch `getCapabilitiesPrompt` wurden je
  aufgerufen, obwohl der Dateikopf „INJECTED into every prompt" versprach.
  Nova zeichnet jetzt nach jedem Werkzeuglauf auf, was gelang, und führt ein
  Negativ-Gedächtnis über das, was auf der jeweiligen Maschine nicht
  funktioniert — mit Grund und Ersatzweg. Beides fließt in den Systemprompt;
  erfolgreiches Nachrüsten gibt einen Eintrag wieder frei.
- Der Umgebungs-Scanner erkennt zusätzlich Browser, Playwright-Browser,
  X-/Wayland-Sitzung und Audioausgabe. Bisher prüfte er nur Interpreter und
  Paketmanager, weshalb Nova sich auf einem headless Server für browser- und
  desktopfähig hielt.
- Der gemessene Systembefund wird im NovaOS-Betrieb in den Systemprompt
  gespeist, statt fest verdrahteter Annahmen über die Umgebung.

### Changed

- Ausführungsbudgets sind im NovaOS-Betrieb (`NOVA_OS_MODE=true`) deutlich
  weiter: der schnelle Denkmodus erlaubte 60 Sekunden und 4 Werkzeugaufrufe,
  woran mehrstufige Systemaufgaben wie „installiere X" mit
  `timeout budget exceeded` scheiterten. Außerhalb von NovaOS bleiben die
  Budgets unverändert, damit Chat-Antworten dort schnell bleiben.
- `run_command` und der Agentenlauf haben im NovaOS-Betrieb längere
  Zeitlimits, damit Paketinstallationen und Kompilierläufe nicht mitten drin
  abgebrochen werden. Über `NOVA_CMD_TIMEOUT_MS` und
  `NOVA_AGENT_TIMEOUT_MS` einstellbar.
- Nova Desktop verwendet das kanonische Nova-Markenbild aus `assets` als
  Fenster- und Paket-Icon auf Windows, Linux und macOS.


## [2.76.1] — 2026-08-29

### Fixed

- Topic-room group chats publish completed bot replies progressively while
  slower bots continue working. A stalled bot now times out independently
  after 30 seconds instead of keeping the entire Desktop composer locked.
- New rooms start with Nova and automatic node routing. Specialist agents and
  manual node affinity are now an explicit per-message advanced choice instead
  of a noisy default that fans ordinary chat out to every configured bot.

## [2.76.0] — 2026-08-29

### Added

- Governed Memory Assets unify reusable Chat Memory, validated Skills, Wiki
  knowledge and CodeGraph context without introducing a second memory write
  authority. Every asset carries owner, version, status, visibility, source
  and bounded content.
- User-, bot- and room-scoped Memory Loadouts equip only active, readable
  assets. The canonical prompt path receives one bounded loadout projection;
  large knowledge remains available on demand instead of being injected into
  every request.
- Nova Desktop can create Memory Assets and equip or remove them directly on
  the current topic room.

### Changed

- Nova Desktop now uses a quieter industrial-ops hierarchy: compact labeled
  navigation, clearer room metadata, stronger Main/model context, focused chat
  composition, denser evidence panels and structured Memory Asset/fact views.
- Chat, settings and the composer remain independently usable at the supported
  1120×720 minimum viewport.

## [2.75.1] — 2026-08-29

### Fixed

- Docker rollouts recover a missing configured image tag from the running
  service's immutable image ID before creating the rollback image. This keeps
  fail-closed rollback protection when an older cleanup removed only the tag.
- Desktop model discovery attributes provider models to the mesh node owning
  their endpoint. Spark vLLM models no longer appear as anonymous `local`
  routes when the Capability Graph already proves the endpoint owner.

## [2.75.0] — 2026-08-29

### Added

- Desktop rooms can bind a user-selected local project folder. Nova receives
  only a client-scoped opaque handle and may use the typed `desktop_workspace`
  tool for bounded list, read and search operations. Absolute paths,
  credentials, `.git`, dependencies, build output and writes remain blocked.
- Every native Desktop reply can now show its canonical Outcome Ledger run,
  model, execution Node, elapsed time, successful/failed tools and verified
  evidence directly below the message.
- Natural requests about the connected project, live models, vLLM, Nodes and
  current Main are classified as live tool tasks; users do not need slash
  commands to force Nova into the Execution Kernel.

### Fixed

- Pinned model selection now stores an exact Node×Runtime×Model route and
  uses an isolated per-run LLM client, preventing concurrent rooms/bots from
  mutating the shared model singleton or silently running on the wrong Node.
- Later route telemetry can no longer erase a previously verified model/Node
  placement in the Outcome Ledger. Local vLLM fallbacks publish their actual
  Node ID, allowing real tool-success samples to train the Outcome Router.
- Governed internal Doctor/Autonomy read-only diagnostics no longer fail a
  second ordinary-user RBAC check after already passing their stricter
  internal read-only contract.
- The model picker hides embedding/voice runtimes, avoids duplicate provider
  rows and distinguishes a successful tool-schema probe from verified
  production tool outcomes.

### Changed

- Nova Desktop now uses a clearer labeled navigation rail, an authoritative
  Main indicator, project context bar, structured empty states, model-route
  details and a live Evidence inspector. Chat and settings remain usable and
  independently scrollable at the supported minimum window size.

## [2.74.1] — 2026-08-26

### Fixed

- Desktop-originated `desktop_screenshot` calls no longer execute on a headless
  Main. The Main sends a typed, expiring capture request to the exact
  authenticated Electron client that initiated the chat and accepts only a
  size-limited JPEG/PNG response with a matching client acknowledgement.
- Captured images are stored under the canonical Nova runtime data root,
  hashed with SHA-256 and returned as real vision evidence. Raw base64 is never
  persisted in the control queue and Desktop captures are never auto-sent over
  Telegram.
- The Codex aggregate authentication index now uses `.nova-data` instead of a
  container user's unwritable home directory, eliminating `ENOENT`/`EPERM`
  capability-publication failures on Docker and Windows nodes.
- The chat pane has an independent bounded scroll area at both the normal and
  minimum supported window size. Long requests show an optimistic user message,
  elapsed time and an honest processing phase instead of appearing frozen.

### Changed

- Desktop settings are grouped into Connection, Main/Fencing, Chat, Layout,
  Security and Actions. Non-secret timeout, Enter-to-send, inspector and density
  preferences persist locally; credentials remain in Electron `safeStorage`.
- Chat messages safely render paragraphs, emphasis, lists, links, quotes and
  code after HTML escaping, replacing raw Markdown markers with a clearer
  operator-focused presentation.
- Added `npm run check:desktop-ui`, an Electron/Playwright regression check for
  shell fit, internal chat scrolling, the six settings groups, minimum-window
  layout and the typed screen-capture bridge.

### Security

- Screen capture is principal- and client-scoped, uses no arbitrary DOM or
  shell payload, enforces MIME signatures and transport limits below the
  Dashboard JSON cap, records only a server-generated path plus hash, and
  retains at most 30 captures for no longer than seven days.

### Verification

- TypeScript, production build, 147 test files / 995 tests, 9 core modules,
  40 service modules, generated catalogs, both dependency audits, all five
  fail-closed assurance checks, Electron UI QA and the Windows unpacked package
  pass. Production receipts are recorded after the signed rollout.

## [2.74.0] — 2026-08-25

### Added

- Nova Desktop: a sandboxed Electron operator client with topic/group rooms,
  selectable native and external bots, model pinning/Outcome Router mode, node
  inventory/enrollment, Trust, governed Memory and Defense workspaces.
- Nova Studio projects existing governed tools into Local Voice, Visual
  Awareness, CAD, 3D Print, Smart Home, Browser and Project modules inspired by
  ADA Local and ADA v2.
- An Ada-SI-inspired Skill Forge shows hash-addressed skill proposals,
  dependencies, evidence and maturity state in the desktop client.
- Explicit adapters connect Hermes and OpenClaw endpoints without making their
  output Nova Tool Evidence or copying their node-local credentials.
- Typed Nova Desktop control supports navigation, room/model selection,
  refresh, focus and notifications with per-client acknowledgements.

### Changed

- `build_skill`, `create_skill`, `create_tool` and `create_runtime_tool` now
  converge on one inert Forge proposal path instead of competing runtime
  registries.
- Telegram skill approval now authorizes sandbox evaluation only. It never
  installs generated code directly.
- Desktop bots enter the canonical Message Pipeline and Execution Kernel while
  preserving the user as the only canonical Memory principal.
- Dashboard/Desktop now follows the canonical `nova-main` lease and also
  requires its own fenced dashboard lease. Bootstrap reports the authoritative
  Main and both epochs so the client projects the Main's complete Mesh graph.
- Vitest runtime isolation now always uses `xaventra.config.example.json` as an
  inert fixture instead of copying or depending on a production config.
- Generated runtime-catalog freshness checks now compare LF and CRLF content
  equivalently, so the same signed source passes on Windows and Linux without
  weakening semantic drift detection.
- Core builds copy Dashboard assets through a fail-closed Node step instead of
  the former Windows-only `xcopy` command whose Linux failure was masked.
- One-shot signed releases accept an explicit, validated Node-ID allowlist and
  an operator-supplied config path; unknown targets fail closed before a lease
  or deployment action.

### Security

- Generated skills require ordered sandbox, benchmark, canary and Owner gates;
  operator approval cannot skip evidence stages. Proposed dependencies are
  never installed automatically.
- Electron enables context isolation, renderer sandboxing, a strict CSP, no
  Node integration and an allowlisted preload bridge. Remote Core/external
  agent endpoints require HTTPS, and secrets remain in the local OS store or
  node-local environment.
- Desktop control accepts no free DOM, Electron or shell payload; commands are
  owner-scoped, typed, expiring and verified only by a matching client ACK.

### Verification

- TypeScript and 147 test files / 992 tests pass. The real-browser Nova Studio
  render check passes without console/page errors, both Core and Desktop npm
  audits report zero vulnerabilities, and the Windows unpacked package passes
  Electron 44 ASAR-integrity generation on NTFS. Full post-version build,
  freshness, catalogs, layers, assurance and production receipts are recorded
  separately below when completed.

## [2.73.0] — 2026-08-25

### Added

- A canonical adaptive cognitive controller selects `fast`, `balanced`, `deep`
  or `research` per request before the first model call. It governs context and
  memory depth, planning breadth, subagent allowance and execution budgets.
- Telegram presentation sessions keep one silent, editable progress message,
  remove it before the final response and render wide Markdown tables as
  mobile-first cards.
- An evidence-backed 2026 agent landscape compares Nova with Hermes Agent,
  Agent Zero, OpenHands, Letta, LangGraph, AutoGen and CrewAI using official
  project sources.

### Changed

- Execution Kernel Task Contracts inherit deterministic timeout and tool-call
  budgets from the cognitive policy unless a caller supplies stricter values.
- The old complexity router is now a compatibility facade over the canonical
  context policy, eliminating a competing heuristic authority.
- Clarification reconstruction recomputes the context and memory policy from
  the complete authoritative request.
- Verbose Telegram output is now a compact Trust footer with actual tools,
  verified evidence, cognitive mode, model, node and duration.

### Security

- Nova no longer prompts providers to print chain-of-thought into ordinary
  message content. Native provider reasoning remains protected diagnostics and
  is never emitted to Telegram.

### Verification

- TypeScript, 143 test files / 977 tests, build freshness, all 49
  runtime/service module loads, generated catalogs, dependency audit and all
  five fail-closed chaos controls pass locally. Production remains on 2.72.3
  until a separately authorized signed Mesh rollout is verified.

## [2.72.3] — 2026-08-16

### Fixed

- The Codex planner contract now fails closed when a model returns prose instead
  of the required structured Nova response. Malformed output triggers the normal
  governed local fallback instead of reaching Telegram.
- User-facing content that identifies itself as Nova's internal planning model
  or describes the private JSON/tool-call contract is rejected as a role leak.
  The planner prompt also explicitly requires natural answers from Nova's
  perspective without exposing internal roles or system instructions.
- Startup model reporting now also trusts an explicit local provider when the
  asynchronous discovery inventory is still empty.

### Verification

- Added regression coverage for the exact leaked planner-identity response
  observed in Telegram and for unstructured Codex output.
- TypeScript, 142 test files / 971 tests, build freshness, all 49 runtime/service
  module loads, the regression benchmark, dependency gate and five fail-closed
  chaos controls pass. Signed release `2.72.3-32873dcdbbd15faa` is verified on
  Spark, NAS, ns1 and ns2; Pi holds the verified files while disabled/inactive.

## [2.72.2] — 2026-08-16

### Fixed

- Session summarization no longer blocks the foreground Telegram/agent response
  path. Foreground memory uses a bounded extractive view while durable LLM
  summarization remains background-only, single-attempt and limited to eight
  seconds plus 512 output tokens.
- Natural identity and active-model questions use deterministic runtime facts.
  Model status now reports the actual User × Node Codex availability instead of
  claiming that Codex is preferred when no authenticated route exists.
- The Telegram model selector displays the active provider/model before an
  explicit switch, and local provider labels correctly cover vLLM and Ollama.
- Startup logging now distinguishes a genuinely local primary model from a
  cloud-primary/local-fallback configuration.

### Verification

- Added regression coverage proving the foreground summary path invokes no LLM
  even when a large cold conversation window needs compression.

## [2.72.1] — 2026-08-16

### Fixed

- Telegram long polling now fails closed after a `409 Conflict`: the adapter
  stops first and retries only after the live `telegram` lease has been
  revalidated. Entmachtete Mesh-Nodes no longer keep stealing and acknowledging
  updates after losing channel authority.
- A second authority check immediately before the bounded, jittered retry closes
  the lease-change race during backoff. Disconnect now cancels pending retries.

### Verification

- Added focused coverage for authoritative retry, stale-node fencing,
  coordinator failure and retry jitter.
- TypeScript, all 141 test files / 967 tests, build freshness, all 49
  core/service layer loads, catalog freshness, the dependency gate and all five
  fail-closed chaos controls pass.
- Signed release `2.72.1-3229e3c25a5af3ab` is verified on Spark, NAS, ns1 and
  ns2. Pi contains the verified artifact but remains disabled and inactive as a
  manual rollback host. Spark is the exclusive Telegram owner; NAS stays
  standby and the post-rotation observation contains no further 409 conflict.

### Security

- Runtime credentials, sessions, generated memory, voice recordings, PID files
  and local state are removed from version control and covered by `.gitignore`.
  Node-local Telegram credentials are never part of Git or release artifacts.

## [2.72.0] — 2026-08-15

### Added

- Scoped, reversible runtime effects now give plugins and lifecycle extensions
  deterministic LIFO cleanup, abort propagation, child scopes, safe unload and
  developer-profile-only hot reload.
- A single guarded tool-execution pipeline owns monotonic preflight policy,
  lifecycle hooks, validation, repair evidence, observers and the immutable
  final model-facing outcome.
- Durable continuable subagents retain stable principals and checkpoints across
  process restarts and can use local or Mesh-backed providers.
- Semantic TypeScript LSP queries, a bounded network-free container code
  runtime and probed native sandbox providers add developer-agent capabilities
  without host eval or silent sandbox fallback.
- Deterministic tool-result pruning limits model context while preserving the
  complete hash-addressed result in Tool Evidence and the Outcome Ledger.
- Source-generated catalogs cover tools, config, modules, persistence paths,
  profiles and capability bundles; release readiness fails on stale catalogs.
- Runtime profiles (`home`, `server`, `nas`, `worker`, `developer`) make channel
  authority, Main eligibility, hardening and developer capabilities explicit.
- An official Agent Client Protocol server provides read-only sessions by
  default. Optional writes require an isolated Git worktree, Nova lifecycle
  approval and the normal evidence path.
- Natural-language Smart Tool Router packs select LSP, sandboxed code execution,
  runtime introspection and resumable workers without slash commands.

### Security

- Native sandbox requests fail closed when Landlock, Bubblewrap or Seatbelt is
  unavailable; Linux Landlock support is optional and platform-scoped.
- Plugin tools cannot shadow built-ins, ACP excludes remote/deployment actions,
  and the dependency tree is pinned to a non-vulnerable NanoID version.

### Verification

- TypeScript typecheck and all 140 test files / 964 tests pass.
- Generated catalog freshness and `npm audit --omit=dev` pass with zero runtime
  vulnerabilities. Production rollout remains a separate operator action.
- The isolated live vLLM smoke passed 10/10 with 100% verified tool execution,
  Resume and Memory precision, zero unnecessary questions, zero false
  completions, 5.178 seconds average duration and USD 0.000098160895 measured
  local cost. Report SHA-256:
  `02FFAA663CB7B847C7827632BF19FF9127BC09E7A8664294815D7D9E512BC6D6`.

## [2.71.0] — 2026-08-06

### Added

- One authoritative lifecycle policy now governs messages, LLM calls, tools,
  approvals, checkpoints and failures. Plugin hooks use the same ordered,
  timeout-bounded, fail-closed policy path and every decision is audited.
- Writable missions receive isolated temporary workspaces, Git worktrees or
  hardened containers. Workspace paths cannot escape their managed root, free
  shell/SSH is blocked inside isolated missions, and promotion requires an
  explicit operator decision.
- MCP now uses the official Model Context Protocol SDK with stdio and
  Streamable HTTP transports, protocol negotiation, tools, resources, prompts,
  list-change notifications, reconnect policy, tool allow/deny rules and
  node-local OAuth providers. MCP tools join Nova's canonical tool registry.
- The operator browser now supports persistent user-scoped sessions, tabs,
  upload/download, human handoff, interactive-element inspection and a
  redacted replay trail.
- External agent evaluation adapters cover Nova CLI, Codex, Claude Code,
  Gemini CLI and OpenHands. Missing agents are reported as unavailable and
  success requires independently hash-verified workspace artifacts.
- Defensive Blue-Team tools add asset inventory, bounded log triage, IOC
  matching, dependency audit, hash-chained incident timelines and proposal-only
  containment planning. Active containment remains Owner/PATCH_GATE-gated.
- Memory retrieval now combines relevance, confidence, lifecycle, freshness
  and diversity. A golden-set evaluator reports Recall@K, Precision@K, MRR and
  cross-user scope leakage.
- Outcome Router exposes validated sample coverage and supports task allowlists
  plus deterministic canary activation; benchmark/model-only claims remain
  excluded from training.
- Nova Trust gained a single operator-control view for workspaces, MCP,
  lifecycle hooks, router training, governed memory and Blue-Team incidents,
  with correction/approval and memory evaluation APIs.
- A release assurance gate runs dependency and deterministic chaos checks and
  fails closed on critical/high runtime advisories, insecure remote MCP,
  unsigned external plugins or broken policy/workspace/evidence controls.

### Security

- Runtime dependency findings were reduced from 67 (5 critical, 18 high) to
  zero by coordinated OTel, Sharp, Telegram and Matrix updates, removal of the
  obsolete vulnerable ARI core dependency, and a safe Protobuf override.
- Dashboard state-changing endpoints retain localhost restriction and now add
  bounded JSON bodies, write-rate limiting and baseline security headers.

### Verification

- TypeScript typecheck and all 130 test files / 953 tests pass.
- Security assurance passes all five chaos controls and `npm audit --omit=dev`
  reports zero vulnerabilities.
- The first artifact-verified external smoke confirmed Codex CLI and Claude
  Code availability. Neither received credit for the Nova-specific Mesh case
  because the required artifact evidence was incomplete; no score was inferred
  from model prose.

## [2.70.4] — 2026-08-06

### Fixed

- Release reports and other metrics such as `Falsche Fertigmeldungen: 0` no
  longer match the correction detector merely because they contain an adjective
  derived from `falsch`.
- Concrete corrections continue through the normal evidence-aware response
  path instead of ending with a generic learning acknowledgement.
- Tool feedback is bound to a two-minute causality window and the same canonical
  principal. A stale execution or another user's tool call cannot be marked
  incorrect by the current message.
- A targeted, backed-up maintenance command removes misattributed correction
  projections without modifying raw message audit records or ToolHealth.

### Verification

- Full release preflight passed all 120 test files / 937 tests, TypeScript,
  build freshness and the benchmark regression gate.
- Signed release `2.70.4-c256147b0616ef32` passed signature, runtime marker,
  fresh heartbeat and receipt verification on Spark, Pi, ns1 and ns2. ns2
  stopped before activation at 11.9 GB free; removing 5.551 GB of unused
  BuildKit cache restored 16 GB and the idempotent retry completed it.
- Maintenance audit
  `.nova-data/maintenance/correction-misattribution-1786014523779.json` records
  the backed-up removal of the false correction and negative ToolLearning
  projection. Raw message records were preserved and ToolHealth was unchanged;
  `self_setup_plan` remains healthy at 34 successes and zero failures.
- The accepted isolated Spark-vLLM report passed 100/100 with 100% Tool
  execution, Resume and Memory precision, zero unnecessary questions, zero
  false completions, 4.082 seconds average duration and USD 0.0009607 measured
  local energy cost. The regression gate passed against 2.70.3. SHA-256:
  `8A907A43EED0A94607647B1D1BE7D831BB22E796DCBD648D4ED61C10D764A3CF`.

## [2.70.3] — 2026-08-06

### Fixed

- A rejected Outcome now creates exactly one quarantined regression case.
  Already invalidated runs are excluded from later "latest run" feedback lookup,
  preventing repeated corrections from being attached to stale evidence.

### Verification

- Full release preflight passed all 119 test files / 932 tests, TypeScript,
  build freshness and the benchmark regression gate.
- Signed release `2.70.3-232df2e76f8e7217` passed signature, runtime marker,
  fresh heartbeat and receipt verification on Spark, Pi, ns1 and ns2. ns2
  stopped before activation at just under 12 GB free; removing 5.551 GB of
  unused BuildKit cache restored 16 GB and the idempotent retry completed it.
- The accepted isolated Spark-vLLM report passed 100/100 with 100% Tool
  execution, Resume and Memory precision, zero unnecessary questions, zero
  false completions, 4.097 seconds average duration and USD 0.0009474 measured
  local energy cost. The regression gate passed against 2.70.2. SHA-256:
  `5A24BD66FF67ED08545E6E4166293410186D9A11E638A0ECF2151F85A644E624`.

## [2.70.2] — 2026-08-06

### Fixed

- Independent user turns no longer inherit stale setup/install tool context from
  older conversation history. Generic goals such as making Nova smarter cannot
  implicitly claim that LLM, embeddings, vision or speech are missing.
- Self-Setup now consumes the canonical live Capability Graph, including vLLM
  runtimes and models, instead of relying only on legacy configured Ollama nodes.
- Self-Setup diagnostics are rendered from exact redacted Tool Evidence. If the
  response validator detects a contradiction, Nova replaces model prose with
  the verified tool result rather than rewriting the unsupported claim.
- Session continuity records successful tool names and compact actual results;
  model-authored response text is never stored as a verified outcome. Diagnostic
  planning tools no longer count as evidence that a requested mutation finished.
- Explicit negative feedback now invalidates the Outcome and retracts its
  workflow, personal-skill, belief, causal and session projections. Workflow
  tombstones propagate through shared memory so rejected learning cannot return
  after Main failover.
- Generic lower-case credential assignments are redacted from evidence output in
  addition to known provider token formats.

### Verification

- All 119 test files / 932 tests, TypeScript typecheck, build freshness, 9 core
  runtime modules, 40 service-layer checks and the voice fallback check pass.
- Signed release `2.70.2-b6dcec8e67f02928` passed signature, runtime marker,
  fresh heartbeat and receipt verification on Spark, Pi, ns1 and ns2. ns2
  initially stopped before activation at 11.9 GB free; removing one unused
  173 MB Tempo image and 5.551 GB of unused BuildKit cache restored 16 GB. The
  retry safely skipped the three already verified nodes and completed ns2.
- The known hallucinated setup run is retained in the immutable Outcome Ledger
  as `run.invalidated`; its session/workflow/skill projections were retracted
  and its shared workflow tombstone was verified on Spark.
- The accepted isolated Spark-vLLM report passed 100/100 with 100% Tool
  execution, Resume and Memory precision, zero unnecessary questions, zero
  false completions, 3.980 seconds average duration and USD 0.0009192 measured
  local energy cost. The regression gate passed against 2.70.1. SHA-256:
  `7D1B5392D90F38FAD46EB3FAEA9928BFC849DE221F83F56C152B7DEE0B93FFD4`.

## [2.70.1] — 2026-08-06

### Fixed

- A negative rating or explicit user correction attached to a real production
  Outcome now creates a redacted, quarantined regression candidate. Benchmark
  and internal fixtures remain excluded.
- Active personal skills are now automatically degraded when their next
  independently validated production run fails, closing the runtime feedback
  loop instead of merely exposing the maturity API.

### Verification

- All 118 test files / 927 tests, TypeScript typecheck, build freshness, 9 core
  runtime modules and 40 service-layer checks pass.
- Signed release `2.70.1-8f424b25debcaad4` passed signature, runtime marker,
  fresh heartbeat and receipt verification on Spark, Pi, ns1 and ns2. ns2
  initially stopped before activation at 8.6 GB free; pruning only 10.98 GB of
  fully unused Docker build cache restored 16 GB and the idempotent retry safely
  skipped the three already verified nodes.
- The accepted isolated Spark-vLLM report passed 100/100 with 100% Tool
  execution, Resume and Memory precision, zero unnecessary questions, zero
  false completions, 4.121 seconds average duration and USD 0.0009534 measured
  local energy cost. SHA-256:
  `84981C84A2E07104692730C97F000F37618F3D9A066D346B7968B90082ED2A80`.

## [2.70.0] — 2026-08-06

### Added

- A persistent, user-scoped Goal Manager models goals, subgoals, dependencies,
  priorities, deadlines, next actions, Outcome evidence and restart-safe mission
  progress. Native missions now project their verified state into this graph.
- A Belief Store records claim provenance, freshness, confidence, expiry and
  counterevidence. The Clarification Gate uses disputed relevant beliefs to ask
  at most one targeted question instead of guessing.
- Execution Kernel preflight now includes deliberation across direct, sandbox
  and approval strategies plus a deterministic autonomy ladder. Irreversible or
  critical actions remain closed behind their existing approval authority.
- Personal skills now mature through `proposed`, `sandbox-tested`,
  `benchmark-passed`, `canary-tested`, `approved` and `active`; a failed active
  run immediately degrades the skill.
- Validator-approved non-benchmark production outcomes train the existing
  Outcome Router, Belief Store, causal memory and personal-skill compiler through
  the single Learning Coordinator boundary.
- A causal/temporal store links requests, real tool outcomes and independent
  validation. The World Model and canonical memory prompt expose only the
  requesting user's governed projections.
- An operational event bus requires trusted deterministic producers or explicit
  evidence before proactive delivery. Generic autonomous prose is fail-closed.
- Doctor findings enter an auditable research pipeline requiring documentation
  evidence, repair proposal, sandbox test, regression test, rollback test and
  explicit PATCH_GATE approval.
- Failed validated production runs are quarantined as redacted regression
  candidates and can become permanent tests only after isolated test evidence;
  resolution requires a passing benchmark reference.

### Fixed

- Dream cycles no longer start unless `autonomy.triggers.dream-cycle` is
  explicitly enabled. Similar wording alone is not a contradiction, and model
  reasoning such as “Here's a thinking process” is rejected from notifications.
- Greeting, follow-up and idle check-ins are opt-in through `socialCheckIns`.
  This prevents the repeated unsolicited Telegram messages seen in production.

### Verification

- All 118 test files / 926 tests, TypeScript typecheck, 9 core runtime modules,
  40 service-layer checks and the voice dependency check pass before release.
- Signed release `2.70.0-0aa49272fa54bd7c` passed signature, runtime marker,
  fresh heartbeat and receipt verification on Spark, Pi, ns1 and ns2.
- The accepted isolated Spark-vLLM report passed 100/100 with 100% Tool
  execution, Resume and Memory precision, zero unnecessary questions, zero
  false completions, 3.988 seconds average duration and USD 0.0009218 local
  energy cost from the measured 29.04 W GPU draw. Its SHA-256 is
  `756992006357034AA20A575F99A956AF5FD652780C9D9CCDF07F9A9ED7BCC50D`.

## [2.69.3] — 2026-08-06

### Fixed

- A Benchmark Lab scenario now requires both independently verified typed
  evidence and an Agent Backend status of `completed`. A failed or unavailable
  LLM can no longer pass merely because the isolated subsystem probe works.

### Verification

- All 117 test files / 916 tests, TypeScript typecheck, build freshness,
  9 core runtime modules, and 40 service-layer load checks pass.
- Signed release `2.69.3-ab4373041678dbdc` passed signature, runtime marker,
  fresh heartbeat, and receipt verification on Spark, Pi, ns1, and ns2.
- The accepted Spark-vLLM report passed 100/100 with 100% Tool execution,
  Resume, and Memory precision, zero unnecessary questions, zero false
  completions, 4.035 seconds average duration, and USD 0.0009323 local energy
  cost from the measured 29.04 W GPU draw.

## [2.69.2] — 2026-08-06

### Fixed

- Benchmark `unnecessaryQuestions` now measures only an explicit backend pause
  for user input. Hidden advisory-planner punctuation is never shown to the
  user and can no longer make an otherwise deterministic release gate flaky.

## [2.69.1] — 2026-08-06

### Fixed

- Every Benchmark Lab scenario now binds its TaskContract to the real isolated
  executing probe. Advisory planner prose can no longer create a false
  completion or a false failure when a German action phrase is classified as
  conversational text.

### Verification

- The first 2.69.0 production run was rejected at 99/100 because `tools-2`
  had 2/2 verified evidence but an empty advisory response, leaving its
  response-only contract failed. This retained report is diagnostic evidence,
  not an accepted release benchmark.
- The corrected 2.69.1 run completed 100/100 with 100% Tool execution, Resume,
  and Memory precision and zero false completions. Its report remains rejected
  diagnostic evidence because the old metric counted two question marks from
  hidden advisory-planner output as user-facing interruptions.

## [2.69.0] — 2026-08-06

### Added

- A user-scoped Clarification Gate resolves requests from existing context
  first, asks one targeted question only when a required reference or target
  is genuinely missing, persists the interruption, and resumes the original
  request from the user's natural-language answer.
- The canonical World Model v2 includes the requesting user's project context,
  goals, decisions, preferences, uncertainties, verified outcomes, workflow
  episodes, and proposed personal skills without exposing another user's data.
- Every Execution Kernel run records a predictive preflight assessment with an
  autonomy profile, risk score, impact, reversibility, prerequisites, and
  required evidence. Self-modification remains sandbox-, regression-, and
  PATCH_GATE-controlled.
- Validator-approved tool runs become compact user-scoped workflow episodes.
  They store only redacted request summaries, tool names, parameter key shapes,
  and Outcome Ledger references; raw arguments and results are excluded.
- Three identical successful workflow shapes with no failure produce a
  reviewable personal-skill proposal. Proposals never install or activate
  themselves.
- Workflow episodes replicate through the existing shared-memory authority and
  hydrate on Main takeover, extending failover continuity without copying
  credentials.
- A permanent benchmark regression gate compares completion, tools, resume,
  memory, latency, cost, unnecessary questions, and false completions.

### Improved

- The Outcome Router now learns per real action type in both native and Agents
  SDK paths. Active recommendations are applied only when the explicit active
  mode and the existing validated-sample gate both allow it; Codex OAuth routes
  are never silently replaced.
- The OpenAI Agents SDK adapter records the actual Nova-routed provider, model,
  node, local-runtime flag, and measured/estimated local cost instead of
  labeling all inference as OpenAI cloud usage.
- Proactive assessments can name affected systems, a recommended action, and an
  explicit evidence expiry while all mutations remain approval-gated.
- The 100-scenario benchmark now verifies workflow-episode grounding and
  user-isolated personal-skill proposals in its Memory category.

## [2.68.1] — 2026-08-05

### Fixed

- Explicit tool-call and tool-replay requests now create a verified-tool
  success contract. An empty model response can no longer turn a correctly
  executed idempotency probe into an ambiguous text-only completion.
- Benchmark advisory output is constrained to one machine-readable readiness
  line. Typed probes and independent validators remain the sole authority for
  task success.

### Verification

- 113 test files and 905 tests pass; typecheck, build freshness, all nine core
  runtime modules, and all 40 service-layer modules pass.
- Signed release `2.68.1-66d05c0cac0b8830` is verified on Spark, Pi, ns1, and
  ns2 by signature/hash, runtime marker, fresh heartbeat, and receipt.
- The post-deployment Spark-vLLM suite passed 100/100 with 100% Tool, Resume,
  and Memory metrics, zero unnecessary questions, and zero false completions.
- Under shared contract `fnv1a-330de3cb`, Nova Native and the OpenAI Agents SDK
  loop both passed 100/100. Nova Native ranked first because the SDK loop asked
  one unnecessary question; neither produced a false completion.

## [2.68.0] — 2026-08-05

### Added

- Natural-language control maps unambiguous diagnostics, mission control,
  signed rollout requests, Doctor proposals, benchmark runs, failover checks,
  memory consolidation, and the live world model to the existing RBAC-aware
  command paths. Slash commands remain optional diagnostic aliases.
- A canonical Nova world model composes Main authority, active nodes, runtimes,
  missions, governed memory, and validated outcomes with provenance,
  verification time, expiry, and confidence instead of asking an LLM to guess.
- Native missions persist a binding TaskContract, pending actions, completed
  idempotency keys, owner fence, and checkpoints. Mission completion now
  requires every planned step to pass its independent Outcome validator.
- HA readiness exposes explicit gates for live authority, exactly-once
  Telegram ownership, standby eligibility, encrypted shared state, fresh
  mission checkpoints, and a sub-120-second RTO target.
- Capability probes and the distributed graph now carry measured tokens per
  second plus validated per-runtime tool success. The Outcome Router consumes
  both signals while retaining its production-sample activation gate.
- Memory governance can consolidate only exact duplicates within the same
  principal scope; semantic conflicts remain reviewable and are never guessed.
- The Benchmark Lab contains 100 non-destructive scenarios and a shared-
  contract comparison runner for Nova and external agents.

### Hardened

- Doctor LLM health checks accept fresh Capability Graph runtime evidence, so
  an empty legacy probe cache cannot falsely declare a total LLM outage.
- Doctor recognizes OpenAI Codex, vLLM, and custom providers and diagnoses HA
  readiness without performing a production mutation.
- Proactive decisions require explicitly verified, fresh evidence. Potential
  actions remain approval-gated and notifications retain dedupe/quiet-hour
  budgets.
- `config_update` captures a durable pre-change snapshot for compensation;
  unknown shell, service, and external actions remain honestly irreversible.

### Verification

- 113 test files and 904 tests passed; typecheck, build freshness, all nine
  core runtime modules, and all 40 service-layer modules passed.
- The first deployed 100-scenario diagnostic scored 99/100 and exposed one
  tool-replay intent classification gap plus two advisory-format violations;
  both were retained as evidence and corrected in 2.68.1.

## [2.67.1] — 2026-07-30

### Fixed

- Natural memory use no longer depends on `/memory` commands. Nova
  deterministically distinguishes recall, durable personal statements, goals,
  rules, ordinary conversation, and explicit forgetting.
- Read-only questions such as "Was weißt du über mich?", "Wie heißt mein
  Hund?", and "Woran arbeite ich?" use the user-scoped governed memory path
  directly without an LLM round-trip.
- Short natural facts can enter Memory Governance even when the rest of the
  message uses the lean context path; ordinary greetings do not trigger fact
  extraction.
- Natural relationship statements such as "Mein Hund heißt Bello" are
  recognized without requiring deep model extraction.
- "Vergiss ..." retracts matching user-owned governed projections and compact
  continuity data. "Vergiss nicht ..." and "Vergiss das nie" remain
  instructions and are never mistaken for deletion.
- `/memory` remains available only as an optional governance and diagnostic
  surface.

### Verification

- 110 test files and 884 tests pass.
- Typecheck and all 40 service-layer checks pass.
- Signed release `2.67.1-7660e39f7477931c` is verified on Spark, Pi, ns1,
  and ns2 by signature/hash, runtime marker, fresh heartbeat, and receipt.
- A deployed Spark runtime probe routes natural recall directly, observes the
  natural relationship fact, leaves "Mach dort weiter" in the continuation
  pipeline, and ignores a greeting for fact extraction.

## [2.67.0] — 2026-07-29

### Improved

- One authoritative memory-context path now combines governed facts with a
  compact, persistent, user-scoped session-continuity record.
- Existing session logs are backfilled once per user into critical
  instructions, project context, open goals, preferences, and verified
  outcomes without persisting raw prompts or credentials.
- Recall is query-aware for identity, preferences, projects, instructions,
  continuity, and broad "what do you know about me" questions.
- Explicit corrections supersede the matching governed fact and remain
  isolated by principal across L7, feedback learning, and L20 self-rules.
- Open goals survive restart and are closed only by verified tool outcomes;
  model prose alone can never create a successful completion memory.
- Verified tool-procedure confidence persists across coordinator restarts, and
  user feedback is linked to the correct recent Outcome Ledger run.
- Session continuity is mirrored through the existing HA memory plane after
  secret redaction and hydrated when a fenced node becomes Main.
- Nova Doctor reports stale candidates, active conflicts, projection drift,
  and session-continuity health without mutating memory automatically.
- `/memory recall <query>` exposes the exact user-scoped governed and
  continuity context that Nova will use.

### Verification

- 110 test files and 878 tests pass, including new restart, user-isolation,
  correction, outcome, and recall regressions.
- Typecheck, production build, build-freshness, and all 40 service-layer checks
  pass.
- Signed release `2.67.0-87b6e99eb4b46a7a` is verified on Spark, Pi, ns1,
  and ns2 by signature/hash, runtime marker, fresh heartbeat, and receipt.
- The isolated Spark-vLLM production benchmark passed 60/60 with 100% Tool
  execution, Resume, and Memory precision, zero unnecessary questions, zero
  false completions, 8.450 seconds average duration, and USD 0.002665 measured
  local energy cost.
- Report: `reports/benchmarks/nova-2.67.0-full-2026-07-29.json`, SHA-256
  `50EB2F3559E90725526C6E140EE721D908F71D28798864816565718D87B32C4E`.

## [2.66.17] — 2026-07-29

### Fixed

- The production trace verifier is emitted into `dist/dev`, and the packaged
  `trace:verify` command runs the compiled artifact. Signed mesh releases now
  contain the same verifier that passes the source-level tests.

### Verification

- Signed release `2.66.17-1ac29d1a9612fbe2` is verified on Spark, Pi, ns1, and
  ns2 by signature/hash, runtime marker, fresh heartbeat, and rollout receipt.
- The packaged CLI reached Tempo on ns2 and correctly reported every missing
  contract stage for an unknown trace ID. A real post-release Telegram tool run
  remains required for the exact end-to-end trace proof.

## [2.66.16] — 2026-07-29

### Improved

- Startup now records phase timings and releases the runtime independently of Telegram HA hydration and optional channel integrations.
- The legacy Capability Orchestrator is a zero-network compatibility projection of the canonical Capability Graph; hardcoded `master`/`pi5`/`jetson` startup probes are removed from the production path.
- Model resolution uses stale-while-revalidate, so a previously verified route is immediately available while mesh discovery refreshes in the background.
- AI discovery performs a lightweight local refresh every five minutes and a full Mesh/SSH inventory every thirty minutes while preserving unexpired remote evidence.
- Concurrent Environment scans are coalesced and reused for five minutes.
- Common read-only questions about Main, nodes, runtimes, Codex, users, status, and updates use RBAC-aware deterministic handlers without an LLM call.
- Capability Graph ingestion canonicalizes service/hostname aliases onto live heartbeat nodes and attaches measured model latency, tool/vision capability, verification time, expiry, free RAM, and free VRAM evidence.
- The production OTel contract now includes a `nova.tool.evidence` span and a Tempo verifier for `channel → LLM → tool → evidence → Outcome`.
- Social check-ins are opt-in. Operational alerts remain evidence-driven through HealthMonitor, reminders, L15, and the governed proactive path instead of creating a second Self-Think LLM notification.

### Verification

- Signed release `2.66.16-0b7fc593b5dd12c6` was verified on all four production
  nodes before the packaging-only 2.66.17 successor.
- Spark reached RuntimeReady in 7.33 seconds versus roughly 23 seconds before
  the change. Telegram transport connected after about 2.7 seconds and no
  longer blocks RuntimeReady.
- The isolated Spark run passed 60/60 scenarios with 100% correct Tool
  execution, Resume, and Memory precision; average duration was 9.195 seconds,
  unnecessary questions and false completions were zero, and measured local
  energy cost was USD 0.003009.
- Report: `reports/benchmarks/nova-2.66.16-full-2026-07-29.json`, SHA-256
  `D8F7E590810ACD005E6E144636F4DE6F1435CA70AE268669346DCD08E1EC71FF`.

## [2.66.15] — 2026-07-29

### Fixed

- LLM call options now support an explicit output-token budget for local OpenAI-compatible and Ollama providers.
- Benchmark advisory planning is capped at 256 output tokens. Typed probes and validators retain their full timeout, while short planning summaries no longer consume the normal 4096-token chat budget.

### Verification

- The complete Linux release gate passed.
- Signed release `2.66.15-8e9fa2ab1b6d2e82` is verified on Spark, Pi, ns1, and ns2.
- The accepted isolated Spark report passed 60/60 scenarios with 100% tool execution, Resume, and Memory precision; average duration is 3.935 seconds, unnecessary questions and false completions are zero, and measured local energy cost is USD 0.000566.
- All seven protected production-state hashes remained byte-identical across the run.
- Report: `reports/benchmarks/nova-2.66.15-full-2026-07-29.json`, SHA-256 `E2D6DCECD7658C52205C2FD24B391FBF0F036C1F3EF35903C9324BE1723091CD`.

## [2.66.14] — 2026-07-29

### Fixed

- Benchmark model calls are planning-only and receive an explicit empty tool set. Real execution remains the isolated, typed subsystem probe, so speculative model calls cannot poison production ToolHealth, L7 examples, auto-repair, or correction history.
- Agent backends can now narrow the immutable worker contract explicitly; an empty tool list no longer falls back to routed registry tools.
- Benchmark planner output has a strict no-question contract and an explicit terminal result line.
- Benchmark error defense no longer records failed approaches or learning outcomes when the channel is `benchmark`.
- Benchmark LLM calls use an async-local performance scope and skip Outcome Router shadow decisions, so scheduled runs cannot train or bias production model routing.

### Verification

- The complete Linux release gate passed and signed release `2.66.14-65385c66e92fd6ca` was verified on Spark, Pi, ns1, and ns2.
- The diagnostic 60-scenario run passed all scenarios but was rejected as final evidence because four planner responses ended in unnecessary questions and speculative model tools had already modified production ToolHealth/L7 state before this release.
- A backed-up, audited maintenance cleanup removed 115 benchmark-only L7 examples, reset 36 affected ToolHealth entries, removed two benchmark-tainted model-performance entries, two LanceDB projections, two Mesh-memory copies, one Core Fact, one Graph edge, and two Graph nodes.

## [2.66.13] — 2026-07-29

### Fixed

- Federated memory replication now has an explicit registry-only mode for isolated validation. Benchmark tombstone and conflict tests cannot publish into or retract from production LanceDB, Core Facts, or Knowledge Graph projections.
- The benchmark memory probe uses that side-effect-free mode for both canonical replication and tombstone propagation.

### Verification

- The complete Linux release gate passed and signed release `2.66.13-c36e1ed1e91cdad3` was verified on Spark, Pi, ns1, and ns2.
- A live post-memory-probe audit confirmed all isolated replica backend references remained empty and production Memory projection counts did not change.

## [2.66.12] — 2026-07-29

### Fixed

- An aborted vLLM request timeout is now classified as transient before crash detection; the word `aborted` can no longer blacklist healthy models for the rest of a benchmark or daemon session.
- Benchmark orchestration uses the final post-probe Outcome Ledger state as authority. A real, verified deterministic subsystem fallback can complete the TaskContract even if the optional LLM planner timed out first.

### Verification

- TypeScript typecheck, 26 focused LLM/benchmark/pricing tests, production build, and build freshness pass.

## [2.66.11] — 2026-07-28

### Fixed

- The production TypeScript build now includes `src/benchmark/**/*`, including `dist/benchmark/benchmark-cli.js`; signed nodes can run smoke and full benchmarks without source files or `tsx`.
- Local vLLM cost accounting automatically samples NVIDIA GPU power through `nvidia-smi` when no operator wattage is configured. The Outcome Ledger now records measured estimated energy cost while cloud cost correctly remains zero.

### Verification

- TypeScript typecheck, 24 focused benchmark/pricing tests, production build, benchmark CLI packaging, and build freshness pass.

## [2.66.10] — 2026-07-28

### Fixed

- Mesh update status is reconstructed from the canonical persisted rollout state after daemon restarts. A completed external rollout now shows its real completion time and `Pending: Nein`; an active controller-owned rollout shows `läuft` and cannot emit a false release-ready notice.
- Telegram owner roles are reconciled from the node's explicit allow-list before RBAC checks, including raw and channel-qualified principal IDs.
- Codex uses the persisted canonical Nova node ID, hides obsolete generated node aliases, and derives a readable vLLM host from the verified endpoint instead of displaying `configured`.
- Telegram strips complete, orphaned, and still-streaming reasoning blocks on every send/edit path. Destructive cleanup commands are suppressed until diagnosis, backup, and approval.
- The 60-scenario Benchmark Lab now executes typed, isolated subsystem probes for every declared evidence contract across discovery, routing, tools, resume, memory, mesh, Doctor, channels, governance, and proactivity.
- Benchmark probes are post-validated through the TaskContract and Outcome Ledger; model prose is never accepted as evidence. Benchmark prompts explicitly forbid unnecessary follow-up questions when safe fixtures are present.
- `form-data` is now a direct dependency because the voice upload path imports it at runtime; Linux release preflight no longer depends on an accidental Windows transitive install.

### Verification

- 103 test files / 847 tests pass.
- TypeScript typecheck, production build, build freshness, and all 49 core/service layer checks pass.

## [2.66.9] — 2026-07-28

### Fixed

- The standalone benchmark runner now initializes Nova's verified LLM inventory before creating its native backend.
- Explicit local models such as `qwen` retain their discovered vLLM endpoint during CLI benchmark runs instead of falling through to the legacy `localhost:11434` Ollama default.
- Injected test backends and already initialized daemon runtimes skip redundant model discovery.

### Verification

- 103 test files / 829 tests pass.
- TypeScript typecheck, production build, build freshness, and all 49 core/service layer checks pass.
- A real Spark-vLLM smoke run reached the verified `qwen` endpoint and completed 9/10 scenarios with zero false completions; only `doctor-1` failed on inconsistent GPU evidence.
- The invalid pre-fix 0/60 report is rejected as runtime-bootstrap evidence and must not be used as a Nova quality score.
- Signed release `2.66.9-4caff7ff262b5802` was verified on Spark, Pi, ns1, and ns2 with four successful receipts.
- The accepted full Spark-vLLM report completed all 60 scenarios: 20% task completion, 95% correct tool execution, 16.7% resume, 33.3% memory precision, 17.44 seconds average duration, six unnecessary questions, zero USD, and zero false completions.

## [2.66.8] — 2026-07-28

### Fixed

- Self-Think, Self-Goal, Self-Doctor, Reminder, Heartbeat, and Mission messages now share one system-authored classifier across the pipeline and Execution Kernel. Internal diagnostics require a real response but no longer invent a missing-tool failure when no tool was needed.
- System-authored automation is hard-limited to Nova's governed read-only tool set.
- L0 health separates managed release/benchmark/Codex artifacts from operational data, uses production-safe disk and memory limits, and notifies only on resource-class transitions.
- Uptime alone no longer recommends a restart. Autonomy deduplicates unchanged findings for six hours and no longer duplicates L0 health alerts.
- Dream reflection rejects chain-of-thought, orphaned think tags, planner prose, and unsafe digest entries. Dream, autonomy, startup, and service-monitor messages now use the fenced proactive channel instead of direct Telegram/Bot API sends.
- Codex Continuity does not repeat a known outage merely because the same vLLM route changes aliases. OpenAI-compatible endpoint spellings with or without `/v1` resolve to the same Capability Graph runtime.

### Verification

- 102 test files / 827 tests pass.
- TypeScript typecheck, production build, build freshness, and all 49 core/service layer checks pass.
- Signed release `2.66.8-f508c817069d5b86` was verified on Spark, Pi, ns1, and ns2 with four successful receipts.
- ns2 initially failed closed at 10.6 GB free. Removing only 10.98 GB of unused Docker build cache restored 20 GB free; the identical-release retry skipped the other three verified nodes and activated ns2.

## [2.66.7] — 2026-07-28

### Fixed

- Full and scheduled Nova benchmarks now run inside an asynchronous, dedicated Outcome Ledger scope.
- Benchmark runs can no longer write fixture events or checkpoints into the daemon-wide production Ledger or mirror them into HA memory, even while real Telegram or Mesh tasks run concurrently.

### Verification

- 99 test files / 820 tests pass.
- TypeScript typecheck, production build, build-freshness checks, and all 49 core/service layer import checks pass.
- Signed release `2.66.7-d7b5513b315f2854` was verified on Spark, Pi, ns1, and ns2 with four successful receipts.
- The full 60-scenario production benchmark remains pending; do not infer it from the passing 10-scenario smoke report.

## [2.66.6] — 2026-07-28

### Fixed

- Main takeover starts the native Mission Recovery watcher exactly once.
- An already reconstructed paused local mission is no longer re-imported from the same durable checkpoint.

### Verification

- 99 test files / 819 tests pass.
- TypeScript typecheck, production build, and build-freshness checks pass.
- Signed release `2.66.6-20509e0711141c18` was verified on Spark, Pi, ns1, and ns2.

## [2.66.5] — 2026-07-28

### Fixed

- A single lease-takeover poller now fans out to every registered control-plane handler. Telegram, native mission recovery, release authority, Outcome hydration, and Codex continuity can no longer suppress each other when they watch the same `nova-main` service.
- Planned strongest-node handover transactionally releases Main-bound channel leases before releasing `nova-main`, removing the extra Telegram TTL delay.

### Verification

- 98 test files / 818 tests pass.
- TypeScript typecheck, production build, build freshness, and 49 layer/runtime import checks pass.
- Signed release `2.66.5-d3e42004523ca434` was verified on Spark, Pi, ns1, and ns2 after the disk guard correctly blocked ns2 below 12 GB and an idempotent retry activated only that node.
- A live hard Spark stop proved that Pi activated Telegram, Mission Recovery, the four-node updater, and Codex Continuity under the same epoch-9 Main takeover; the paused checkpoint was reconstructed with a new dedicated mission epoch 2.

## [2.66.4] — 2026-07-28

### Fixed

- A recovered native mission now acquires a dedicated `mission:<id>` lease before the executor accepts its checkpoint. The mesh-task fence still protects delivery, while the separate mission fence prevents the previous node from continuing the same mission.
- Mission checkpoint IDs are parsed through a bounded typed validator before they may become lease service names.

### Verification

- 98 test files / 816 tests pass.
- TypeScript typecheck, production build, and build-freshness checks pass.
- Signed release `2.66.4-fca6b043c690d1d6` was verified on Spark, Pi, ns1, and ns2 with four successful receipts.

## [2.66.3] — 2026-07-28

### Fixed

- Global autonomy now requires the live fenced `nova-main` token before self-thinking, generating self-goals, or consolidating shared memory. Standby workers remain warm but cannot create duplicate autonomous runs.
- Native mission recovery starts first when a standby becomes Main, before optional Outcome Ledger, release-checkpoint, and Codex hydration.
- Main-control-plane hydration has bounded timeouts, so an optional HA dependency cannot indefinitely block mission recovery.
- Mission recovery logs durable checkpoint discovery, fence waiting, and the accepted owner/epoch.
- Mesh config migration enables the same deterministic strongest-Main policy on every eligible node.

### Verification

- 97 test files / 815 tests pass.
- TypeScript typecheck, production build, build freshness, and 49 layer/runtime import checks pass.
- Signed release `2.66.3-fe1d542192b3ae5f` was verified on Spark, Pi, ns1, and ns2 with four successful receipts.

All notable changes to Nova are documented in this file.

## [2.66.2] — 2026-07-28

### Fixed

- Lease-coordinator outages now use per-service warning backoff and emit one recovery summary instead of duplicating 503 warnings every 15 seconds.
- Windows PID protection verifies the owning process command line, so a reused PID from another application no longer blocks Nova startup.
- L0 health and reminder notifications use the real Telegram adapter contract instead of the nonexistent `sendMessage` wrapper.
- Worker nodes no longer report intentionally disabled Telegram as a Doctor configuration fault.
- Capability Graph localhost probes attach to the canonical node, endpoint aliases on the same runtime port collapse, expired heartbeats become offline, and offline runtimes cannot be routed.

### Operations

- Docker releases require configurable free-disk headroom and automatically retain only the active release plus its direct rollback after verification.
- Spark and infrastructure-worker Compose profiles cap JSON logs; Pi applies journald rate limits; ns2 has a daily compressed Docker-log rotation.
- Direct Mesh peer and signed updater profiles are canonicalized across Spark, Pi, ns1, and ns2 while preserving each config file's existing permissions.
- The official Codex CLI is installed persistently on Spark; OAuth remains a separate User × Node action.

### Verification

- 96 test files / 813 tests pass.
- TypeScript typecheck, production build, build freshness, and 49 layer/runtime import checks pass.
- Signed release `2.66.2-4c553d1040c29e30` was verified on Spark, Pi, ns1, and ns2 by signature/hash, runtime marker, fresh heartbeat, and four successful receipts.

## [2.66.1] — 2026-07-23

### Fixed

- Nova now creates one authoritative Execution Kernel and worker contract per request; older conversation packs can no longer replace the current request's tool selection.
- Worker-tool priority follows the current user instruction before retained conversation context, so `codex_install` remains available under the 24-tool local-model limit.
- Inflected German installation requests such as “Installiere Codex …” are classified as mandatory device actions.
- Explicit Codex installation bypasses weak-model planning and invokes the governed typed installer deterministically; Owner/Admin, explicit-request, local-target, idempotency, evidence, validation, and Outcome Ledger gates still apply.
- Nova Doctor now diagnoses the registry-to-worker contract boundary and safely normalizes provider-mangled names such as `codexinstall` only when the canonical tool is already allowed. Invented tools such as `prompt` are classified as internal contract errors, not missing external capabilities.

### Verification

- 95 test files / 805 tests pass.
- TypeScript typecheck passes.
- Regression coverage reproduces the production mix of old Mesh/Hook context plus the current Codex installation request.
- Signed release `2.66.1-2e8dddef3cd70d10` is verified on Spark, Pi, ns1, and ns2; the live Spark Main is RuntimeReady with Telegram, `qwen`, and the Doctor tool-contract invariant active.

## [2.66.0] — 2026-07-23

### Added

- Owner/Admin users can tell Nova naturally, for example, “Installiere Codex auf Spark”; the smart router selects a dedicated typed `codex_install` tool.
- Nova downloads only the official Linux standalone installer, validates its format and install-directory contract, installs into the persistent Nova data volume, and verifies the resulting binary with `codex --version`.
- Installation requires an explicit install request in the current user message and fails closed when the named target is not the executing local node.

### Security and persistence

- The model cannot supply or transport OAuth credentials. Installation is node-level; `/codex login` remains separately scoped to User × Node.
- Container-node Codex profiles now persist under `.nova-data/codex-auth/<node>/<opaque-principal-hash>` instead of the replaceable container home.
- The managed binary persists under `.nova-data/codex-runtime/bin` and is discovered before global Codex locations after restarts and releases.
- The installation tool remains governed by role filtering, Execution Kernel evidence, Outcome Ledger, validation, and OTel.

### Verification

- The current official installer returned HTTP 200 and matched the documented shell and `CODEX_INSTALL_DIR` contract.
- 94 test files / 798 tests pass, including explicit-intent enforcement, target-node fencing, persistent-path discovery, router selection, and User × Node auth isolation.
- TypeScript typecheck passes.
- Signed release `2.66.0-f682bf85c18c624f` is verified on Spark, Pi, ns1, and ns2; the live Spark Main reports RuntimeReady, Telegram ownership, local `qwen` vLLM, and the deployed `codex_install` runtime.

## [2.65.6] — 2026-07-23

### Fixed

- Codex continuity no longer becomes unusable when its configured vLLM fallback model was unloaded or renamed.
- OpenAI-compatible local runtimes resolve `auto` against the live `/v1/models` response before inference.
- A model-specific 404 triggers one bounded rediscovery and retry with a live chat model; embedding and other non-chat models are excluded.
- Home and Spark now route the Codex fallback through the live `qwen` alias served by Spark vLLM.

### Verification

- The production failure was reproduced as HTTP 404 for the retired `Intel/Qwen3.5-122B-A10B-int4-AutoRound` model while Spark vLLM advertised `qwen` and `sakamakismile/Ornith-1.0-35B-NVFP4`.
- A live completion through `http://100.64.0.10:8000/v1/chat/completions` succeeds with HTTP 200 using `qwen`.
- 93 test files / 792 tests pass, including auto-discovery and stale-model recovery.
- TypeScript typecheck passes.
- Signed release `2.65.6-e778cc016d6f1a6a` is verified on Spark, Pi, ns1, and ns2; Telegram production logs confirm the Codex-to-vLLM route and a successful reply.

## [2.65.5] — 2026-07-19

### Fixed

- Typed update targets can explicitly use OpenSSH legacy SCP when a server intentionally has no SFTP subsystem.
- Release-controller SSH/SCP disables opportunistic host-key rewriting on the read-only key mount while retaining strict pinned-host-key verification.

### Verification

- The 2.65.4 rollout proved fail-closed behavior: Spark and Pi verified successfully, while ns1/ns2 remained untouched when SFTP staging failed before activation.
- Focused updater and Main-eligibility tests pass, including assertions for legacy SCP and strict host-key enforcement.

## [2.65.4] — 2026-07-19

### Added

- ns1 and ns2 can be registered idempotently as mutually authenticated Direct-Mesh peers and typed Docker release targets using only their public Ed25519 identities.
- Infrastructure-worker skills now persist in a dedicated writable volume while the container root filesystem remains read-only.

### Operations

- The Spark release controller can update Spark, Pi, ns1, and ns2 sequentially using its existing dedicated SSH identity and fingerprint-pinned Tailscale host keys.
- ns1 remains a Direct-Mesh-only worker until HA/Supabase secret distribution to the public mail host receives explicit operator approval.

## [2.65.3] — 2026-07-19

### Added

- Infrastructure hosts can run the signed Nova runtime through a resource-limited, read-only Docker worker profile with isolated persistent state.
- Worker capabilities explicitly advertise `worker-only` and `main-ineligible` so routing can use their compute without treating them as failover candidates.

### Security

- `NOVA_MAIN_ELIGIBLE=false` is enforced inside Main lease acquisition, including when distributed leader election is disabled accidentally.
- Preferred takeover selection excludes every node that advertises `main-ineligible`.
- Infrastructure workers disable all channels, Codex OAuth, Telegram, and automatic Main takeover; Direct Mesh listens only on the node's Tailscale address.

### Verification

- TypeScript typecheck and focused leader-election/lifecycle tests pass before the full signed-release preflight.

## [2.65.2] — 2026-07-19

### Fixed

- Signed remote Codex status and completion probes now publish their verified aggregate result through the canonical Capability Graph path on the responding node.
- Direct User × Node verification and distributed capability state therefore converge without exposing principal or credential data.

### Verification

- TypeScript typecheck passes.
- 18 focused Codex, Mesh transport, continuity, and RBAC tests pass; the signed release preflight runs the complete suite before activation.

## [2.65.1] — 2026-07-19

### Fixed

- Codex discovery now actively probes every freshly online signed Mesh candidate, so a restarted authenticated node is rediscovered even when its prior Codex capability observation is stale.
- Node-local Codex capabilities are published under the canonical persistent Mesh node ID instead of a hostname alias.
- `/codex status` and the Telegram model selector now show a principal-specific remote Codex route; `/codex login` explains when the current Main has no local Codex binary and names the active vLLM fallback.

### Verification

- A production 2.65.0 run exposed the stale `home` alias versus canonical `nova-workstation` identity before this fix.
- 93 test files / 785 tests pass, including fresh-node candidate ranking and stale-alias rejection.
- TypeScript typecheck passes.

## [2.65.0] — 2026-07-19

### Added

- A Main-owned Codex Continuity Monitor now verifies the owner's real User × Node OAuth route over the signed mesh every 30 seconds.
- Codex loss produces one governed Telegram transition notice with the affected node, the verified vLLM replacement node/model, and node-local login guidance; recovery is reported once as well.
- Continuity state is stored locally and mirrored into encrypted HA state so a promoted Main does not repeat unchanged outage notices.

### Fixed

- Runtime Codex failures now record and announce the actual fallback node and model instead of only logging a generic provider switch.
- vLLM fallback selection excludes offline nodes even when their runtime probe is still within the freshness window.
- Governed proactive Telegram messages revalidate both `nova-main` and `telegram` fencing authority immediately before queueing and again before the external send.

### Verification

- 93 test files / 784 tests pass, including four isolated Codex continuity transition tests.
- TypeScript typecheck and production build pass.

## [2.64.6] — 2026-07-19

### Fixed

- Resume benchmarks now create and reload a real checkpoint, including pending actions, idempotency state, owner node, and fencing epoch, in an isolated ledger.
- Memory benchmarks now persist and reload a governed user-scoped fact, verify provenance, and prove that a foreign user scope cannot retrieve it.
- Mesh benchmarks now exercise three authenticated local witnesses, deny a concurrent leader, advance the epoch after lease expiry, and issue a new fencing token.
- Non-default Outcome Ledger instances no longer mirror test, benchmark, or repair-sandbox fixtures into production HA memory.
- Benchmark runs are excluded from Outcome Router training and can never unlock active routing.

### Verification

- Real Spark-vLLM smoke benchmark: 10/10 completion, 100% verified tool execution, 100% resume, 100% memory precision, zero unnecessary questions, and zero false completions.
- 92 test files / 780 tests pass.
- TypeScript typecheck and production build pass.

## [2.64.5] — 2026-07-19

### Fixed

- Shared-memory provenance now prefers the canonical deployment `NOVA_NODE_ID`; stale legacy instance files can no longer mislabel Spark or Pi records.

### Verification

- A live Spark diagnostic produced encrypted Outcome Ledger and checkpoint records; the provenance discrepancy was reproduced before this fix.
- Canonical shared-memory node identity has isolated test coverage.

## [2.64.4] — 2026-07-19

### Added

- Outcome Ledger events and resumable checkpoints are mirrored into encrypted HA shared memory and idempotently hydrated before a promoted Main starts mission recovery.
- Dedicated per-node release trust entries allow any explicitly trusted promoted Main to sign a release without copying private node identities.

### Verification

- Mirrored Outcome events/checkpoints have idempotent isolated-store coverage.
- The Spark release signer is provisioned by public-key fingerprint on Spark and Pi; private identity material remains node-local.

## [2.64.3] — 2026-07-19

### Fixed

- Telegram input, replies, replay, reminders, and heartbeat wakeups now require live Main and Telegram lease verification immediately before processing or sending.
- Windows Codex discovery now prefers the installed direct JavaScript entrypoint and probes that binary instead of spawning the `npx` shim.
- The compiled release controller is included in signed artifacts so a promoted Main can authorize subsequent releases.

### Verification

- A production handover moved Main and Telegram from Home to Spark at fencing epoch 2; Pi remained a worker and an epoch-1 Home mutation was rejected.
- Codex discovery reports available, authenticated, configured model `gpt-5.6-sol`, and a successful CLI probe on Home.
- Telegram fencing, Codex process invocation, and leader-election tests pass; TypeScript typecheck passes.

## [2.64.2] — 2026-07-19

### Fixed

- Mesh releases are staged as one persistent tar archive with a verified SHA-256 before extraction, eliminating partial-success SCP transfers of thousands of small files on Pi.
- The signed per-file release manifest remains the activation authority after extraction.

### Verification

- TypeScript typecheck passes.
- Updater, release-verifier, and Outcome Ledger tests pass.

## [2.64.1] — 2026-07-19

### Fixed

- Planned Main handover now reconciles abandoned `running` Outcome Ledger entries after process crashes. Fresh running work still blocks handover; durable approval checkpoints do not.

### Verification

- TypeScript typecheck passes.
- Targeted Outcome Ledger, election, and HA-state tests pass.

## [2.64.0] — 2026-07-19

### Added — Fenced Main and Mission Continuity

- Performance-based planned Main handover to the strongest healthy node, deferred while releases, missions, approvals, or other validated runs are active.
- Transactional `nova_release_service_lease` coordinator RPC with holder/epoch checks; the additive migration is installed on the production Supabase instance.
- Native mission checkpoint recovery retries after promotion, mission-specific leases, stable step idempotency keys, and per-tool mission fencing.
- Interrupted signed rollouts persist a shared release checkpoint and may resume only on the fenced Main with the exact signed local artifact.

### Improved

- Release updater, Telegram takeover, and native mission recovery now follow the same `nova-main` lease instead of process/node mode.
- Proactive system events require impact, confidence, fresh evidence, stable dedupe keys, approval intent, and the existing notification budget.
- GPT-5.4 and GPT-5.4 mini pricing plus the documented GPT-5.4 long-context multiplier are recorded without fuzzy model-name inheritance.
- OTel adds nested tool-execution and Outcome Ledger spans to the existing channel/LLM/mesh telemetry path.
- Benchmark CLI reports per-scenario progress and exits cleanly after the durable report is written.

### Verification

- TypeScript typecheck passes.
- 88 test files / 768 tests pass.
- Real read-only 10-scenario Nova benchmark: 70% completion, 100% tool execution, zero false completions, 12.7s mean duration. Resume, memory, and full mesh evidence remain the measured gaps.
- Prometheus and Tempo contain live Nova channel, execution, LLM, tool, evidence, outcome, Main, and mesh telemetry.

## [2.63.2] — 2026-07-19

### Fixed

- Authenticated Codex is now shown per user as `openai-codex` with its configured model and node in `/models`, the Telegram model selector, and the Capability Graph. The display remains principal-scoped and never globalizes OAuth credentials or identity.
- Mesh update failure alerts are persisted and emitted once per distinct failed release state instead of every five minutes.
- A newer signed version may safely supersede an older failed rollout; retries skip identical releases that are already runtime-verified.
- Staging failures before activation no longer attempt a misleading rollback against an untouched runtime.

### Verification

- TypeScript typecheck passes.
- 88 test files / 763 tests pass.

## [2.63.1] — 2026-07-18

### Fixed

- Codex capability state now remains correctly aggregate across multiple authenticated users on one node. The local index stores only opaque principal hashes and booleans outside Nova Memory; remote routing still verifies the concrete principal transiently before inference.

## [2.63.0] — 2026-07-18

### Added — User × Node Codex OAuth

- Official `codex app-server` integration for ChatGPT device/browser login, status, logout, and Codex-managed token refresh.
- Isolated `CODEX_HOME` per canonical Nova user and physical node; Nova never reads or transports Codex credentials.
- `/codex status`, `/codex login [device|browser]`, and `/codex logout`; login/logout require owner/admin.
- Aggregate Codex capability publication without account identity or credentials.
- Signed principal-specific mesh probes and remote Codex inference routing for Main failover.
- Automatic self-hosted vLLM fallback when Codex is unavailable or unauthenticated.

### Security and governance

- Codex runs in an ephemeral read-only thread with approvals disabled and no direct Nova tools.
- Structured tool plans return to Nova's Execution Kernel, tool policy, Outcome Ledger, validator, and OTel path.
- Legacy PKCE callback, global Codex auth discovery, direct ChatGPT backend transport, and refresh-token copy paths are disabled.
- Startup migration removes historical Nova-owned Codex OAuth copies while preserving Platform API keys.
- Auth commands and one-time device codes are excluded from Nova session logging.

### Verification

- TypeScript typecheck and direct `tsc` build pass.
- 88 test files / 761 tests pass, including isolation, credential migration, RBAC, and signed mesh policy coverage.

---

## [2.59.0] — 2026-05-21

### Fixed — Codebase Gap Audit (Critical + High + Medium)

**🔴 Critical gaps closed:**
- `L6-core-facts` now initialized at daemon startup and injected at the **top** of every system prompt (Tier-0, never truncated by 16k cap)
- Plugin `beforeLLMCall` hook executed before every `runNovaAgent()` call — Brain context search and other plugins now fire correctly
- Typo fixed: `brave_key` → `brave_search_key` in system-status block

**🟠 High-priority gaps closed:**
- `/brain forget --confirm` now implemented: calls `DELETE /reset` on brain_api, falls back to Cypher `MATCH (n) DETACH DELETE n`
- REST API server (`src/server/rest-api.ts`): starts when `server.enabled: true` in config
  - `GET /v1/health` (no auth), `GET /v1/status` (auth), `POST /v1/message` (auth)
  - Bearer token via `NOVA_API_TOKEN` env var; CORS headers included
- Document RAG (`src/core/document-rag.ts`) fully implemented: LanceDB-backed vector chunking, `indexDocument()`, `queryDocuments()`, `getDocumentContext()`, `indexText()`
- GitHub model download auth: `GITHUB_TOKEN` / `xaventra.config.json githubToken` for private repo downloads; cross-host redirect strips auth headers (GitHub → S3)

**🟡 Medium gaps closed:**
- Nova Doctor telemetry: usage logged to `.nova-data/doctor-telemetry/usage.jsonl` (type, fromModel, confidence, durationMs — no secrets)
- Dream Daily Digest: `buildDailyDigest()` now called in the 5-minute heartbeat loop after 20:00, sends via Telegram to first owner in allowFrom
- L04 `refreshOAuthToken` TODO removed — replaced with clear deprecation comment (Codex OAuth deprecated 2025-06, API keys used instead)

### Added
- `src/server/rest-api.ts` — minimal HTTP REST gateway for Nova
- `src/llm/download-models.ts` — GitHub token auth with S3-safe redirect stripping

### Changed
- `docs/ARCHITECTURE.md` — L02/L04/L05 documented as superseded (not deleted); L6-core-facts injection diagram now matches code

---

## [2.58.0] — 2026-05-21

### Added — Nova Doctor (In-Process GGUF) + Memory Distiller

#### Nova Doctor
- **`src/llm/llama-engine.ts`** — `node-llama-cpp` Integration: lädt GGUF-Modelle direkt im Nova-Prozess
  - Hardware-Detection: wählt bestes Modell das in 40 % des System-RAMs passt
  - GPU auto-detected (CUDA → Metal → CPU-Fallback)
  - CPU-Thread-Capping (halbe Kerne) — Nova bleibt responsiv auf schwacher Hardware
  - Kleinerer Context (1024 Tokens) bei RAM < 4 GB
  - `doctorModel` config-Override: `"auto"` | `"off"` | `"1.5b-q4km"` | `"0.5b-q2k"` | …
- **`src/intelligence/doctor-client.ts`** — Typed API für Layer-Nutzung
  - `diagnose(input)` → `DiagnoseResult` mit Fix + autoApply-Flag
  - `reviewCode(code, file?)` → Issues, Suggestions, Security, Severity
  - `generateFix(code, error)` → Fixed Code + Explanation
  - Regelbasierter Fallback wenn kein Modell verfügbar
- **`src/llm/download-models.ts`** — Hardware-adaptiver GGUF-Downloader
  - Lädt vom GitHub Release v2.58.0 (oder eigenem Mirror via `doctorModelMirror` config)
  - Resumable Downloads via HTTP Range Headers
  - `npm run doctor:download` — lädt automatisch das passende Modell
  - `npm run doctor:list` — zeigt verfügbare Modelle + Hardware-Info
- **nova-boot.ts Stage 2D** — Nova Doctor Model Setup beim Boot
  - Genesis-Modus: lädt automatisch
  - Normaler Start: opt-in via `--download-models` Flag
- **`/doctor` Chat-Befehl** — In-Chat Diagnose (`/doctor status`, `/doctor <fehler>`)
- **`nova doctor` CLI** — Terminal-Diagnose (`nova doctor`, `nova doctor "Error XYZ"`)
- **GGUF Modelle** (6 Varianten, alle in GitHub Release v2.58.0):
  - `nova-doctor-1.5b-q5km.gguf` — 1.07 GB (GPU / starke CPU)
  - `nova-doctor-1.5b-q4km.gguf` — 941 MB (Standard CPU, ≥ 4 GB RAM)
  - `nova-doctor-1.5b-q2k.gguf`  — 645 MB (Low-RAM CPU)
  - `nova-doctor-0.5b-q5km.gguf` — 401 MB (schnell / leicht)
  - `nova-doctor-0.5b-q4km.gguf` — 380 MB (kompakt)
  - `nova-doctor-0.5b-q2k.gguf`  — 323 MB (Kartoffel-Modus, jede Hardware)

#### Nova Doctor Training (v3, produktionsreif)
- **Eval 1.5B v3: 10.0/10, 0 Safety Failures** (vorher v2: 9.612, 1 Failure)
  - docker_prune Safety-Bug gefixt: 19 kaputte Trainingsbeispiele korrigiert
  - 12 neue adversariale Safety-Beispiele (docker prune Varianten, rm -rf, DROP TABLE, Secret-Exposure, Prompt-Injection, docker volume/network/image prune)
  - 561 Trainingsbeispiele gesamt (vorher 549)
  - Training: 29.3 Min auf DGX Spark (NVIDIA GB10), Loss 0.2021
- **GGUF Export Pipeline** (`nova-lora/scripts/make_gguf.py`)
  - Fixt bitsandbytes 4-bit Problem: lädt Base als FP16, merged LoRA, konvertiert sauber
  - fp16 → q5_k_m, q4_k_m, q2_k via llama-quantize

#### Memory Distiller
- **`src/layers/memory-distiller.ts`** — Nightly 02:00 AM Wissensextraktion
  - Journal → LLM-Extraktion → `DistilledMemory` (Facts, Decisions, Learnings, OpenQuestions)
  - Schreibt Diary-Markdown nach `.nova-data/memories/diary/YYYY-MM-DD.md`
  - Pusht Episoden an Brain API (silent-fail wenn nicht verfügbar)
  - `/distill [YYYY-MM-DD]` für manuellen Trigger
  - Regelbasierter Fallback ohne LLM
- **daemon.ts**: Memory Distiller in Startup-Sequenz eingebaut (nach Journal-Init)

#### Konfiguration
- **`src/core/config.ts`**: `doctorModel` Feld im Schema (`"auto"` default)
- **`package.json`**: `doctor:download`, `doctor:list` Scripts

### Fixed
- **docker_prune Safety-Bug**: Trainingsbeispiele die `docker system prune` in `safe_fixes` klassifizierten → alle in `risky_fixes` verschoben
- **GGUF Export**: bitsandbytes 4-bit Modelle konnten nicht konvertiert werden → FP16-Base-Load als Fix

### Changed
- Version: 2.57.x → **2.58.0**
- `nova doctor` CLI-Befehl getrennt vom `nova wizard` (vorher Alias)
- `botInfo.version` in `builtin.ts` auf 2.58.0 aktualisiert
- `.gitignore`: `models/*.gguf` ausgeschlossen, `models/.gitkeep` getrackt

---

## [2.56.0] — 2026-05-13

### Added — Complete Tool Coverage & Self-Awareness
- **11 neue Skill-Packs** in `tool-router.ts` — alle bisher nicht erreichbaren Tools sind jetzt keyword-aktivierbar:
  - `self-setup`: `self_setup_*`, `research_*`, `resolve_capability`, `find_capability`
  - `knowledge-graph`: `knowledge_store/recall/list/get/delete`, `kg_remember`
  - `llm-management`: `register_llm_provider`, `list/remove_llm_provider`, `save_api_key`, `save_config`
  - `code-analysis`: `code_search`, `find_files`, `code_outline`, `view_code_item`
  - `search-extended`: `brave_search`, `tavily_search`
  - `reminders`: `set_reminder`, `list_reminders`
  - `monitoring`: `nova_trace_stats`, `nova_restart`, `nova_status`, `tail_log`
  - `patch-management`: `patch_proposals`, `auto_fix`, `import_skill`, `evolution_history/stats`
  - `media-providers`: `list_media_providers`
- **3 neue CORE_TOOLS** (immer verfügbar):
  - `spawn_subagent` / `spawn_subagents_parallel` / `list_subagents` — Delegation ist Core-Mechanismus
  - `kg_search` — read-only Knowledge Graph Suche, safe für Research-Subagents
  - `get_env` — Environment-Info
- **Vollständige Tool-Entscheidungstabelle** in `getToolRouterPrompt()` — alle Kategorien mit WANN-WAS-Logik:
  - Suche: browser_search → brave_search → google_search → web_search (Qualitäts-Hierarchie)
  - Memory: remember (KV) vs kg_search (Graph) vs knowledge_store (strukturiert)
  - Subagenten: spawn_subagent (single) vs spawn_subagents_parallel (multi-parallel)
  - Dateien: read_file vs code_search vs find_files vs code_outline
  - Monitoring: nova_trace_stats vs health_status vs nova_introspect

### Changed
- Version bump: 2.55.0 → 2.56.0
- **Coverage**: 0/142 Tools unerreichbar → alle 142 Tools über CORE oder Skill-Pack aktivierbar

---

## [2.55.0] — 2026-05-13

### Added — Tool Self-Awareness
- **`nova_capabilities(topic?)`** — Nova kann ihr eigenes Tool-Inventar durchsuchen. `nova_capabilities('search')` listet alle Such-Tools mit Beschreibung und Kategorie. Immer in CORE_TOOLS verfügbar.
- **`nova_introspect(type='tools', search?)`** — neuer `tools`-Typ: zeigt alle Tools gruppiert nach Kategorie oder gefiltert nach Suchbegriff. `selfIntrospect()` Signatur um `extra?: string` erweitert.
- **Tool Decision Guide** in `getToolRouterPrompt()` — klare WANN-WAS-Tabelle für überlappende Tools:
  - Web-Suche: `browser_search` → `google_search` → `web_search` (Fallback-Kette)
  - Seiten lesen: `fetch_url` (statisch/schnell) vs `browser_open` (JS-heavy/SPA/eingeloggt)
  - Browser-Interaktion: `browser_click` / `browser_type` benötigt vorher `browser_open`
  - Subagenten: `spawn_subagent` vs `spawn_subagents_parallel` (parallel)
- **`browser_search` + `nova_introspect`** in CORE_TOOLS — immer verfügbar ohne Skill-Pack-Load
- **`browser-automation` Skill-Pack** aktualisiert mit allen neuen browser_use Tools (`browser_open`, `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_get_links`, `browser_status`, `browser_close`)

### Changed
- Version bump: 2.54.0 → 2.55.0

---

## [2.54.0] — 2026-05-13

### Added
- **BrowserUse Tool Layer** (`src/tools/browser-use.ts`): Full Playwright/Chromium browser control for Nova. One persistent headless session with 30-min idle auto-close.
  - **`browser_open(url, wait_for?)`** — launch + navigate, returns title + visible text
  - **`browser_navigate(url)`** — navigate without restarting session
  - **`browser_search(query, count?)`** — DuckDuckGo HTML search (no API key, no bot-detection), returns title + URL + snippet per result
  - **`browser_click(selector)`** — click element by CSS selector or Playwright locator
  - **`browser_type(selector, text, press_enter?)`** — fill input field, optionally submit
  - **`browser_scroll(direction, pixels?)`** — scroll page up / down
  - **`browser_extract(selector?, include_links?)`** — extract visible text + links from real rendered DOM
  - **`browser_screenshot(full_page?, name?)`** — screenshot → `.nova-screenshots/`, path returned (sendable via `send_file`)
  - **`browser_get_links(filter?, limit?)`** — all links from current page with optional filter
  - **`browser_status()`** — session state: running? current URL + title
  - **`browser_close()`** — close session manually
- **`/browser` Telegram command**: `/browser status`, `/browser search <query>`, `/browser close`
- **`browser_search` + `fetch_url`** added to `SAFE_DEFAULT_TOOLS` in subagent orchestrator (read-only, safe for research subagents)
- **`google-search.ts`** already existed with 3-strategy fallback chain (Google Playwright → Startpage fetch → DuckDuckGo Lite), now properly discoverable

### Changed
- Version bump: 2.53.0 → 2.54.0

---

## [2.53.0] — 2026-05-13

### Added
- **Capability Research Layer** (`src/core/capability-researcher.ts`): For every missing capability (stt/tts/llm/embedding/vision/ffmpeg), Nova now spawns a focused subagent with `web_search + read_url` to find the **current best solution** for the exact hardware — not a hardcoded recipe.
  - Hardware-aware prompting: Apple Silicon → Metal, NVIDIA → CUDA, ARM → lightweight, x86 → standard
  - Returns `confidence: 'high' | 'medium' | 'low'` — high = official current source found, low = static fallback
  - 7-day cache in `.nova-data/capability-research.json` (force-refresh via `--force`)
  - Static fallbacks for all capabilities when web search unavailable — Nova never blocks
- **`SetupActionResearch` metadata** on `SetupAction`: every research-backed action now carries `name`, `version`, `hardwareMatch`, `sourceUrl`, `researchedAt`, `confidence`, `alternatives[]`
- **`runSelfSetupResearch()`** — new orchestrator function: loads or runs fresh scan → researches all missing capabilities in parallel → merges enriched actions back into `setup-state.json`
- **`/setup research`** Telegram command — all missing caps, or `/setup research stt` for single
- **Tools: `self_setup_research`**, `research_capability_plan`, `research_all_capabilities`
- **`formatSelfSetupPlan`** now shows research badges (🟢🟡🔴), version, source URL, alternatives for each research-enriched action

### Changed
- `/setup plan` footer indicates how many actions were web-research enriched vs static
- Version bump: 2.52.0 → 2.53.0
- `package.json` description updated to reflect 43-layer architecture

---

## [2.52.0] — 2026-05-13

### Added
- **Self-Setup-Autopilot** (`src/core/self-setup-orchestrator.ts`): Central orchestrator replacing scattered startup checks.
  - On every daemon startup: scans host env, mesh nodes (Ollama probe), voice deps, LLM state, config validation
  - Writes read-only `.nova-data/setup-state.json` — no silent installs
  - Generates typed `SetupAction[]` with `risk: low | medium | high`
  - `computeActions()` produces: voice dep suggestions, config patches, embedding routing, node installs
- **Tools: `self_setup_status`**, `self_setup_plan`**, `self_setup_apply`** — full plan/apply cycle from any channel
- **YOLO mode**: `NOVA_SELF_SETUP_YOLO=1` or `selfSetup.mode = "yolo"` enables auto-apply without per-action confirm
- **`/setup` Telegram command** with `status | plan | research | apply <id|all>` subcommands
- **`/patches` and `/patch` Telegram commands**: full patch-proposal management
  - `/patches` — shows all proposals (queued/applied/rejected) with count split
  - `/patch approve <id>` — runs full `evolve()` pipeline (git branch → tsc → merge → build → restart)
  - `/patch reject <id>` — marks proposal rejected
  - `/patch history` — evolution history + stats
- **`gated auto_provision`** — legacy tool now requires `confirm="AUTO_PROVISION:<capability>"` or YOLO
- **`find_capability`** — no longer installs automatically; redirects to `self_setup_plan`
- **`applySelfSetupAction` bug fixes**: `stdio: 'inherit'` → `stdio: 'pipe'` (daemon has no TTY); `execSync` now wrapped in try/catch returning `{ success: false }` instead of throwing
- **4 tests** for `SelfSetupOrchestrator` in `src/core/self-setup-orchestrator.test.ts`

---

## [2.51.0] — 2026-05-12

### Added
- **L22 Federated Memory** (`src/layers/L22-federated-memory.ts`): Cross-node Knowledge Graph sync via Supabase `nova_shared_memory` table. Nodes share learned facts across the mesh.
- **Self-Evolution with PATCH_GATE** (`src/synthesis/self-evolution.ts`): Nova can propose code changes to herself via `self_evolve` tool. Without `NOVA_PATCH_GATE_TOKEN`, proposals are queued to `.nova-data/patch-proposals.json` only — no autonomous apply.
  - Full pipeline on approval: git branch → search/replace → `tsc --noEmit` → commit → merge → `npm run build` → pm2 restart
  - Full rollback on any failure
  - `getEvolutionHistory()`, `getEvolutionStats()`, `getPatchProposals()` exported
- **Tool: `patch_proposals`** — list and manage queued patch proposals
- **Side-effects guard** (`src/core/side-effects.ts`): `NOVA_SKIP_MODEL_RESOLVER_INIT=1` prevents mesh/SSH/Supabase scans in tests and layer checks
- **Voice improvements**: ffmpeg/ffplay treated as optional with PowerShell fallback; `check:voice` passes without ffmpeg
- **168 tests** (29 test files), all green

### Changed
- `prestart: "npm run build"` added to package.json — `npm start` always rebuilds
- `start:fast: "node dist/daemon.js"` — bypass rebuild when already built

---

## [2.50.0] — 2026-05-11

### Added / Fixed
- **Build freshness guard** in `daemon.ts` startup: scans all `src/**/*.ts` mtimes vs `dist/daemon.js`, warns if >10s stale
- **Stale goal archival** in `SelfGoalEngine`: pending goals older than 3 days auto-archived with `status: 'skipped'`
- **Content filter** on autonomous self-think replies: `isSafeToSend()` blocks kauf/verkauf/bezahl/deploy/login/GOAL_DONE patterns before Telegram send
- **OpenAI JWT guard** in `model-resolver.ts`: `isRealApiKey()` rejects `eyJ`-prefixed OAuth tokens, logs explicit warning, only accepts `sk-` prefixed keys
- **Subagent concurrency cap**: `MAX_CONCURRENT_SUBAGENTS = 6`, atomic `acquireSlot()`/`releaseSlot()` in `finally` block
- **Subagent audit log**: every subagent run appended to `.nova-data/subagent-audit.jsonl`

---

## [2.49.0] — 2026-05-10

### Fixed / Hardened
- **Parallel subagent tool**: `spawn_subagents_parallel` tool added to `complete-registry.ts`; calls `spawnSubagentsParallel()`
- **Mesh fallback**: `runMeshSubagent` falls back to `runLocalSubagent` on non-2xx HTTP response or network errors (ECONNREFUSED, abort, fetch)
- **Hard abort**: `AbortController` propagated from `spawnSubagent` → `runLocalSubagent` → `runNovaAgent` → initial LLM call via `Promise.race()`; loop checks `abortSignal?.aborted` per round
- **`write_file` removed from `SAFE_DEFAULT_TOOLS`**: subagents no longer get write access by default; `kg_search` added instead
- **KG consolidation**: `message-pipeline.ts` exclusively uses `src/memory/knowledge-graph.ts` (not `intelligence/knowledge-graph.ts`); `extractFromConversation` now receives `canonicalUser`
- **Telegram media `await`**: all 4 fire-and-forget voice/document handler callsites fixed — `handleVoiceMessage`, remote fallback, local transcription fallback, `handleDocumentMessage`
- **Leader election bootstrap retry**: after 404/400, waits 1500ms, retries lease check once before falling back to leader=true
- **LLM routing alignment**: `createNovaLLMClient` captures `resolvedApiKey` from `resolved.apiKey`, passes through `providerConfig.apiKey`
- **External provider apiKey forwarding**: `ResolvedModel.apiKey?` → `externalProviderServices[].apiKey` → `getFailoverCandidates()[].apiKey` → `LocalLLMProvider` → `completeAt(apiKey?)` → `Authorization: Bearer ${apiKey}` header

---

## [2.48.0] — 2026-03-30

### Added
- **Trace-based Learning** (`src/learning/trace.ts`, `src/learning/trace-analyzer.ts`): Every agent invocation is now recorded as a structured trace (JSONL, append-only, per-day files in `.nova-data/traces/`). Captures model used, per-tool latency, success/error type, token estimates, self-healing retries. Inspired by OpenJarvis architecture.
- **TraceAnalyzer** — Hourly analysis of last 7 days produces `trace-insights.json` with: slowest tools, most-failing tools, cache candidates, best model per task type, self-healing rate. Starts automatically 2min after daemon boot.
- **Tool: `nova_trace_stats`** — Nova can query her own performance history. Shows latency breakdown, tool health, model comparison, and routing recommendations.
- **Tool: `nova_introspect`** (`src/tools/self-introspect.ts`) — Nova reads her own live state: goals, skills, learned rules, performance metrics, memories, system prompt snapshot.
- **L20 Trace Injection** — L20's `buildPromptBlock()` now includes trace-based performance recommendations in the system prompt, closing the learning loop.

### Performance
- **preloadPipelineModules()** — Now actually called at daemon startup (was dead code). Reduces first-message latency by ~1-2s.
- **Embedding LRU Cache** (`src/core/vector-memory.ts`) — Process-level cache for embeddings (1000 entries, 1h TTL). Eliminates redundant API calls for identical texts.
- **Singleton OpenAI Embedding Client** — Reused across calls instead of `new OpenAI()` per embedding.
- **Response Cache tuned** — `maxEntries: 500 → 2000`, `keyDepth: 3 → 7`, `ttlMs: 1h → 4h`.
- **Memory async save** (`src/core/memory.ts`) — `saveToDisk()` replaced with debounced async `_flushToDisk()`. Only dirty conversations written. 3s debounce prevents blocking the message pipeline.
- **SOUL.md cache** — In-memory cache with 30s TTL. No disk read per message.
- **xaventra.config.json cache** — Cached with 60s TTL.

## [2.47.0] — 2026-02-23

### Added
- **Capability Router** — `src/intelligence/capability-router.ts`: General-purpose dependency resolver. Scores all mesh nodes (RAM, GPU, OS), checks if a tool exists locally or remotely, installs it on the best available node, and routes work accordingly. Replaces the old Whisper-specific auto-install logic.
- **Nova Tool: `resolve_capability`** — `src/tools/capability-tool.ts`: Nova can now autonomously call `resolve_capability(name, task)` when she needs a missing tool. She independently decides: install locally, route to mesh node, or SSH-execute remotely. Supports: whisper, ffmpeg, ollama, yt-dlp, tesseract, imagemagick, pandoc.
- **Dashboard API Security** — `src/dashboard/server.ts`: POST endpoints (`/api/chat`, `/api/sandbox`) now blocked for non-localhost sources, preventing unauthorized message injection.

### Fixed
- **Telegram polling conflict (409)** — Graceful backoff handler added; single polling instance enforced.
- **Voice handler cleanup** — `handleVoiceMessage` in `telegram.ts`: Removed orphaned legacy Whisper install block that caused parse errors. Simplified to use CapabilityRouter for all STT resolution.

---

## [2.46.1] — 2026-02-23

### Fixed
- **Capability Orchestrator** — Now dynamically queries `nova_mesh_nodes` Supabase table instead of using hardcoded IP lists, avoiding SSH checks and `StrictHostKeyCheckin` errors.
- **Node Health Reports** — Directly aggregates node hardware (CPU load, Temp, RAM) from the Supabase registry, skipping slow active SSH polling.
- **Mesh Registry** — Nodes now measure their own `cpu_load`, `temp`, and `ram_used_percent` locally during heartbeats and transmit them to the central Supabase.
- **Dashboard Isolation** — Enforced full dashboard deactivation on background/edge nodes (`NOVA_NODE_ONLY=true` correctly disables dashboard server).
- **Admin Access Re-established** — Checked for nested configuration logic to assign Owner capabilities smoothly.
- **Legacy Admin Recovery Override** — Implemented an override code bypassing standard auth checks to recover locked-out sessions instantly.

---

## [2.44.0] — 2026-02-23

### Added — 8 Repo-Inspired Intelligence Features
- **Soul Evolution** (Automaton-inspired) — SOUL.md evolves through dream cycles and learning. Audit-logged, rate-limited. (`src/intelligence/soul-evolution.ts`)
- **Encrypted Memory** (Mini-Diarium-inspired) — AES-256-GCM encryption for sensitive data. Master key derived from machine-specific password. (`src/security/encrypted-memory.ts`)
- **Wave Pipeline** (nWave-inspired) — 6-phase structured missions with human checkpoints: Discover → Discuss → Design → DevOps → Distill → Deliver. (`src/intelligence/wave-pipeline.ts`)
- **Wake Word** (be-more-agent-inspired) — Voice pipeline for PI5/Jetson edge nodes: OpenWakeWord → Whisper STT → Nova → TTS. (`src/voice/wake-word.ts`)
- **Knowledge Graph** (arscontexta-inspired) — Auto-extracts entities, decisions, tools from conversations. Auto-links related nodes. (`src/intelligence/knowledge-graph.ts`)
- **File Index** (OmniSearch-inspired) — Cross-platform fast file search with in-memory index. (`src/intelligence/file-index.ts`)
- **ROI Dashboard** (ClawWork-inspired) — Cost/value tracking per task with daily ROI calculation. (`src/intelligence/roi-dashboard.ts`)
- New commands: `/wave`, `/roi`, `/cost`, `/graph`, `/scan`
- All commands registered in Telegram Bot suggestions

### Changed
- Help text updated with all new commands
- `/commands` list expanded from ~30 to 50+ commands
- Telegram `setMyCommands` now registers 42 bot commands

---

## [2.43.0] — 2026-02-23

### Added — Progressive Memory & Token Killer
- **Progressive Memory** (Engram-inspired) — 3-layer recall, topic-key upserts, dedup prevention, soft-delete. Wired into system prompt. (`src/intelligence/progressive-memory.ts`)
- **Token Killer** (RTK-inspired) — Tool output compression (60-90% savings). Smart rules for git, ls, npm. Wired into `nova-runner.ts`. (`src/intelligence/token-killer.ts`)
- `/users` command added to help and Telegram suggestions

### Fixed
- All missing commands added to `/help` text
- `/commands` list synced with actual commands

---

## [2.42.0] — 2026-02-23

### Added — Multi-User Middleware (Spacebot-inspired)
- **Auth Enforcement** — `checkAuth()` on every message
- **Tool Restrictions** — `isToolAllowed()` blocks dangerous tools for guests/users
- **Per-User Memory** — `getUserContextString()` injects user-specific context
- **Group Chat** — `trackGroupMessage()` + `isGroupChat()` for multi-user chats
- **Message Coalescing** — 2.5s batching window for rapid messages
- **User Onboarding** — Welcome message for new users
- `/users` slash command (list, promote, block, unblock, info)
- Multi-user context injected into system prompt (user, group, permissions)
- `globalThis.__novaState` for cross-module state sharing

### Changed
- `nova-runner.ts` — Tool restriction check before every execution
- `slash-commands.ts` — `/users` command registered

---

## [2.41.0] — 2026-02-22

### Added — Multi-Agent Team System
- **Captain+Specialist Pattern** — Grok-style team coordination
- **5 Specialist Roles** — Researcher, Coder, Analyst, Creative, Security
- **5 Team Presets** — Default, Creative, Security, Research, Fullstack
- **Sub-Agent Spawning** — `/subagent <role> "query"` for single specialists
- `/bot team` command with preset selection
- `/agents` for agent status overview
- Parallel execution with result aggregation

---

## [2.40.0] — 2026-02-21

### Added
- Autonomous Executor with structured mission pipeline
- Pre-Flight Check system for nodes
- Dashboard improvements

---

## [2.39.0] — 2026-02-20

### Added
- Smart Tool Router — context-aware tool filtering (112 → ~22)
- Session compaction with L6 summaries
- Proactive Learning prompts

---

## [2.38.0] — 2026-02-19

### Added
- Subconscious Dreaming — idle period analysis and reflection
- Red-Team self-hardening module
- Instinct system from user corrections

---

## [2.37.0] — 2026-02-18

### Added
- Prompt Optimizer with [LOCKED] section guards
- Self-improvement layer
- Node health monitoring

---

## [2.36.0] — 2026-02-17

### Added
- Full wiring of all intelligence layers
- Skills Loader for dynamic capability loading
- Bot Factory for template-based bot creation
