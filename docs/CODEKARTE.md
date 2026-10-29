# Codekarte — der Fahrplan durch Xaventras Code

Stand: 2.89.15 (`origin/main` 352b302), erhoben am 29.10.2026.

Die Karte ist der Einstieg für jede Änderung. Sie zeigt je Bereich **den einen
richtigen Weg**, die wichtigsten Dateien, die Tests und was man nicht mehr
benutzt. Der Abschnitt [Doppelungen](#doppelungen) listet Stellen, an denen zwei
oder mehr Wege dasselbe tun. Dort soll man zusammenführen statt einen weiteren
Weg zu bauen.

Regeln:

- **Vor einer Änderung** den betroffenen Bereich und die Doppelungen lesen.
- **Im selben Commit** die Karte nachziehen (siehe
  [So bleibt die Karte aktuell](#so-bleibt-die-karte-aktuell)).
- Zeilennummern gelten für den genannten Stand und wandern mit der Zeit. Der
  Funktionsname ist der Anker, die Zeile ist der Startpunkt für die Suche.
- `docs/ARCHITECTURE.md` beschreibt die Idee. Sein Verzeichnisbaum ist veraltet
  (nennt z. B. `src/mesh/mesh-hub.ts` und `mesh-client.ts`, die es nicht mehr
  gibt). Bei Widerspruch gilt diese Karte.
- Erzeugte Kataloge (`npm run catalogs:generate`): `docs/generated/tools.json`
  (alle Werkzeuge), `modules.json` (Importgraph), `persistence.json` (wer
  schreibt wohin unter `.nova-data`).

---

## Bereiche

### 1. Eingänge und Kanäle

**Zweck:** Nachrichten aus Telegram, WhatsApp, Discord, Dashboard, REST, Desktop
und Mesh annehmen und in die eine Pipeline geben.

**Der eine Weg:** `src/daemon.ts:135` `handleMessage` (gebaut von
`createDaemonMessageEntry` in `src/core/daemon-message-entry.ts`) →
`src/core/message-pipeline.ts:459` `handleMessage`. Start: `src/daemon.ts:162`
`startDaemon`. Kanäle startet nur `src/core/channel-gateway.ts` `ChannelGateway`
(telegram, whatsapp, discord, dashboard) über die Starter in
`src/core/daemon-channels.ts`.

| Datei | Rolle |
|---|---|
| `src/channels/telegram.ts`, `whatsapp.ts`, `discord.ts` | echte Kanal-Adapter |
| `src/channels/telegram-presentation.ts` | Statuskarte, Fehlschlag-Erkennung |
| `src/server/rest-api.ts:128` `startRestApi` | REST `/v1/message`, `/v1/status`, Bearer `NOVA_API_TOKEN` |
| `src/desktop/desktop-api.ts:312` `registerDesktopApi` | Desktop/Hub-Eingang (`/api/desktop`) |
| `src/mesh/mesh-transport-runtime.ts` | Mesh-Eingang `mesh-direct` → gleiche Pipeline |
| `src/gateway.ts:514` `startGateway` | eigener Wächterprozess, kein Kanal |
| `src/cli.ts` `main`, `src/cli/` | CLI-Befehle (Setup, Wizard, Terminal-Chat) |

**Tests:** `src/core/daemon-message-entry.test.ts`, `daemon-channels.test.ts`,
`src/channels/telegram-*.test.ts`, `src/server/rest-api.test.ts`,
`src/gateway-auth-guard.test.ts`, `src/cli-r2.test.ts`, `src/daemon-r2*.test.ts`.

**Nicht benutzen / veraltet:**
- `src/telegram/`, `src/discord/`, `src/slack/`, `src/whatsapp/`, `src/web/` sind
  **keine** Kanäle, nur Konto-/Ziel-Helfer für `src/channels/dock.ts` und
  `src/channels/plugins/`.
- `src/channel-web.ts` ist ein Leerlauf-Stub (WhatsApp-Web-Shims).
- `src/channels/slack.ts`, `matrix.ts`, `signal.ts`, `voip.ts`: Adapter ohne
  Starter im `ChannelGateway`; `createChannel` (`src/channels/index.ts:61`) hat
  keinen Aufrufer.
- `src/index.ts` (`BrutusRuntime`, `src/core/runtime.ts`) ist die alte
  Laufzeit; Einstieg ist `dist/daemon.js`.
- `src/integration/` (`nova-integration.ts`) ist eine Brücke für alte
  Nova-Module, wird noch bei `daemon.ts` aufgerufen.
- Der Integrations-Listener auf Port 3002 bleibt aus (`docs/DESKTOP.md`).

### 2. Nachrichten-Pipeline

**Zweck:** ein Durchlauf je Nachricht: Abbruch/Frist, Principal, Auth, Rollen,
Sofortwege, Slash-Befehle, Prompt-Aufbau, Agentenlauf, Antwort-Prüfungen.

**Der eine Weg:** `src/core/message-pipeline.ts:459` `handleMessage` →
`handleMessageInScope`. Grobe Abschnitte (Stand 2.89.15):

| Zeilen | Stufe |
|---|---|
| ~468–640 | Abbruch/Frist, Principal, frühe Abfänge (Login-Rücksprung, Schlüssel im Chat, Telefon-Passwort) |
| ~638–770 | `checkAuth` (fail-closed), Rollen-Werkzeugsperren, Gruppen, Onboarding |
| ~930 | Slash-Befehle → `src/core/slash-commands.ts:229` `handleCommand` |
| ~971–1410 | deterministische Sofortwege, Rückfrage-Gate (`~1192`) |
| ~1412–2000 | Systemprompt: Zeit, Selbstwissen, Owner-Profil (`~1574`), Gedächtnis (`~1840`), Persona, Korrekturen |
| ~2230 | Agentenlauf `runNovaAgent` (Bereich 3), danach Wiederholungen ~2297–2435 |
| ~2550–2700 | Ergebnisprüfung und Formulierung (siehe Doppelung D3) |

**Wichtige Dateien:** `message-pipeline.ts`, `slash-commands.ts`
(`COMMAND_MENU`, `getCommandMinimumRole`), `src/core/context-policy.ts` (eine
Entscheidung fast/balanced/deep/research), `src/core/prompt-budget.ts`,
`src/core/soul.ts`, `src/core/clarification-gate.ts`.

**Tests:** `src/core/message-pipeline-*.test.ts`,
`slash-commands-rbac.test.ts`, `slash-commands-role-gate.test.ts`,
`src/e2e/*.test.ts`.

**Veraltet:** `/mission` ist Alias von `/auftrag`. `src/core/complexity-router.ts`
ist nur noch Fassade von `context-policy.ts` ohne Importeur.

**Kontext je Aufgabe (2.90.0):** der eine Einhängepunkt vor der
Prompt-Kappung ist `src/core/turn-context.ts` `prepareTurnPrompt` (Aufruf in
`message-pipeline.ts` direkt vor `applySystemPromptBudget`, Messzeile `record`
im `finally` nach dem Agentenlauf). Dahinter:
`src/core/task-prompt.ts` (Prompt-Blöcke je Thema der Werkzeug-Route; lädt den
Router erst im abgesicherten Schritt), `src/core/lagebild.ts` (gemessenes
Selbstbild, `/lage`, Block `## LAGEBILD` geschützt), `src/core/context-metrics.ts`
(`.nova-data/context-metrics.jsonl`, `/kontext`; die echte Modelleingabe misst
`nova-runner.ts` als `contextStats`) und `src/core/context-switches.ts`
(Schalter `context.metrics|taskPrompt|lagebild`, Umgebung `XAVENTRA_*` gewinnt;
dort auch `featureEnabled` für die standardmäßig eingeschalteten Fähigkeiten
`k8sTestPods` und `meshDesktopInput`).
Neue Prompt-Blöcke bekommen ihr Thema über die Überschrift
(`task-prompt.ts` `TOPIC_RULES`); ohne Thema bleiben sie immer drin.

### 3. Runner und Agenten

**Zweck:** die eine Agentenschleife (Modell ↔ Werkzeuge) samt Unteragenten.

**Der eine Weg:** `src/agents/nova-runner.ts:244` `runNovaAgent`; innen
`src/agents/governed-sdk-loop.ts:18` `runGovernedSdkLoop`. Unteragenten (lokal
und auf anderem Knoten): `src/agents/subagent-orchestrator.ts:382`
`spawnSubagent` (Werkzeug `spawn_subagent`, mit `mesh_node` auf anderen Knoten).

**Aufrufer von `runNovaAgent`:** Pipeline, Subagent-Orchestrator,
`src/agents/nova-native-backend.ts`, `src/acp/acp-server.ts`,
`src/doctor/research-worker.ts`, `src/benchmark/agent-acceptance-worker.ts`.

**Wichtige Dateien:** `nova-runner.ts`, `governed-sdk-loop.ts`,
`subagent-orchestrator.ts`, `continuable-subagents.ts`,
`src/agents/tool-authorization.ts`, `src/core/task-contract.ts`,
`src/core/outcome-ledger.ts:225` `completeValidated` (Erfolgs-Hoheit),
`src/core/tool-failure-escalation.ts`, `src/core/delegation.ts` (Übergabe an
externe Agenten claude/codex/hermes — nicht Mesh).

**Tests:** `src/agents/nova-runner-*.test.ts`, `governed-sdk-loop.test.ts`,
`subagent-orchestrator.test.ts`, `subagent-mesh-transport.test.ts`,
`src/tools/subagent-tools-identity.test.ts`.

**Nicht benutzen:** `src/agents/openai-agents-backend.ts` (zweite SDK-Schleife,
nur über `createAgentBackend` aus dem Benchmark erreichbar);
`src/layers/L8-sub-agent.ts` (`RUNTIME_STATUS = 'compatibility-only'`);
`mesh_delegate` für neue Arbeit (siehe D1).

### 4. Werkzeuge und Router

**Zweck:** Werkzeuge registrieren, je Anfrage die passenden anbieten, ausführen.

**Der eine Weg:** Registrierung `src/tools/complete-registry.ts`
(`NovaToolRegistry`, `getToolRegistry` ~3601, `ALL_TOOLS`). Auswahl je Anfrage
`src/tools/tool-router.ts:613` `getRelevantTools` (einziger Aufrufer
`src/core/intent-dispatcher.ts`). Nachladen im Lauf `src/core/tool-admission.ts`.

**Weitere Router (je eine Entscheidung):**

| Router | Datei:Funktion | entscheidet |
|---|---|---|
| Werkzeuge | `src/tools/tool-router.ts:613` `getRelevantTools` | angebotene Werkzeuge |
| Modell je Aufgabe | `src/routing/task-model-routing.ts` `decideRunnerTaskModel` | Codex/lokal/Multi |
| Knoten | `src/mesh/mesh-router.ts:38` `routeTask` | Zielknoten (siehe D11) |
| Kontext | `src/core/context-policy.ts` | Denkmodus, Budgets |
| Lernmuster | `src/routing/outcome-router.ts` | **nur** Stichproben, kein Routing |
| Installationsziel | `src/intelligence/capability-router.ts`, `src/install/install-queue.ts` `planInstallRoute` | wo installiert wird |

**Tests:** `src/tools/tool-router-reachability.test.ts`,
`src/routing/task-model-routing.test.ts`, `outcome-router.test.ts`.

**Nicht benutzen:** `src/tools/registry.ts` (zweite, alte Registry — siehe D2);
`src/layers/L18-llm-router.ts` `selectModel`, `src/intelligence/intent-router.ts`
`routeToModel`, `src/routing/resolve-route.ts` (ohne Produktionsaufrufer).
`src/plugins/plugin-loader.ts` ist nur Fassade des früheren zweiten Laders.

### 5. Modelle und Provider

**Zweck:** Modelle wählen, aufrufen, ausfallsicher wechseln.

**Der eine Weg:** `src/core/llm-factory.ts:668` `createLLM`; Laufzeit-Client
`src/llm/nova-llm-sdk.ts` `createNovaLLMClient` (Klasse `NovaLLM`); Rollen
`src/core/model-resolver.ts` `resolveModel`. Fallback nur über
`fallbackModels` (`llm-factory.ts` `configuredCloudFallbacks`).
Schlüssel: `llm-factory.ts:490` `cloudProviderKey` (siehe D5).

**Wichtige Dateien:** `nova-llm-sdk.ts`, `llm-factory.ts`, `model-resolver.ts`,
`src/llm/model-fallback.ts`, `src/llm/provider-manifest.ts`,
`src/llm/local-llm.ts`, `src/llm/codex-cli-adapter.ts`,
`src/routing/model-registry.ts`, `src/secrets/provider-keys.ts`.

**Tests:** `src/llm/provider-failover.test.ts`, `llm.test.ts`,
`src/core/llm-factory*.test.ts`, `model-resolver-*.test.ts`,
`src/runtime/cloud-service-model.test.ts`.

**Nicht benutzen:** `src/providers/` enthält nur OAuth-/Token-Helfer
(Copilot, Qwen-Portal), keine Provider. `src/llm/openai.ts`, `src/llm/qwen.ts`
ohne Produktionsimporteur; `getNovaLLM()`-Singleton und `LegacyCloudProvider`
in `nova-llm-sdk.ts` sind Altlast.

### 6. Gedächtnis

**Zweck:** Wissen über Besitzer und Welt sicher speichern und in den Prompt geben.

**Der eine Weg (Schreiben):** `src/memory/memory-governance.ts:503`
`record()` → `propose()` → `publish()`. Nur `publish()` schreibt LanceDB, Core
Facts und Wissensgraph (bewacht von `src/memory/memory-single-writer.test.ts`).
**Lesen in den Prompt:** `src/memory/memory-context.ts:18` `buildMemoryContext`
(Governance) plus Owner-Profil `src/memory/owner-profile.ts` (Tier 0, Vorrang,
`reconcileProfileWithMemory`).

**Wichtige Dateien:** `memory-governance.ts`, `memory-context.ts`,
`memory-facade.ts`, `owner-profile.ts`, `correction-memory.ts`,
`auto-observer.ts`, `memory-distiller.ts`, `src/layers/L6-core-facts.ts`,
`src/tools/knowledge-system.ts`.

**Tests:** `src/memory/*.test.ts`, `npm run check:memory-convergence`.

**Nicht benutzen:** `knowledge_store` für Besitzerwissen (eigener Speicher an
Governance vorbei, siehe D4); `buildCoreFactsContext`
(`L6-core-facts.ts`, kein Produktionsaufrufer); alte Speicher
(`.nova-memory`, `.nova-vector-memory` …) werden beim Start migriert und
umbenannt (`*.migriert`).

### 7. Verbindungen und Home Assistant

**Zweck:** Dienste verbinden (Freigabe, Login, Test, Trennen) und Home
Assistant steuern.

**Der eine Weg:** Verbinden `src/connections/connect-flow.ts:142`
`requestConnect` → Freigabekarte → `establishConnection`. Zustand
`src/connections/connection-state.ts:117` `connectionState` („eine
Verbindungswahrheit"). Home Assistant: `src/tools/homeassistant.ts`
`homeAssistantTools`, Zugriff `hassAccess`, Schreibwerkzeuge mit
`ownerApprovalRefusal` und Parameter `confirm`.

**Wichtige Dateien:** `connection-store.ts`, `connector-catalog.ts`,
`connector-login.ts`, `connections-api.ts`, `src/mcp/mcp-runtime.ts`,
`src/core/ha-state.ts`, `src/sensing/` (Geräte-Erkennung, siehe Bereich 14).

**Tests:** `src/tools/homeassistant*.test.ts`,
`src/connections/connect-flow.test.ts`, `connection-state.test.ts`,
`src/core/ha-state*.test.ts`.

### 8. Mesh und Knoten

**Zweck:** mehrere Knoten: signierter Transport, Register, Leiter-Lease,
Nachfolge, Relay, Aufgaben auf anderen Knoten.

**Der eine Weg:** `src/mesh/mesh-transport-runtime.ts:142`
`initMeshTransportRuntime` (Modus ha/direct/standalone). Register
`src/mesh/mesh-registry.ts`. Leiter `src/mesh/leader-election.ts`. Ereignis-Hub
`src/mesh/event-hub.ts` `startMeshHub`. Aufgaben auf anderem Knoten:
`spawn_subagent` mit `mesh_node` (Bereich 3). Übergabe an einen im Satz
genannten Knoten („gib … an ns1“, 2.90.0): `src/mesh/known-node-names.ts`
`handoffTargetNode` (nur echte Knoten aus `mesh.json` und Peer-Profilen) →
Live-Route `mesh-handoff` in `tool-router.ts` bietet `spawn_subagent` an,
Pipeline-Block `## ÜBERGABE AN KNOTEN` nennt node_id und `handoffWaitSeconds`
(bleibt unter der Werkzeug- und Laufgrenze).

**Wichtige Dateien:** `mesh-transport-router.ts`, `transport-contracts.ts`,
`mesh-policy.ts`, `mesh-identity.ts`, `relay-server.ts`,
`relay-mesh-transport.ts`, `succession*.ts`, `witness-quorum.ts`,
`mesh-router.ts`, `node-strengths.ts`.

**Tests:** `src/mesh/*.test.ts` (u. a. `mesh-transport.test.ts`,
`leader-election*.test.ts`, `succession*.test.ts`,
`mesh-delegate-identity.test.ts`), `npm run check:mesh-agent-cancel`.

**Veraltet:** Lease-Protokoll `v1` neben `v2` (`leader-election.ts`);
Supabase-Warteschlange in `delegateTask` (siehe D1).

### 9. Infra: Proxmox und Kubernetes

**Zweck:** VMs und Cluster bedienen; jede Änderung über eine Freigabekarte.

**Der eine Weg:** Proxmox im Gespräch `proxmox_vm`
(`src/tools/verbinden-tools.ts`) → `src/infra/proxmox-chat.ts`
`proxmoxImGespraech`; Befehl `/vms` → `src/infra/proxmox-command.ts`
`handleVmsCommand`. Kubernetes `/cluster` →
`src/infra/kubernetes-command.ts` `handleClusterCommand`; Werkzeug
`cluster_status` (`src/tools/cluster-tools.ts`). Test-Pods nur im Namespace
`xaventra-test`: Werkzeug `cluster_test_pod` (gleiche Datei, Owner-Freigabe je
Anlegen) → `runTestPodAction` → `src/infra/kubernetes-test-pods.ts`
(Vorlage, Whitelist, Wächter); Namespace/RBAC/NetworkPolicy legt der Owner an
(`deploy/kubernetes/xaventra-test-rbac.yaml`).

**Wichtige Dateien:** `src/infra/proxmox.ts` (TLS-Fingerabdruck,
`PROXMOX_ACTIONS`), `proxmox-setup.ts`, `kubernetes.ts`
(`KUBERNETES_NEVER`), `kubernetes-node.ts`, `deploy/helm/xaventra`,
`docs/PROXMOX.md`, `docs/KUBERNETES.md`. Docker auf Hosts nur über den
Host-Agenten (`src/host/docker-agent.ts`, `docs/HOST_ACCESS.md`).

**Tests:** `src/infra/proxmox*.test.ts`, `kubernetes*.test.ts`,
`helm-chart.test.ts`, `src/core/action-policy-pve.test.ts`.

**Hinweis:** `src/devops/` erzeugt nur Dockerfile/Compose — nicht Kubernetes.
`src/infra/` enthält auch `telemetry.ts`, `metrics.ts`, `gateway-auth.ts`,
`auto-update.ts` (Kompatibilität, siehe D9).

### 10. Autonomie und Planer

**Zweck:** zeitgesteuerte Arbeit, Aufträge (Zielketten), Verantwortungen,
Selbstziele.

**Der eine Weg:**
- Zeitgesteuert (Erinnerung, Briefing, `/routine`): Planer
  `src/planner/runtime.ts:182` `startPlannerRuntime`.
- Auftrag des Besitzers (`/auftrag`): `src/core/autonomous-executor.ts:339`
  `startMission`.
- Verantwortungen (`/arbeit`): `src/core/responsibility-runtime.ts`.
- Ziele: `src/core/goal-manager.ts` `GoalManager` (gemeinsamer Zielspeicher).

**Wichtige Dateien:** `src/planner/planner.ts`, `src/tools/reminder-tool.ts`,
`src/core/autonomy-loop.ts`, `src/core/missions.ts`,
`src/intelligence/autonomy-engine.ts`, `src/intelligence/task-planner.ts`
(Plan je Zug im Prompt), `src/core/croner-scheduler.ts`.

**Tests:** `src/planner/*.test.ts`, `src/core/autonomous-executor-*.test.ts`,
`missions.test.ts`, `reminder-planner.test.ts`, `routines.test.ts`.

**Nicht benutzen:** `src/core/scheduler.ts` (kein Importeur);
Alt-Erinnerungen `reminders.json` + Croner-Prüfer (nur Rückfall, siehe D10).

### 11. Sicherheit und Freigaben

**Zweck:** Rollen, Freigabekarten, Code-Prüfung, Selbständerung nur über Gate.

**Der eine Weg:**
- Rollen: `src/users/multi-user-middleware.ts` `checkAuth` /
  `getUserPermission`; bei Ausführung `src/agents/tool-authorization.ts`
  `authorizeToolExecution`.
- Aktionen: `src/core/action-policy.ts:375` `evaluateAction`
  (auto/ask/handoff/never).
- Karten: `src/core/approval-cards.ts:379` `createApprovalCard`,
  `answerApprovalCard`, `registerCardExecutor`; Ausführer in
  `approval-card-sources.ts`.
- Einzelfreigabe im Werkzeug: `src/tools/owner-approval.ts`
  `ownerApprovalRefusal` + Parameter `confirm`. Gemerkte Freigabe (Knopf
  „📌 merken“, `/freigabe merken`, `/freigaben`): `rememberToolApproval` /
  `forgetToolApproval`, feste Grenzen `rememberRefusal` (beim Merken und bei
  jeder Nutzung), Ablage im EINEN Erlaubnis-Speicher `action-policy.ts`
  `rememberApproval` (`trust.json`, Abschnitt `gemerkt`), Hinweis in der Antwort
  `governed-tool-executor.ts` `appendApprovalNotes`, Telegram-Knopf `fm:`
  (`telegram.ts` `handleRememberPress`).
- Selbständerung: `src/synthesis/patch-gate.ts` `approvePatchProposal`
  (`NOVA_PATCH_GATE_TOKEN`); `self-evolution.ts` legt nur Vorschläge an.
- Code: `src/security/code-guardian.ts` `fullSecurityCheck`; Befehle
  `src/security/exec-approvals.ts` `evaluateCommand`.
- Tresor: `src/secrets/` (`credential-broker.ts`, `tresor-cards.ts`).

**Tests:** `src/security/*.test.ts`, `src/core/approval-cards*.test.ts`,
`src/tools/owner-approval.test.ts`, `src/e2e/freigaben-merken.test.ts`,
`src/agents/tool-authorization.test.ts`,
`src/core/action-policy.test.ts`, `src/core/message-pipeline-security.test.ts`,
`npm run check:assurance`.

### 12. Desktop, HUD und Relay

**Zweck:** Electron-Bedienoberfläche, ihre API, direkte Desktop-Sitzungen,
Host-Agenten.

**Der eine Weg:** App `desktop/main.cjs` + `desktop/renderer/`; API
`src/desktop/desktop-api.ts:312` `registerDesktopApi` (Desktop-Schlüssel ⇒
Principal immer der Desktop-Besitzer). Direkt-Sitzungen
`src/desktop-direct/runtime.ts` `startDesktopDirect` (standardmäßig aus).
Bildschirm/Lenken: `src/sehen/` (`sehen-api.ts`). Host-Agenten: `src/host/`.
Computer Use auf einem Knoten-Arbeitsplatz (eigener Labor-Computer): Arbeitsplatz
`src/host/workstation-main.ts`, Mesh-Operation `input` in `src/mesh/node-capture.ts`,
Werkzeuge `mesh_screenshot` + `mesh_desktop_input` (`docs/COMPUTER_USE.md`).

**Relay:** Das Hub-Relay (Art `xaventra`) liegt **nicht** in diesem Repo; es
spricht nur `/api/desktop` an. „Relay" in diesem Repo = Mesh-Relay
(`src/mesh/relay-server.ts`).

**Tests:** `src/desktop/*.test.ts`, `src/desktop-direct/*.test.ts`,
`src/host/*.test.ts`, `desktop/tests/*` (`npm run test:desktop`),
`check:desktop-ui`, `check:desktop-core`.

**Veraltet:** alter Next.js-Client entfallen; `src/dashboard/` ist der
Browser-Zugang zur selben Oberfläche.

### 13. Release und Update

**Zweck:** Prüftore, Versionsdisziplin, signierte Verteilung an Knoten,
Updates aus GitHub.

**Der eine Weg:**
- Prüftore: `npm run check:release` (`src/dev/release-readiness.ts`), CI
  `.github/workflows/ci.yml`, Gitleaks in `promote-release.yml`.
- Upstream: `src/core/github-update.ts` `GitHubUpdateSource` (signiertes
  Manifest); `/update check` → `/update prepare <release-id>` →
  Aktivierung über `update-controller-server.ts`/`update-activation.ts`.
- Knoten: `src/core/auto-updater.ts:658` `deployUpdateToAllNodes`; Werkzeug
  `mesh_update`; Prüfung `src/core/release-verifier.ts`
  `verifyReleaseDirectory`.
- Release-Knopf: `src/core/release-button.ts`.
- Version: `package.json`, `desktop/package.json`, beide Lockfiles,
  `CHANGELOG.md` — gemeinsam anheben (AGENTS.md). Es gibt kein Bump-Skript.

**Tests:** `src/core/auto-updater*.test.ts`, `release-verifier.test.ts`,
`release-button.test.ts`, `github-update.test.ts`,
`promote-release-workflow.test.ts`, `update-activation.test.ts`.

**Nicht benutzen:** `pull_update` (Stub, immer `blocked`);
`src/core/self-update.ts` (alter Propose/Apply-Weg aus `docs/SELF_UPDATE.md`
v2.72); In-Place-Git-Updates sind abgeschaltet.

### 14. Weitere Verzeichnisse unter `src/`

| Verzeichnis | Inhalt |
|---|---|
| `src/acp` | ACP-Stdio-Server (`xaventra-acp`), ruft `runNovaAgent` |
| `src/analysis` | `ast-parser.ts`, Code-Verständnis |
| `src/auth` | Codex-App-Server, OAuth/Login, Alt-Codex-Bereinigung |
| `src/benchmark` | Probes, Abnahme, Regression (`benchmark:*`) — keine Abschlussnoten für Autonomie |
| `src/commands` | Wizard, `builtin.ts` (Rückfall-Befehle), `brain-commands.ts` |
| `src/config` | `config-path.ts` `resolveConfigPath` (der eine Pfadauflöser), Typen |
| `src/core` | Pipeline, Kernel, Policy, Karten, Missionen, Updates (größter Ordner) |
| `src/dashboard` | Browser-Server, CSP, Zugangsschutz |
| `src/dev` | Build-/Layer-/Release-Prüfungen, Katalog-Generator, `check-codekarte.ts` |
| `src/devops` | Dockerfile/Compose-Generator |
| `src/doctor` | deterministische Diagnose und Reparatur (`/doctor`, `self_doctor`) |
| `src/e2e` | nur End-to-End-Tests |
| `src/guided` | „Geführt"-Schritte (Ampel, Tipps) |
| `src/hooks` | `event-hooks.ts` (Werkzeuge `create_hook` …) |
| `src/install` | Installationswarteschlange, Tickets, Never-Liste, Katalog |
| `src/installer` | nur `brain-installer.ts` |
| `src/intelligence` | Autonomie-Engine, Entitäten, Planer je Zug, Doctor-Client |
| `src/layers` | nummerierte Schichten L0–L43 (`docs/LAYERS.md`, `check:layers`) |
| `src/learning` | Korrektur-Lernen, Fähigkeits-Lernen, Skills |
| `src/logging` | `structured-logger.ts` |
| `src/mcp` | MCP-Client und -Laufzeit |
| `src/media` | Bildaufbereitung, Medienverständnis |
| `src/onboarding` | Erststart, Telegram-Kopplung, Onboarding-API |
| `src/plugins` | `PluginManager`, Lader |
| `src/process` | Befehlswarteschlange, Exec, Daemon-Steuerung, Watchdog |
| `src/resilience` | Schicht-0-Resilienz, Backup, Rückfall-Befehle |
| `src/routing` | Modellregister, Modell je Aufgabe, Outcome-Stichproben |
| `src/runtime` | Code-Laufzeit, Missions-Arbeitsbereich, LSP, Profile |
| `src/secrets` | Tresor, Credential-Broker, Provider-/Dienstschlüssel |
| `src/sehen` | „Sehen und lenken" (Bildschirm, Aktivität) |
| `src/sensing` | Geräte- und Netzerkennung, Adapter |
| `src/sessions` | `session-key-utils.ts` |
| `src/startup` | Umgebungs-Scan beim Start (`environment-scanner.ts` `locateProgram`), Tailscale-Status |
| `src/supervisor` | Auto-Tester, Circuit-Breaker, Stop-Loss (`src/supervisor.ts` = Prozess) |
| `src/synthesis` | Patch-Gate, Patch-Sandbox, Selbstevolution |
| `src/terminal` | Terminal-Manager |
| `src/test-utils` | gemeinsame Test-Fixtures |
| `src/tests` | drei ältere Tests (Gedächtnis, Telegram, Werkzeuge) |
| `src/thinking` | „Denken": Ideenlauf, Modell-Scout, Fehlerfinder |
| `src/training` | Selbstbewertung, Feedback-Lerner, Simulator |
| `src/tts` | Text-zu-Sprache |
| `src/types` | Typen für den Asterisk-Client |
| `src/users` | Nutzer, Principals, Besitzerkonten, Multi-User-Middleware |
| `src/utils` | Link-Verständnis, Markdown, Chunking, Umfragen |
| `src/validation` | `tool-validator.ts` |
| `src/voice` | Telefonbrücke (Asterisk/SIP), Sprach-Pipeline |
| `src/watch` | „Wächter"-Engine und Sonden |
| `src/web` | nur WhatsApp-Konto-Auflöser |

Weitere Verzeichnisse, beschrieben im genannten Bereich: `src/agents` (3), `src/channels` (1),
`src/connections` (7), `src/desktop` und `src/desktop-direct` (12),
`src/discord`, `src/slack`, `src/telegram`, `src/whatsapp` (1), `src/host` (12),
`src/infra` (9), `src/integration` (1), `src/llm` und `src/providers` (5),
`src/memory` (6), `src/mesh` (8), `src/planner` (10), `src/security` (11),
`src/server` (1), `src/cli` (1), `src/tools` (4).

---

## Doppelungen

Je Eintrag: was doppelt ist, Belege (Stand 2.89.15), **Empfehlung**, welcher Weg
bleibt. „Offen" heißt: nicht zusammengeführt. Wer eine Doppelung auflöst,
streicht sie hier im selben Commit (oder markiert sie als erledigt mit Version).

### D1 Aufgabenübergabe an andere Knoten

- `mesh_delegate` (`src/tools/complete-registry.ts:2730`) →
  `src/mesh/mesh-registry.ts:931` `delegateTask` → `sendAgentRequest`; eigene
  Warteschleife (2 s, max. 240 s), **nicht abbrechbar**, keine
  Werkzeugbegrenzung, Rückfall Supabase-Warteschlange.
- `spawn_subagent` mit `mesh_node` (`complete-registry.ts:3159`) →
  `src/agents/subagent-orchestrator.ts:303` `runMeshSubagent`; Abbruch über
  `cancelMeshRun`, `allowedTools`, löst `mesh_node="auto"` über `routeTask`.
- Besitzer-Kennung: bis 2.89.14 trug nur `spawn_subagent` die userId;
  2.89.15 reicht sie in `mesh_delegate` nach (`complete-registry.ts:2740–2745`).
  **Weiterhin ohne userId:** der Warteschlangen-Rückfall in `delegateTask`
  (`mesh-registry.ts:970–980`, Nutzlast nur `prompt`); der Empfänger läuft dann
  als `mesh-<node>`.
- Weitere Einstiege auf denselben Weg: `spawn_subagents_parallel`,
  `continuable_subagent_start`, `mesh_repo_task` — reichen `mesh_node="auto"`
  aber roh durch bzw. routen selbst (siehe D11).
- **Empfehlung:** `spawn_subagent` mit `mesh_node` ist der Weg.
  `mesh_delegate` als dünnen Alias darauf umbauen (oder entfernen); „auto" an
  einer Stelle auflösen (`subagent-orchestrator`), nicht im Werkzeug.
- 2.90.0 hält sich daran: die Übergabe-Route `mesh-handoff` bietet nur
  `spawn_subagent` an, nicht `mesh_delegate`.

### D2 Zwei Werkzeug-Registries

- `src/tools/complete-registry.ts` (`NovaToolRegistry`, ~236 Werkzeuge) —
  Laufzeit.
- `src/tools/registry.ts` (`ToolRegistry`, `getToolRegistry` ~1233) mit
  eigenen Definitionen gleichen Namens: `remember`/`recall` als **Stubs**
  (`registry.ts:755–780`, speichern nichts), `ssh_command` (`:489`),
  `mission_status` (`:1198`), `start_autonomous_mission` (`:1152`), `clarify`
  (`:1121`). Genutzt von `src/llm/base.ts:179`, `src/tools/executor.ts`,
  `src/cli.ts:377`.
- `ssh_command` gibt es dreifach: `complete-registry.ts:741` (registriert, ohne
  `confirm`/Identität), `src/tools/ssh-tool.ts:707` `sshTool` (mit `confirm`
  und Identität, importiert, aber nicht registriert), `registry.ts:489`.
- `google_search` doppelt: `complete-registry.ts:963` (registriert) und
  `src/tools/google-search.ts:297` (tote Definition).
- **Empfehlung:** nur `complete-registry.ts`. CLI/`executor.ts`/`llm/base.ts`
  darauf umstellen, `registry.ts` auf reine Typen reduzieren. Bei
  `ssh_command` die Fassung aus `ssh-tool.ts` registrieren.

### D3 Ergebnis- und Abbruch-Formulierungen

Mehrere Stellen formulieren „hat geklappt / nicht gelungen / keine Änderung /
abgebrochen" — und überschreiben sich:

| Stelle | Datei:Zeile |
|---|---|
| Eskalation | `src/core/tool-failure-escalation.ts:68–79, 195–227` `escalationWithCompletedEffects` |
| Runner | `src/agents/nova-runner.ts:1766` `escalateRunFailures`, `:1782` `finishUnfinished` |
| Aufgabenvertrag | `src/core/task-contract.ts:313` `userFacingVerdictMessage` |
| Laufgrenzen | `src/core/run-limits.ts:77` `limitStopNotice` |
| Werkzeugbelege | `src/core/tool-evidence-response.ts:77–256` (`incompleteExecutionsResponse` u. a.) |
| Keine Aktion | `src/core/action-intent.ts:196` `honestNoToolResponse` |
| Unbelegte Behauptung | `src/core/unverified-claims.ts:32, 58` |
| Pipeline | `src/core/message-pipeline.ts` ~2398–2466, 2559–2584, 2618, 2692, 2923–2932 |
| L12 | `src/layers/L12-anti-hallucination.ts:174` `generateCorrectedResponse` (**ohne Produktionsaufrufer**, nur Test) |
| Telegram-Erkennung | `src/channels/telegram-presentation.ts:107` `isTelegramFailureReply` |
| Selbstziele | `src/core/autonomy-loop.ts:906` `selfGoalFailure` (eigene Fehlschlag-Regex) |

Belegte Widersprüche:
- Pipeline `~2559–2562` ersetzt die Eskalationsfrage des Runners
  (gebundener Lauf setzt `incompleteAnswerReady` nicht).
- Pipeline `~2573–2578` gibt rohen Werkzeugtext aus, ohne auf eine offene
  Rückfrage zu achten.
- „Aktion erfolgreich" dreifach definiert: Eskalation (Werkzeug hat `confirm`),
  Pipeline (`toolProvidesActionEvidence`), `honestNoToolResponse`.
  `run_command`/`ssh_command` haben kein `confirm`.
- `isTelegramFailureReply` erkennt „Die Aktion ist nicht gelungen", „nicht
  hinbekommen", „nicht als abgeschlossen bestätigen", Zeitlimit-Texte und
  `limitStopNotice` nicht → Karte wird als Erfolg geschlossen.
- Zwei ⚠️-Hinweise: `L12_UNVERIFIED_NOTE` (`tool-evidence-response.ts:199`) und
  `UNVERIFIED_NOTE` (`unverified-claims.ts:9`).
- **Empfehlung:** ein Ergebnis-Typ (Status + Text) aus dem Runner
  (`outcome-ledger` als Hoheit), den die Pipeline nur noch rendert. Kanäle und
  Selbstziele lesen den **Status**, nie den Text per Regex. L12-Korrektur
  löschen oder verdrahten.

### D4 Gedächtnis-Speicher

| Speicher | Schreiber | über Governance? |
|---|---|---|
| Governance (+ LanceDB, Core Facts, Graph als Projektion) | `remember` `:991`, `kg_remember` `:3262`, `update_memory` `:810`, `update_user_profile` `:789`, `learn_correction` `:2104` (alle `complete-registry.ts`) | ja |
| Owner-Profil `owner-profile.json` | `owner_profile` (`complete-registry.ts:2972` → `owner-profile.ts:338`) | nein (Tier 0, Vorrang) |
| Wissensspeicher `.nova-data/knowledge` | `knowledge_store` (`src/tools/knowledge-system.ts:376`) | **nein**, kein Prompt-Leser |
| Core Facts direkt | `L6-core-facts.ts` `addFact` (nur `propose`, `scope: 'global'`) | halb |

- Derselbe Fakt (z. B. Hunde des Besitzers) kann im Profil, in Governance
  (+Projektionen), als Graph-Kante und im Wissensspeicher mit verschiedenen
  Werten stehen. `reconcileProfileWithMemory` (`owner-profile.ts:260`) läuft nur
  in der Pipeline und `/memory recall`, prüft nur strukturierte Fakten; die
  Werkzeuge `recall`, `kg_search`, `knowledge_recall` lesen ohne Profilvorrang.
- Beschreibungen stimmen nicht: `update_user_profile` behauptet `USER.md` zu
  ersetzen, `recall` nennt LanceDB.
- **Empfehlung:** Governance ist der eine Speicher; Owner-Profil bleibt Tier 0,
  aber Lese-Werkzeuge wenden denselben Profilvorrang an. `knowledge_store`
  entweder in Governance überführen (eigene `kind`) oder auf
  Dokumente/Notizen ohne Personenfakten beschränken.

### D5 Schlüssel-Lesewege

- Kanonisch LLM: `src/core/llm-factory.ts:490` `cloudProviderKey`
  (Klartext → Tresor-Ref → `cloudProviderCredentials` → Tresor-Profil → Env).
- Kanonisch Dienste: `src/secrets/service-keys.ts:112` `resolveServiceApiKey`
  (**Env zuerst** — umgekehrte Reihenfolge).
- Basis: `src/secrets/provider-keys.ts:48` `resolveProviderKey`,
  `:101` `rehydrateConfigProviderKeys`.
- Abweichende Leser ohne Tresor: `src/tools/minimax-tools.ts:29`
  `getMiniMaxKey`, `src/layers/L10-vision.ts:121`,
  `src/tools/image-gen-tool.ts:108`, `src/media/media-providers.ts`,
  `src/nova-boot.ts:400`, `src/cli.ts:287–313`,
  `src/core/model-resolver.ts:147` `getOpenAIKey`,
  `src/llm/provider-registry.ts:154` (Config vor Env),
  `src/core/config-service.ts:189` (Env vor Config),
  `src/llm/nova-llm-sdk.ts:2226` (eigene Reihenfolge für OpenAI).
- Speichern doppelt: `save_api_key` (`src/tools/api-key-tool.ts`, nur
  Brave/Tavily/Perplexity → `storeServiceApiKey`) vs.
  `register_llm_provider`/`storeProviderKey`.
- **Empfehlung:** alle LLM-Leser auf `cloudProviderKey`, alle Dienst-Leser auf
  `resolveServiceApiKey`; Reihenfolge (Env vs. Config) einmal festlegen und
  dokumentieren. MiniMax zuerst (nach Tresor-Migration unsichtbar).

### D6 Konfiguration laden

- Pfad: `src/config/config-path.ts` `resolveConfigPath` (kanonisch).
- Loader: `src/core/config.ts:245` `loadConfig` (Zod, eigene Kandidatenliste),
  `src/core/llm-factory.ts:63` `getNovaConfig` (roh, Tresor-Rehydrierung,
  Cache), `src/core/config-service.ts:143` `loadConfig` (Auswahl + Env),
  `src/core/model-resolver.ts` (eigene Lese-/Schreibstellen), plus ~95 rohe
  `JSON.parse(readFileSync(resolveConfigPath()))`.
- `src/core/auto-updater.ts:473` umgeht `resolveConfigPath`.
- **Empfehlung:** `llm-factory.getNovaConfig` als einzige Laufzeit-Lesefunktion
  (nach `src/config/` ziehen); neue Rohlesungen verbieten.

### D7 Besitzer-Prüfung

- Rechte: `src/users/multi-user-middleware.ts` `getUserPermission`,
  `isConfiguredOwner`.
- Kanonischer Besitzer: `src/users/owner-identity.ts:37`
  `resolveCanonicalOwner`; Konten `src/users/owner-accounts.ts`;
  `src/users/principal-id.ts` `resolvePrincipalId`.
- Eigene Prüfungen: `src/core/approval-cards.ts` `isCardOwner`,
  `src/desktop/desktop-api.ts` (Desktop-Besitzer), `src/voice/telefon-config.ts`
  `isOwnerNumber`, `src/channels/telegram.ts` `getOwnerChatIds` und
  `src/channels/even-g2-runtime.ts` `numericOwnerIds` (gleiche Regex zweimal).
- Rohes `allowFrom[0]` als Besitzer: `src/daemon.ts`, `src/memory/memory-distiller.ts`,
  `src/layers/L6-core-facts.ts`, `src/core/daemon-channels.ts`,
  `src/tools/reminder-tool.ts`, `src/watchdog.ts` — widerspricht
  `resolveCanonicalOwner` bei mehreren Besitzern.
- `src/secrets/chat-key-intake.ts` nimmt ohne `isOwner` `true` an.
- **Empfehlung:** `getUserPermission` + `resolveCanonicalOwner` als einziger
  Weg; `allowFrom[0]` ersetzen.

### D8 Fehlerklassifizierer

| Funktion | Datei | Besonderheit |
|---|---|---|
| `isInfrastructureFailure(string)` | `src/core/infrastructure-failure.ts:9` | „die eine Regel" |
| `isInfrastructureFailure(run, thrown)` | `src/doctor/failure-research-coordinator.ts:72` | **gleicher Name, andere Bedeutung**, matcht Wörter `model`/`llm` |
| `isInfrastructureModelFailure` | `src/llm/model-perf-db.ts` | + 408/429/502–504 |
| `isAuthFailure` | `src/core/infrastructure-failure.ts:14` | 401/403 |
| `isAuthFailure` | `src/connections/connector-login.ts:344` | 401, „abgelaufen", **ohne 403** |
| `isUnreachable` | `src/core/infrastructure-failure.ts:22` | + DNS/Host |
| `isConnectionFailure` | `src/llm/nova-llm-sdk.ts:1370` | eigene Regex, ohne ETIMEDOUT |
| `classifyToolFailure` | `src/core/typed-tool-recovery.ts:54` | eigene Klassen |
| `classifyFailoverReason` | `src/llm/model-fallback.ts` | lockere Muster (`/5\d{2}/`, „auth"), Netzfehler = timeout |
| `isRetryableError` | `src/llm/nova-llm-sdk.ts` | dritte Retry-Definition |
| `classifyError` | `src/intelligence/replan-engine.ts:99`, `src/layers/L0-self-repair.ts:152` | gleicher Name, verschiedene Begriffe |
| Inline-Regex | `src/core/message-pipeline.ts` ~2909 | Fehlerkategorie für Antworttext |

- 429, 403, 502–504, ENOTFOUND werden je nach Stelle verschieden eingeordnet.
- **Empfehlung:** ein Modul `src/core/infrastructure-failure.ts` mit einer
  Klassifikation (auth/rate-limit/unreachable/timeout/server/input); alle
  anderen darauf aufsetzen. Gleichnamige Funktionen umbenennen.

### D9 Statusberichte

- `nova_status` (`src/tools/self-management.ts`) ≈ `system_info`
  (`complete-registry.ts:1649`): Uptime, Node, PID, cwd doppelt.
- `nova_capabilities` (`:2599`) = `nova_introspect` mit `type=tools`.
- `/status` drei- bis vierfach: `src/core/slash-commands.ts:888` (reichster),
  `src/commands/builtin.ts:72` (Rückfall), `src/cli.ts:631`.
- `/doctor` doppelt: `slash-commands.ts:1824` (Doctor) und `builtin.ts:133`
  (Hardware); dazu Werkzeug `self_doctor`.
- `/health` (Knoten, L21) ≠ Werkzeug `health_status` (Disk/RAM).
- `mesh_status` und `mesh_nodes` listen Knoten aus verschiedenen Quellen.
- `version_info`/`check_updates`/`pull_update` über `src/infra/auto-update.ts`
  (Kompatibilität; `pull_update` immer `blocked`).
- **Empfehlung:** `/status` aus `slash-commands.ts` als Nutzersicht,
  `environment_inventory` für Umgebung/Geräte; `system_info` in `nova_status`
  aufgehen lassen, `nova_capabilities` als Alias, `pull_update` entfernen.

### D10 Planer und Aufträge

- Aufträge dreifach gestartet: `/auftrag` (`slash-commands.ts:3464`, echter
  Nutzer), `start_mission` (`complete-registry.ts:2622`, fest `'nova-self'`,
  ohne Prüfung auf laufenden Auftrag), `start_autonomous_mission`
  (`registry.ts:1152`, `'system'`).
- `/auftrag` (`autonomous-executor.ts`) und `/arbeit`
  (`responsibility-runtime.ts`) sind zwei Engines.
- Zeitsteuerung: Planer (`src/planner/`), `CronerScheduler`
  (`src/core/croner-scheduler.ts`, Autonomie-Schleife, Distiller,
  Alt-Erinnerungen), toter `src/core/scheduler.ts`.
- Erinnerungen: `set_reminder` → Planer, sonst Alt-`reminders.json`;
  `src/planner/auto-reminders.ts` als dritter Erzeuger.
- `mission_status` doppelt (`complete-registry.ts:2637`, `registry.ts:1198`).
- **Empfehlung:** Planer für alles Zeitgesteuerte; `start_mission` mit echtem
  Nutzer und Aktiv-Prüfung; `src/core/scheduler.ts` löschen.

### D11 Knotenwahl

- `routeTask` (`src/mesh/mesh-router.ts:38`), `mesh_route`
  (`complete-registry.ts:1943`, `rankNodesLive`), `mesh_repo_task`
  (`src/mesh/mesh-repo-task.ts:62`, fest Fähigkeit `code`).
- **Empfehlung:** `routeTask` als einzige Auswahl; die beiden anderen rufen sie.

### D12 Rückfrage-Gate und Runner

- Gate: `src/core/clarification-gate.ts:96` `evaluateClarification`, ein Aufruf
  in der Pipeline (~1192). Der Runner entscheidet selbst keine Rückfrage.
- Weitere Frage-Wege: Eskalation schreibt `pendingClarification`
  (`tool-failure-escalation.ts:173`), Entitäten-Frage (`message-pipeline.ts`
  ~1218), Verbinden-/Fähigkeits-Gates (~1141–1172), Policy-Freigaben im Runner,
  Entscheidungen `rueckfrage` (`src/core/decisions.ts:559`), Missionskarte
  (`src/core/missions.ts:302`), verwaistes `clarify`-Werkzeug +
  `BusinessSenseAnalyzer` (`src/layers/L16-business-sense.ts`).
- **Empfehlung:** alle Fragen an den Besitzer über einen Speicher
  (`pendingClarification`) und ein Rendering; `clarify`/L16 entfernen.

### D13 Ähnliche Werkzeug-Paare

| Paar | Befund | bleibt |
|---|---|---|
| `list_sub_agents` / `list_subagents` | L8 (Kompatibilität) vs. Orchestrator | `list_subagents` |
| `evolve_self` / `self_evolve` | gleiche Funktion; `evolve_self` verspricht Build/Merge und meldet einen eingereihten Patch als „fehlgeschlagen"; `soul.ts` nennt noch `evolve_self` | `self_evolve` |
| `screen_capture` / `desktop_screenshot` | lokal scrot vs. authentifizierter Desktop-Client | `desktop_screenshot` |
| `desktop_control` / `desktop_input` | App-Oberfläche vs. Betriebssystem-Eingabe — verschieden; Retry-Prompt jetzt `ACTION_RETRY_PROMPT` in `src/core/unverified-claims.ts` (Klicken/Tippen → `desktop_input`/`mesh_desktop_input`) | beide |
| `desktop_input` / `mesh_desktop_input` | lokal freigegebener Desktop vs. Arbeitsplatz eines Knotens (Mesh, frische Aufnahme als Beleg) — verschieden | beide |
| `web_search` / `searxng_search` / `google_search` / `browser_search` / `brave_search` / `tavily_search` | sechs Suchwege | `web_search` als Einstieg |
| `remember` / `kg_remember` / `knowledge_store` | siehe D4 | Governance |
| `check_updates` / `pull_update` / `mesh_update` | `pull_update` Stub | `check_updates`, `mesh_update` |
| `self_doctor` / `auto_fix` | Befundliste vs. tsc-Reparaturlauf — verschieden | beide |
| `run_command` / `ssh_command` / `code_runtime_run` / `execute_python` | absichtlich verschieden (lokal/remote/Sandbox/Python); `ssh_command` dreifach (D2) | alle, `ssh_command` vereinheitlichen |

---

## Werkzeug-Index

Jedes registrierte Werkzeug steht genau einmal hier, im Bereich, der es
verantwortet. Der Check (unten) schlägt fehl, wenn ein Werkzeug fehlt.

- **Gedächtnis (Bereich 6):** `remember` `recall` `kg_remember` `kg_search`
  `knowledge_store` `knowledge_recall` `knowledge_get` `knowledge_list`
  `knowledge_delete` `owner_profile` `update_memory` `update_user_profile`
  `learn_correction` `compact_context`
- **Runner/Agenten (Bereich 3):** `spawn_subagent` `spawn_subagents_parallel`
  `continuable_subagent_start` `continuable_subagent_followup`
  `subagent_interrupt` `list_subagents` `list_sub_agents`
- **Mesh/Knoten (Bereich 8):** `mesh_delegate` `mesh_route` `mesh_repo_task`
  `mesh_capabilities` `mesh_deploy` `mesh_download_file` `mesh_exchange_list`
  `mesh_exchange_send` `mesh_exchange_write` `mesh_inspect_url` `mesh_nodes`
  `mesh_recommendations` `mesh_scan` `mesh_screenshot` `mesh_desktop_input` `mesh_services`
  `mesh_status` `mesh_strengths` `mesh_transport_status` `mesh_update`
- **Infra (Bereich 9):** `proxmox_vm` `cluster_status` `docker_control` `docker_logs`
  `docker_ps` `docker_status` `ssh_command` `port_scan` `network_info`
  `disk_usage` `process_list` `process_kill` `service_status` `tail_log`
- **Autonomie/Planer (Bereich 10):** `start_mission` `mission_status` `mission_config`
  `mission_workspace_create` `mission_workspace_diff` `mission_workspace_list`
  `mission_workspace_run` `set_reminder` `list_reminders` `set_quiet_hours`
  `projekte_status` `create_poll` `vote_poll` `poll_results`
- **Verbindungen/HA (Bereich 7):** `hass_status` `hass_list` `hass_get`
  `hass_turn_on` `hass_turn_off` `hass_toggle` `hass_service` `dienst_finden`
  `dienst_verbinden`
- **Sicherheit/Freigaben (Bereich 11):** `zugaenge_liste` `zugang_freigabe_anfragen`
  `anmelden_mit_zugang` `add_exec_rule` `check_command` `exec_history`
  `exec_rules` `list_tool_policies` `set_tool_policy` `quick_scan`
  `security_audit` `blue_asset_inventory` `blue_containment_plan`
  `blue_dependency_audit` `blue_incident_start` `blue_incident_timeline`
  `blue_ioc_check` `blue_log_triage` `self_evolve` `evolve_self`
  `patch_proposals` `evolution_history` `evolution_stats`
- **Modelle/Provider (Bereich 5):** `list_llm_providers` `register_llm_provider`
  `remove_llm_provider` `list_fallback_chains` `set_model_override`
  `save_api_key` `list_media_providers`
- **Werkzeuge/Router, Skills, Plugins (Bereich 4):** `find_capability`
  `resolve_capability` `research_all_capabilities` `research_capability_plan`
  `runtime_capabilities` `nova_capabilities` `add_route` `create_hook`
  `delete_hook` `list_hooks` `hook_history` `discover_plugins` `list_plugins`
  `load_plugin` `load_skills` `import_skill` `build_skill` `create_skill`
  `delete_skill` `list_skills`
- **Status/Diagnose (siehe D9):** `nova_status` `nova_introspect` `nova_trace_stats`
  `health_status` `system_info` `environment_inventory` `get_env`
  `get_current_time` `list_sessions` `save_config` `self_doctor`
  `self_doctor_findings` `self_doctor_update_finding` `auto_fix` `scan_now`
- **Release/Update (Bereich 13):** `check_updates` `pull_update` `update_history`
  `version_info` `nova_restart` `codex_install` `auto_provision`
  `self_setup_status` `self_setup_plan` `self_setup_research`
  `self_setup_apply`
- **Desktop/HUD (Bereich 12):** `desktop_control` `desktop_input` `desktop_screenshot`
  `desktop_status` `desktop_workspace` `screen_capture` `screen_analyze`
  `webcam_capture` `browser_handoff`
- **Web, Suche, Browser:** `web_search` `searxng_search` `google_search`
  `browser_search` `brave_search` `tavily_search` `fetch_url` `browser_open`
  `browser_navigate` `browser_click` `browser_type` `browser_scroll`
  `browser_elements` `browser_extract` `browser_get_links`
  `browser_screenshot` `browser_download` `browser_upload` `browser_replay`
  `browser_status` `browser_close` `browser_tabs` `browser_tab_new`
  `browser_tab_switch` `browser_tab_close`
- **Dateien und Code:** `read_file` `write_file` `delete_file`
  `list_directory` `find_files` `read_document` `code_search` `code_outline`
  `view_code_item` `lsp_query` `run_command` `execute_python`
  `code_runtime_run` `file_to_base64` `parse_markdown` `markdown_to_whatsapp`
- **Kanäle/Nachrichten (Bereich 1):** `send_telegram_message` `send_file`
- **Medien, Sprache, Geräte, Sonstiges:** `analyze_image` `analyze_video`
  `generate_image` `detect_media` `face_detect` `hand_gesture` `cad_generate`
  `minimax_image_gen` `minimax_tts` `minimax_video_start`
  `minimax_video_status` `minimax_vision` `speak` `list_voices`
  `transcribe_audio` `tts_cleanup` `voice_setup` `printer_discover`
  `printer_print` `printer_slice` `printer_cancel` `printer_files`
  `printer_gcode` `printer_info` `printer_pause` `printer_resume`
  `printer_start` `printer_status` `astro_plate_solve` `parcel_track`
  `weather`

---

## So bleibt die Karte aktuell

1. **Vor der Änderung:** Bereich lesen; prüfen, ob es den Weg schon gibt
   (Doppelungen!). Gibt es ihn, den vorhandenen Weg erweitern.
2. **Im selben Commit** die Karte anpassen, wenn sich etwas davon ändert:
   der eine Weg eines Bereichs, ein neues/entferntes Verzeichnis unter `src/`,
   ein neues/entferntes/umbenanntes Werkzeug, eine neue oder aufgelöste
   Doppelung, ein Test, der einen Bereich bewacht.
3. **Neue Doppelung gefunden** (auch ohne sie zu beheben): als `D<n>` mit
   Belegen und Empfehlung eintragen — nicht stillschweigend einen dritten Weg
   bauen.
4. **Doppelung aufgelöst:** Eintrag löschen oder mit „erledigt in <Version>"
   kennzeichnen, „Nicht benutzen" im Bereich nachziehen.
5. **Automatischer Check:** `npm run check:codekarte`
   (`src/dev/check-codekarte.ts`) — schlägt fehl, wenn ein Verzeichnis unter
   `src/` nicht als `src/<name>` oder ein registriertes Werkzeug nicht als
   `` `name` `` in dieser Datei vorkommt. Er läuft auch in
   `npm run catalogs:generate` und `npm run check:catalogs` (CI) und im Test
   `src/dev/check-codekarte.test.ts`.
6. Zeilennummern bei größeren Umbauten neu belegen (Funktionsname bleibt der
   Anker). Öffentliches Repo: keine Adressen, Hosts, Schlüssel, Kundendaten.
