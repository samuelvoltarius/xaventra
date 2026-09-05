# Nova Commands Reference

> Command reference for Nova v2.72. Natural language is the normal control
> surface; slash commands remain available for explicit audit and operations.
> Commands work in Telegram (autocomplete), WhatsApp (text), Discord, CLI, and REST API.

---

## 📌 Quick Reference

| Category | Commands |
|----------|----------|
| System | `/help` `/status` `/info` `/layers` `/commands` `/verbose` `/strict` `/heartbeat` |
| LLM | `/models` `/model` `/think` `/ai` |
| Memory | `/memory` `/skills` `/learn` `/graph` |
| Intelligence | `/roi` `/scan` `/wave` |
| Self-Setup *(v2.52+)* | `/setup status` `/setup plan` `/setup research` `/setup apply` |
| Self-Evolution *(v2.51+)* | `/patches` `/patch approve` `/patch reject` `/patch history` |
| Agents | `/bot team` `/subagent` `/agents` `/swarm` |
| Users | `/users` `/users promote` `/users block` |
| SSH & Mesh | `/hosts` `/nodes` `/update` `/preflight` |
| Autonomy | `/autonom` `/mission` `/remind` |
| Session | `/clear` `/save` `/compact` `/monitor` `/log` |

---

## System

### `/help`
Zeigt alle verfügbaren Befehle gruppiert nach Kategorie.

### `/status`
System-Status mit Uptime, Memory-Verbrauch, aktiver LLM, Mesh-Status.

### `/info`
Detaillierte System-Info: Version, Node.js Version, OS, aktive Channels.

### `/layers`
Zeigt alle kognitiven Layers und deren aktuellen Status (aktiv/inaktiv/Fehler).

### `/commands`
Listet alle registrierten Slash-Commands als kompakte Liste.

### `/verbose`
Schaltet den Trust-Modus ein/aus. Er zeigt Denkmodus, Modell, Node, Laufzeit, verwendete Tools und verifizierte Evidence — keine internen Gedankentokens.

### `/strict`
Schaltet den Strict-Modus ein/aus. Im Strict-Modus implementiert Nova exakt was gesagt wird, ohne Annahmen.

### `/debug`
Zeigt Debug-Informationen: Memory-Usage, aktive Sessions, Tool-Statistiken.

---

## LLM & Reasoning

### `/models`
Listet alle verfügbaren LLM-Modelle mit Provider und Status.

### `/model <name>`
Wechselt das aktive LLM-Modell. Beispiel: `/model gemini-2.5-pro`

### `/think`
Schaltet Reasoning-Modus ein/aus. Mit Reasoning denkt Nova in expliziten Schritten.

### `/reasoning`
Aktiviert geschützte Reasoning-Diagnostik. Interne Gedankentokens werden nicht in Chats ausgegeben; nutze `/verbose` für überprüfbare Laufzeit- und Evidence-Daten.

---

## Memory & Learning

### `/memory`
Memory-Status: LanceDB-Einträge, Progressive Memory Stats, Cold Storage.

### `/skills`
Zeigt alle gelernten Skills mit Zeitstempel und Source.

### `/learn <topic>`
Bringt Nova neues Wissen bei. Beispiel: `/learn Unsere neue API ist unter api.example.com`

### `/lernstatus`
Status des Lernsystems: Letzte Learnings, Success-Rate, Pending.

### `/korrektur`
Zeigt aktive Korrekturen und Instinct-Updates.

---

## Intelligence (v2.44)

### `/roi`
📊 **ROI Dashboard** — Zeigt Kosten/Wert-Tracking pro Task.
- Gesamtkosten vs. geschätzter Wert
- Tägliche ROI-Statistiken
- Durchschnittliche Kosten pro Task

### `/graph`
🕸️ **Knowledge Graph** — Zeigt extrahierte Entitäten, Entscheidungen, Tools.
- Anzahl Nodes, Links, MOCs
- Node-Typen (entity, decision, tool, project, person)
- Auto-aktualisiert bei jeder Konversation

### `/scan <path>`
📁 **File Index** — Scannt und indexiert ein Verzeichnis.
- `scan` ohne Argument: Zeigt aktuellen Index-Status
- `/scan F:\projects` — Indexiert das Verzeichnis
- Danach: Nova kann Dateien instant finden

### `/wave new <title>`
🌊 **Wave Pipeline** — Startet eine strukturierte Mission.
- 6 Phasen: Discover → Discuss → Design → DevOps → Distill → Deliver
- Jede Phase erzeugt Artefakte die du reviewst
- `/wave approve` — Phase genehmigen
- `/wave revise <feedback>` — Phase überarbeiten
- `/wave status` — Fortschritt anzeigen
- `/wave list` — Alle Missionen

---

## Self-Setup Autopilot *(v2.52+)*

Nova scans herself on startup and proposes actions — no silent installs. All actions require explicit approval or YOLO mode.

### `/setup status`
Zeigt den letzten gespeicherten Scan-Zustand aus `.nova-data/setup-state.json`:
- Host, OS, Umgebungsvariablen
- Mesh-Nodes: online/offline, Capabilities, empfohlene Rollen
- Voice: ok / fehlende Pakete / Warnungen
- LLM: aktiver Provider, lokale Kandidaten
- Supabase / Embedding-Konfiguration
- Empfohlene Actions mit Risiko-Level

### `/setup plan`
Führt einen **frischen Scan** durch (inkl. Ollama-Probes) und zeigt den aktuellen Plan.
- Aktionen mit Risk: low / medium / high
- Research-Badges 🟢🟡🔴 wenn `/setup research` schon lief
- Hinweis wie viele Aktionen web-recherchiert vs. statisch sind

### `/setup research`
Recherchiert für **alle fehlenden Capabilities** via Websuche die aktuell beste Lösung:
- Spawnt pro Capability einen Subagent mit `web_search + read_url`
- Hardware-aware: Apple Silicon → Metal, NVIDIA → CUDA, ARM → leichtgewichtig
- Schreibt Ergebnisse mit Confidence + Quelle zurück in `setup-state.json`
- Ergebnis sofort im Plan sichtbar

### `/setup research <capability>`
Recherchiert eine einzelne Capability. Unterstützte Werte:
`stt` `tts` `llm` `embedding` `vision` `ffmpeg` `whisper` `ollama`

Beispiel: `/setup research stt` → findet aktuelle Whisper-Variante für deine Hardware.

### `/setup apply <actionId>`
Führt **eine spezifische Aktion** aus dem Plan aus.
- Normale Mode: das Eintippen des Commands = Freigabe
- YOLO-Mode: gleiches Verhalten
- `config_patch`: schreibt `xaventra.config.json` via Deep-Merge
- `local_shell`: führt Command aus, gibt Output zurück
- `remote_shell`: SSH-Command auf Remote-Node

### `/setup apply all`
Führt **alle ausstehenden Aktionen** aus — nur im YOLO-Modus sinnvoll.

---

## Self-Evolution & Patch Management *(v2.51+)*

Nova kann Änderungen an ihrem eigenen Code vorschlagen. Diese werden immer zuerst als Proposals gespeichert — nie autonom angewendet. Freigabe erfolgt explizit via Telegram + `NOVA_PATCH_GATE_TOKEN`.

### `/patches`
Zeigt alle Patch-Proposals aus `.nova-data/patch-proposals.json`:
```
🧬 Patch-Vorschläge (gesamt: 3, ausstehend: 1)

🟡 [1] `patch_172...abc` (ausstehend)
   📁 src/core/message-pipeline.ts
   💬 Verbessere Fehlerbehandlung bei leeren Nachrichten
   💡 Robustheit gegen Edge Cases
   🕐 vor 5min

Approve: /patch approve <id>
Ablehnen: /patch reject <id>
```

### `/patch list`
Identisch mit `/patches`.

### `/patch approve <id>`
Genehmigt einen Patch und führt ihn aus. Benötigt:
1. `NOVA_PATCH_GATE_TOKEN` in der Umgebung gesetzt
2. Nur erlaubte Telegram-User (`allowFrom`)

**Pipeline:**
```
git checkout -b nova/self-evolve-...
→ search/replace im Ziel-File
→ npx tsc --noEmit  (muss grün sein)
→ git commit + merge
→ npm run build
→ pm2 restart nova (oder process.exit(0))
```
Bei jedem Fehler: vollständiger Rollback (git checkout, branch löschen, Datei wiederherstellen).

### `/patch reject <id>`
Markiert einen Proposal als `rejected`. Keine Code-Änderung.

### `/patch history`
Zeigt die letzten 10 Evolution-Einträge mit Status + Zeitstempel sowie Gesamtstatistik (total / erfolgreich / fehlgeschlagen).

---

## Multi-Agent

### `/bot team <preset>`
Startet ein Agent-Team mit parallelen Spezialisten.

**Presets:**
- `default` — Researcher + Coder + Analyst
- `creative` — Creative + Researcher + Analyst
- `security` — Security + Coder + Analyst
- `research` — Researcher + Researcher + Analyst
- `fullstack` — Coder + Researcher + Analyst

### `/bot team list`
Zeigt alle verfügbaren Team-Presets.

### `/subagent <role> "query"`
Spawnt einen einzelnen Spezialisten.
Rollen: `researcher`, `coder`, `analyst`, `creative`, `security`

### `/agents`
Zeigt Status aller aktiven Agents.

### `/swarm`
Zeigt den Status des Agent-Swarms.

---

## User Management (v2.42)

### `/users`
Listet alle registrierten User mit Rolle und Status.

### `/users list`
Detaillierte User-Liste mit letzte Aktivität und Channel.

### `/users info <id>`
Zeigt Details eines Users: Rolle, Registrierungsdatum, Nachrichten-Count.

### `/users promote <id> <role>`
Ändert die Rolle eines Users. Rollen: `owner`, `admin`, `user`, `guest`

### `/users block <id>`
Blockiert einen User — alle Nachrichten werden ignoriert.

### `/users unblock <id>`
Entsperrt einen blockierten User.

---

## SSH & Mesh

### `/hosts`
Zeigt konfigurierte SSH-Hosts mit Connection-Status.

### `/hosts new <name> <user@host>`
Fügt einen neuen SSH-Host hinzu.

### `/hosts del <name>`
Entfernt einen SSH-Host.

### `/nodes`
Zeigt alle Mesh-Nodes mit Status, Latenz, und Capabilities.

### `/nodes info`
Detaillierte Node-Informationen: VRAM, GPU, Ollama-Version, Skills.

### `/nodes sync`
Synchronisiert Skills + Updates zu allen Edge-Nodes.

### `/nodes restart <node>`
Startet einen spezifischen Node neu.

### `/update`
Deployment-Update an alle Edge-Nodes.

### `/preflight`
Führt Pre-Flight Checks auf allen Nodes durch.

### `/preflight local`
Nur lokale Pre-Flight Checks.

### `/preflight <host>`
Pre-Flight für einen spezifischen Host.

---

## Autonomy

### `/autonom`
Schaltet den Autonomie-Modus ein/aus. Im Autonomie-Modus agiert Nova proaktiv.

### `/mission <beschreibung>`
Startet eine autonome Mission. Nova plant Schritte und führt sie aus.
Beispiel: `/mission Update alle Dependencies und fixe Deprecation Warnings`

### `/mission status`
Zeigt den Fortschritt der aktiven Mission.

### `/mission stop`
Bricht die aktive Mission ab.

### `/mission config`
Zeigt/ändert Mission-Konfiguration (Max-Steps, Retries, Timeout).

### `/remind <zeit> <nachricht>`
Setzt eine Erinnerung. Beispiel: `/remind 30min Meeting vorbereiten`

---

## Session

### `/clear`
Setzt den Konversationskontext zurück. Wie ein Neustart.

### `/save`
Speichert die aktuelle Session persistent.

### `/compact`
Komprimiert den Kontext durch Zusammenfassung der bisherigen Konversation.

### `/apikey <key>`
Setzt einen API-Key (für Gemini etc.).

---

## Admin & Monitoring

### `/bots`
Zeigt den Status aller Bot-Instanzen (Nova-Flotte).

### `/project`
Zeigt den aktuellen Projekt-Kontext (wenn in einem Projekt).

### `/monitor`
System-Monitoring Dashboard mit CPU, Memory, Disk Usage.

### `/task`
Zeigt aktive Tasks mit Progress.

### `/log`
Zeigt das Session-Log der aktuellen Konversation.

### `/heartbeat`
Status der Heartbeat-Routines (periodische Checks).

### `/factory`
Tool Factory Status — zeigt dynamisch erstellte Tools.

### `/login`
Startet den Admin-Login-Flow.

### `/callback`
OAuth Callback Handler für den Login-Flow.
