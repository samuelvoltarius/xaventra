# Werkzeug-Schmiede (Tool Forge)

Xaventra baut sich fehlende Werkzeuge selbst. Es gibt dafür genau einen Weg und ein
Register. Code: `src/tools/skill-builder.ts` (Register, Bau, Aktivierung, Ausführung),
`src/tools/forge-sandbox.ts` (Sandbox, statische Prüfung). Stand P9 (01.10.2026).

## Ablauf

1. **Bedarf** — eine von vier Quellen:
   - `build_skill`: das Modell liefert Code, Manifest und Tests selbst.
   - `create_skill`, `/werkzeuge bau <was>` oder `/learn <was>`: das **lokale Lern-Modell**
     (`serviceModels.learning`) schreibt den Entwurf. Kein Cloud-Modell; ohne lokales
     Modell wird ehrlich abgelehnt.
   - Bedarfs-Hook in der Pipeline (direkt hinter `finishRoutineSkillRun`), nur für
     Owner-Anfragen im Direktgespräch: Owner-Wunsch („bau dir ein Werkzeug für …“),
     fehlendes Werkzeug (`Tool nicht gefunden: x`) oder Wiederholung (ein neuer
     Routine-Skill nutzt immer wieder ein allgemeines Werkzeug wie `execute_python`
     oder `fetch_url`). Höchstens 3 Bauten pro Tag, gleicher Bedarf nur einmal in 7 Tagen.
     Seit 2.84.0 kommt „fehlendes Werkzeug“ wirklich an: stoppt das Modell-Gate einen
     Lauf, weil das Modell ein nicht angebotenes Werkzeug wollte, wird jedes davon,
     das in **keinem** Register steht, ein Fehleintrag `Tool nicht gefunden: x` (nur für
     den Hook, nicht im Ledger). Ein vorhandenes, nur nicht angebotenes Werkzeug ist
     kein Bedarf. Neue Versionen (`reviseTool`) zählen ins selbe Tageslimit; darüber
     wird die Version auf morgen gelegt (Gedanke „neue Version morgen“) und in einer
     ruhigen Owner-Runde nachgeholt — abgeschaltet wird dabei nichts.
   - **Worker bauen nichts** (`NOVA_NODE_ONLY=true`).
2. **Entwurf** — ESM-JavaScript:

   ```js
   export default async function (params, ctx) {
     const r = await ctx.fetch('https://api.frankfurter.app/latest?from=EUR&to=' + params.to)
     return { kurs: (await r.json()).rates[params.to] }
   }
   ```

   Dazu ein **Manifest** und **Testfälle als Daten**:

   ```json
   { "manifest": { "net": ["api.frankfurter.app"], "fs": [], "wirkung": "lesend" },
     "tests": [{ "name": "CHF", "params": { "to": "CHF" },
                 "fetch": [{ "url": "https://api.frankfurter.app/latest", "body": "{\"rates\":{\"CHF\":0.94}}" }],
                 "expect": { "equals": { "kurs": 0.94 } } }] }
   ```

   - `net`: exakte Hostnamen für `ctx.fetch`. `fs`: absolute Pfade, die `ctx.readFile`
     lesen darf (nie Nie-Ziele, nie Xaventras eigener Zustand, Config oder `.env`).
   - `wirkung`: `lesend` (nur GET/HEAD) · `schreibend` (ändert etwas in einem Dienst) ·
     `extern` (verlässt das Haus) · `physisch` (wirkt im Raum). Name und Aktions-Policy
     heben eine zu niedrige Angabe an (`licht_schalten` ist physisch), senken nie.
   - Erwartungen: `equals`, `contains`, `type`, `keys`, `throws`. Netz in Tests nur über
     `fetch`-Datensätze, Dateien über `files`.
3. **Statische Prüfung** — CodeGuardian `staticSecurityCheck` (AST) plus
   Modul-Erlaubnisliste (`node:buffer`, `node:crypto`, `node:events`, `node:path`,
   `node:querystring`, `node:string_decoder`, `node:url`), kein dynamischer Import, kein
   `require`, kein `import.meta`, Pflicht `export default`. Name auf der Nie-Liste → nie
   gebaut.
4. **Tests in der Sandbox** — jeder Testfall in einem frischen Kindprozess.
5. **Aktivierung** (fest im Code):

   | Wirkung | Aktivierung | Aufruf |
   |---|---|---|
   | lesend | selbst, sobald alle Tests grün sind (Gedanke, Zeile im Abendbericht) | Owner oder Admin |
   | schreibend | Karte `werkzeug-schreibend` (L2); die Vertrauensleiter darf die Art nach 3× „Ja“ ohne Rückweg hochstufen | nur Owner |
   | extern | Karte `werkzeug-extern` | nur Owner, **jeder Aufruf** braucht die Owner-Freigabe (`ownerApprovalRefusal`) |
   | physisch | Karte `werkzeug-physisch` | wie extern |

   Eine Freigabe gilt nur für genau diesen Code (sha256). Neue Version = neue Freigabe.
6. **Ausführung** — aktive Werkzeuge heißen `forge_<name>` und laufen nur im
   Sandbox-Kind. Zähler: Aufrufe, Erfolge, Fehler, Fehler in Folge.
7. **Fehlschläge** — 2 in Folge: mit lokalem Lern-Modell entsteht eine neue Version
   (alte bleibt in `history`, die letzten 5), die wieder alle Tests bestehen muss;
   sonst wird das Werkzeug abgeschaltet (Gedanke, Warnung). Nur dieser Weg darf
   abschalten.
   **Verbesserung** (2.84.0, Owner-„Ja“ auf eine Schmiede-Idee): die neue Version ist
   ein **Kandidat**. Die aktive Version bleibt aktiv, bis der Kandidat alle Tests
   besteht — lesend ersetzt er sie dann selbst; schreibend/extern/physisch erst nach
   der Karte (Ablehnen verwirft nur den Kandidaten). Scheitert der Entwurf oder ein
   Test, wird nur der Kandidat verworfen (Gedanke „neue Version verworfen“).
8. **Zurück in den Routine-Skill** (2.83.0) — entstand ein **lesendes** Werkzeug aus der
   Wiederholung eines Routine-Skills, ersetzt es bei der Aktivierung dort den
   allgemeinen Schritt (`execute_python`, `fetch_url` …) in einer neuen Skill-Version;
   der Bedarf in `forge/bedarf.json` merkt sich `skillId` und das ersetzte Werkzeug.
   Die neue Version wird gegen die alte gemessen: 2 Fehlschläge in Folge oder nach
   5 Läufen eine schlechtere Quote als die alte Version → der Skill geht selbst auf die
   alte Version zurück (bleibt an; Gedanke „Werkzeug X hat Skill Y nicht verbessert“).
   Sonst nach 5 Läufen bestätigt (Gedanke „Skill Y nutzt jetzt X“, Abendbericht).
   Schreibende, externe und physische Werkzeuge ändern den Skill nie automatisch.

## Die Sandbox

Jeder Lauf startet

```
node --permission --allow-fs-read=<runner.mjs> --allow-fs-read=<werkzeug.mjs>
     --disallow-code-generation-from-strings --max-old-space-size=96 --no-warnings
```

mit leerer Umgebung (`env: {}`) in einem frischen Temp-Ordner.

- **Permission-Modell:** keine Schreibrechte, Lesen nur der zwei eigenen Dateien, kein
  `child_process`, keine Worker, keine Addons.
- **Codeerzeugung aus Text** ist aus: `eval`, `new Function`, Konstruktor-Kette.
- **Import-Sperre** per `module.registerHooks`: nur die Erlaubnisliste; `fs`, `net`,
  `http(s)`, `child_process`, `vm`, `module`, `data:`-URLs usw. scheitern beim Auflösen —
  auch `await import(/**/'node:child_process')`.
- Im Kind überschrieben: `process.getBuiltinModule`, `process.binding`,
  `_linkedBinding`, `dlopen`, `kill`, `report`, `_getActiveHandles`, `execve`,
  `loadEnvFile`, `chdir`, `_debugProcess` u. a.; `stdin/stdout/stderr`, `process.env`,
  das globale `fetch`, `WebSocket`, `EventSource` und `console` sind für das Werkzeug
  nicht erreichbar; `net.Socket.connect`/`net.Server.listen` werfen.
- **Netz** nur über `ctx.fetch`: der Elternprozess prüft Host gegen das Manifest,
  `lesend` → nur GET/HEAD, dann SSRF-Guard (`safeFetch`, keine Weiterleitungen,
  15 s, höchstens 1 MB). **Dateien** nur über `ctx.readFile` (Realpath innerhalb der
  Manifest-Pfade, nie Nie-Ziele, höchstens 1 MB).
- **Zeitlimit** (Test 10 s, Aufruf 20 s) und Speicherlimit; danach `SIGKILL`.
- Das Ergebnis zählt nur mit einem Einmal-Schlüssel, den das Werkzeug nie sieht.

Geprüft mit echten Kindprozessen in `src/tools/forge-sandbox.test.ts`: Datei schreiben,
`child_process` (auch mit Kommentar-Trick), `eval`/`new Function`, fremder Host,
`node:net`/`node:https`, POST bei `lesend`, Umgebungsvariablen, `process.kill`, gefälschte
Ergebnisse und Endlosschleife → abgelehnt; reines Werkzeug, `node:crypto`, Manifest-Host
und `ctx.readFile` → erlaubt.

**Node-Version.** Nötig sind `--permission` (stabil ab Node 22.13) und
`module.registerHooks` (ab Node 22.15). CI läuft mit dem aktuellen Node 22. Fehlt eins,
liefert `sandboxSupport()` den Grund, `/werkzeuge` zeigt ihn, und **es wird nichts
ausgeführt** — es gibt keine unsichere Ausweichlösung.

## Register und Sichtbarkeit

- Datei: `<runtime>/.nova-data/forge/werkzeuge.json` (Version, Code, Hash, Manifest,
  Tests, letzter Testbericht, Zähler, Belege, Historie). Bedarf:
  `<runtime>/.nova-data/forge/bedarf.json`.
- Die frühere `.nova-learning/skill-forge.json` wird einmal übernommen und als
  `.migriert` umbenannt; alte Vorschläge (Funktionskörper ohne Manifest/Tests) stehen als
  „Altbestand“ abgeschaltet im Register und laufen nie.
- `/werkzeuge` (Owner): Liste mit Status, Wirkung, Version, Tests, Zählern ·
  `/werkzeuge <name>` Details · `/werkzeuge aus|an <name>` · `/werkzeuge bau <was>`.
  Modell-Werkzeuge: `build_skill`, `create_skill`, `list_skills`, `delete_skill`
  (schaltet ab, löscht nichts).
- Desktop „Skill Forge“ und die alten Telegram-Knöpfe `skill_ok:`/`skill_no:` geben frei
  bzw. lehnen ab; aktiv wird ein Werkzeug trotzdem nur mit grünen Tests.

## Stillgelegt (P9)

- Der Lader für `.nova-tools/*.json`, der Code im Daemon per `new Function` mit echtem
  `fetch` ausführte, ist entfernt. Vorhandene Dateien werden nicht geladen; der Start
  meldet ihre Anzahl.
- `synthesis/sandbox.ts` (worker_threads + Regex-Prüfung) ist entfernt: es war keine
  Grenze (Datei schreiben, `execSync`, sichtbare Umgebung; Regex mit
  `await import(/**/'node:child_process')` umgehbar).
- Die Doppel-Einstiege `create_tool`, `create_runtime_tool`, `list_custom_tools` und die
  L8-Codeerzeugung (`/learn` lief ins Leere) sind entfernt; alles geht durch dieses
  Register.
