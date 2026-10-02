# Nova Commands Reference

> Command reference for Nova v2.72. Natural language is the normal control
> surface; slash commands remain available for explicit audit and operations.
> Commands work in Telegram (autocomplete), WhatsApp (text), Discord, CLI, and REST API.
>
> Telegram autocomplete ("/") and the text `/help` are generated from one list,
> `COMMAND_MENU` in `src/core/slash-commands.ts` (2.86): owner-relevant entries
> only, each with a handler (`src/learning/lernen-ohne-slash.test.ts`).
> "Was hast du gelernt?" needs no command: `nova_introspect` (type `skills`)
> reads procedures, routine skills, self-built tools, the learning pulse and
> decisions; the Desktop view **Gedächtnis → Prozeduren** shows the same with
> an on/off switch per procedure.

---

## 📌 Quick Reference

| Category | Commands |
|----------|----------|
| System | `/help` `/status` `/info` `/layers` `/commands` `/verbose` `/strict` `/routine` |
| LLM | `/models` `/model` `/think` `/ai` |
| Memory | `/memory` `/skills` `/learn` `/werkzeuge` `/graph` |
| Intelligence | `/roi` `/scan` |
| Self-Setup *(v2.52+)* | `/setup status` `/setup plan` `/setup research` `/setup apply` |
| Self-Evolution *(v2.51+)* | `/patches` `/patch approve` `/patch reject` `/patch history` |
| Agents | `/bot team` `/subagent` `/agents` `/swarm` |
| Users | `/users` `/users promote` `/users block` |
| SSH & Mesh | `/hosts` `/nodes` `/update` `/preflight` |
| Autonomy | `/autonom` `/auftrag` `/remind` `/jetzt` `/gedanken` `/arbeit` `/delegiert` `/entscheidungen` `/heilung` `/software` `/modelle` `/waechter` |
| Proxmox *(Phase 6c)* | `/vms` `/vms meine` `/vms neu` `/vms wegwerf` `/vms snapshot` `/vms entfernen` |
| Session | `/clear` `/save` `/compact` `/monitor` `/log` |
| Desktop | `/desktop` |

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
Owner: Routine-Skills (an/aus mit `/skills aus|an <id>`) und die Zahl der gemerkten
Prozeduren (verifizierte Lösungen).

### `/learn <was>`
Lässt die Werkzeug-Schmiede ein Werkzeug bauen (wie `/werkzeuge bau <was>`). Nur mit
lokalem Lern-Modell; kein Cloud-Ersatz.

### `/werkzeuge [<name>|aus <name>|an <name>|bau <was>]`
Owner: selbst gebaute Werkzeuge mit Status, Wirkung, Version, Tests und Zählern;
Details, an/aus, bauen. Siehe [TOOL_FORGE.md](TOOL_FORGE.md).

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
🕸️ **Knowledge Graph** — Zählt den Wissensgraphen (`.nova-data/knowledge-graph.json`).
- Anzahl Knoten und Kanten, Knoten-Typen (person, place, hardware, project, pet …)
- Befüllt nur über die Memory-Governance: kanonische Fakten mit Subjekt/Beziehung/Wert
  (Owner-Aussagen wie „Ich wohne in …“, „Mein Drucker heißt …“, Distiller, `kg_remember`)

### `/scan <path>`
📁 **File Index** — Scannt und indexiert ein Verzeichnis.
- `scan` ohne Argument: Zeigt aktuellen Index-Status
- `/scan F:\projects` — Indexiert das Verzeichnis
- Danach: Nova kann Dateien instant finden

`/wave` wurde entfernt (die Phasen-Notizen hatten keinen Erzeuger und führten
nichts aus). Für ein Ziel in Schritten: `/auftrag`.

---

## Self-Setup Autopilot *(v2.52+)*

Nova scans herself on startup and proposes actions — no silent installs. Every action needs the owner's one-time code (`/setup apply`) or, for catalog installs, the owner's „Ja“ on the install card or a standing permission (`/setup allow <id>`). YOLO mode no longer changes this (P9).

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
Gibt einen Einmal-Code aus (5 min, nur für dich); `/setup apply <actionId> <code>` führt die Aktion aus.
- `config_patch`: schreibt `xaventra.config.json` via Deep-Merge — **immer nur mit Code**, auch im YOLO-Modus
- Katalog-Aktionen: kommen in die Installations-Warteschlange; installiert wird nach dem Ja auf der Knopf-Karte oder bei dauerhafter Erlaubnis
- Freie Befehle (`local_shell`/`remote_shell`) werden nie ausgeführt

### `/setup apply all`
Wie oben für alle Aktionen des Plans (Code für `all`). Ohne Code gehen nur Katalog-Aktionen in die Warteschlange.

### `/setup approve <iq-id>` · `/setup allow|ask <katalog-id>`
`approve` schickt die Knopf-Karte des Warteschlangen-Eintrags (erneut); das Ja dort stellt das signierte Ticket aus. `allow` legt eine dauerhafte Erlaubnis für genau diesen Katalog-Eintrag in `.nova-data/action-policy/trust.json` ab (ohne Rückfrage installiert, signiert als Vertrauensleiter, Rückweg bleibt); `ask` nimmt sie zurück.

### `/freigabe <werkzeug> <detail>`
Owner. Einmal-Code für ein Werkzeug mit Außen- oder physischer Wirkung (Drucker, Home Assistant, Python, geschützte Config, MCP-Server mit `requireApproval`, SSH-Selbstheilung …), 5 min, einmal, nur für dich — und nur für genau dieses Detail. Das Detail nennt die Ablehnung des Werkzeugs wörtlich (Dateiname, Entität, `user@host` oder ein `#<hash>` für Code/Argumente). Ein Code ohne Detail wird nicht mehr ausgegeben.

---

## Self-Evolution & Patch Management *(v2.51+)*

Nova kann Änderungen an ihrem eigenen Code vorschlagen. Diese werden immer zuerst als Proposals gespeichert — nie autonom angewendet. Freigabe nur über die PATCH_GATE-Knopf-Karte (oder die Desktop-Vertrauensansicht) mit gesetztem `NOVA_PATCH_GATE_TOKEN` — eine Prüfkette: Owner, Live-Main-Fencing, Token, atomarer Zustand, ein Doppel-Druck wendet nur einmal an.

### `/patches`
Zeigt alle Patch-Proposals aus `.nova-data/patch-proposals.json`:
```
🧬 Patch-Vorschläge (gesamt: 3, ausstehend: 1)

🟡 [1] `patch_172...abc` (ausstehend)
   📁 src/core/message-pipeline.ts
   💬 Verbessere Fehlerbehandlung bei leeren Nachrichten
   💡 Robustheit gegen Edge Cases
   🕐 vor 5min

Freigeben/Ablehnen über die Knopf-Karte. /patch approve <id> schickt sie (erneut).
```

### `/patch list`
Identisch mit `/patches`.

### `/patch approve <id>`
Schickt die Knopf-Karte dieses Patches (erneut) — angewendet wird erst mit dem Ja dort (P9: kein zweiter Freigabeweg). Benötigt:
1. `NOVA_PATCH_GATE_TOKEN` in der Umgebung gesetzt
2. Owner (numerische Telegram-ID in `allowFrom`)

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

## Sichtbarkeit & Knopf-Karten *(Phase 1)*

### `/jetzt`
Owner. Laufende Aufgaben (Live-Statuskarten, Task-Tracker, Mission), Installations-Warteschlange, offene Knopf-Karten und die letzten Entscheidungen.

### `/gedanken [n]`
Owner. Die letzten n (Standard 25) Gedanken/Vorschläge inkl. verworfener (Nie-Liste), abgelehnter und abgelaufener — aus Karten, Selbstheilungs-Journal/-Vorschlägen und Installations-Journal.

### `/software`
Owner, nur lesend, immer verfügbar. Je Fähigkeit (STT, TTS, Embeddings, Browser, Audio/Video, Vision, Desktop, LLM): vorhanden wo / passt wo (mit Installationsweg) / passt nicht (mit Grund) / fehlt. Vorschläge per Knopf nur mit `autonomy.softwareScout.enabled=true`. Details: `docs/AUTONOMY_GUIDE.md` (Software-Scout).

### `/delegiert [n]`
Owner. Offene und die letzten n (Standard 10) abgeschlossenen Delegationen an Claude/Codex/Hermes/Unteragenten mit Status, Stufe (L1/L2), Erfolgskriterium, Prüfergebnis (verifiziert/nicht erfüllt/unverifiziert), Beleg und Antwort-Auszug (nur Daten). Standard aus: `autonomy.delegation.enabled`. Details: `docs/AUTONOMY_GUIDE.md`.

### `/entscheidungen [widerruf <id>|gilt <id>|verwerfen <id>]`
Owner. Kausales Gedächtnis: gültige Entscheidungen mit Warum, wer/wann, gültig bis und Abhängigkeiten; offene Rückfragen bei Widersprüchen (`gilt` = die neue gilt, `verwerfen` = die alte bleibt); Befunde aus Missionen/Delegationen und Nachmessungen angenommener Ideen; zuletzt beendete. `widerruf` hebt eine Entscheidung auf. Angelegt wird ohne Befehl aus Owner-Anweisungen und Knopf-Antworten. Details: `docs/AUTONOMY_GUIDE.md` („Kausales Gedächtnis“).

### `/arbeit [pause <id>|weiter <id>]`
Owner. Missionen nach Zustand (In Arbeit / Geplant / Wartet auf Alfred / Blockiert / Abgeschlossen) und die aktiven Verantwortungen mit erfüllt/verletzt. `pause`/`weiter` schaltet eine Verantwortung an/aus. Details: `docs/AUTONOMY_GUIDE.md` („Verantwortungen und Missionen“).

### `/vms [meine|snapshots <vmid>|snapshot|start|stop|rollback|neu|wegwerf|vergroessern|entfernen|cloudinit|hilfe]`
Owner. Proxmox-Gäste (nur lesend) mit Markierung der eigenen VM, des Pools `xaventra` und „meiner VMs“ (Tag `xaventra-created`) samt freiem Ressourcen-Deckel. Alle schreibenden Unterbefehle erzeugen nur eine Knopf-Karte (Wirkung `infra`, nie „Immer erlauben“); ausgeführt wird erst nach dem Ja. Standard aus. Details: `docs/PROXMOX.md`.

### `/waechter`
Owner, nur lesend. Wächter (Phase 7): letzte Messwerte je Knoten (Last, RAM, Platten, Temperatur, Antwortzeit), Erreichbarkeit der konfigurierten/eingerichteten Ziele, Prognosen (Platte voll, RAM), TLS-Ablauf, Backup-Alter und ausgelassene Einträge. Standard aus: `autonomy.watch.enabled`. Details: `docs/AUTONOMY_GUIDE.md` („Wächter“).

### `/desktop`
Owner. Liste der konfigurierten Desktops (Spark-Workstation, Labor-VM …) mit Knöpfen „👁 Ansehen“ / „🖱 Übernehmen“. Ein Knopfdruck schickt in den Privatchat einen Einmal-Link (10 min, einmal einlösbar, nur Tailnet über `tailscale serve`); der Browser braucht kein Passwort, der Gateway meldet sich selbst am VNC-Server an. „Ansehen“ verwirft Tastatur/Maus im Gateway; „Übernehmen“ erlaubt Eingaben und pausiert Xaventras eigenes `desktop_input` auf diesem Desktop bis „↩️ Zurückgeben“ oder Sitzungsende. Standard aus (`desktop.direct.enabled=false`), nie auf Workern. Andere Kanäle zeigen nur die Liste. Details: `docs/DESKTOP_DIRECT.md`.

Knopf-Karten selbst haben keinen Befehl: Installations-, Heil- und PATCH_GATE-Vorschläge kommen als Telegram-Karte mit [Ja] [Nein] [Später] (und [Immer erlauben], wo es eine bestehende Freigabestufe gibt). Details: `docs/AUTONOMY_GUIDE.md`.

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

### `/auftrag <beschreibung>`
Startet einen **Auftrag**: Xaventra zerlegt dein Ziel in Schritte und arbeitet
sie selbstständig ab; jeder Schritt braucht einen unabhängigen Beleg. Ein
Schritt kann an Claude, Codex, Hermes oder einen Unteragenten übergeben werden
(Delegation, siehe `/delegiert`); der Auftrag wartet dann auf das geprüfte
Ergebnis. `/mission` ist der alte Name und funktioniert weiter (mit Hinweis).
Beispiel: `/auftrag Update alle Dependencies und fixe Deprecation Warnings`

Begriffe: **Auftrag** = dein Ziel als Schrittkette. **Mission** = eine
selbstständige Verantwortungs-Mission (z. B. „Dienst läuft wieder“), siehe
`/arbeit`.

### `/auftrag status`
Zeigt den Fortschritt des aktiven Auftrags.

### `/auftrag stop` · `/auftrag pause` · `/auftrag weiter`
Bricht ab, pausiert oder setzt fort.

### `/auftrag config`
Zeigt/ändert die Auftrags-Konfiguration (Max-Schritte, Wiederholungen, Timeout).

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
Zeigt die Rollen (frühere Bot-Personas) und Teams. Eigene Bot-Instanzen gibt
es nicht mehr; eine Rolle fragst du mit `/subagent <rolle> <frage>`, ein Team
mit `/bot team <frage>` (läuft über den Unteragenten-Orchestrator: höchstens
6 parallel, Audit-Log `.nova-data/subagent-audit.jsonl`).

### `/project`
Zeigt den aktuellen Projekt-Kontext (wenn in einem Projekt).

### `/monitor`
System-Monitoring Dashboard mit CPU, Memory, Disk Usage.

### `/task`
Zeigt aktive Tasks mit Progress.

### `/log`
Zeigt das Session-Log der aktuellen Konversation.

### `/routine`
Tägliche Routinen im Planer: `/routine` listet, `/routine 08:00 Postfach
prüfen` legt an, `/routine aus|an|weg <id>` schaltet oder entfernt. Frühere
`heartbeat.md`-Routinen werden beim Start einmal übernommen (Datei danach
`heartbeat.md.migriert`). `/heartbeat` ist der alte Name.

### `/factory`
Tool Factory Status — zeigt dynamisch erstellte Tools.

### `/login`
Startet den Admin-Login-Flow.

### `/callback`
OAuth Callback Handler für den Login-Flow.
