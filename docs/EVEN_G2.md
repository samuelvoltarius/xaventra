# Even G2 — Smartglasses als Kanal

Autonomie-Plan Phase 5a. Die Brille spricht direkt mit Xaventra:

1. **„Hey Even“-Agent** — die Even-App leitet Sprachfragen an Xaventra weiter, die Antwort
   erscheint als Text auf der Brille.
2. **HUD-Feed** — eine kleine Even-Hub-App zeigt, woran Xaventra gerade
   arbeitet, und offene Knopf-Karten. Tap = Ja, Doppeltap = Nein. Die App liegt nicht mehr in
   diesem Repo, sondern im Quietglass-Repo:
   <https://github.com/samuelvoltarius/quietglass-g2/tree/main/apps/xaventra-hud>
3. **Sprache** — `POST /hud/voice`: Mikrofon-Audio der Brille wird mit der vorhandenen
   Xaventra-Spracherkennung in Text gewandelt, beantwortet eine offene Karte (nur klares
   Ja/Nein) oder geht als normale Nachricht an den Agenten.

Beides läuft über **einen** kleinen HTTP-Dienst im Daemon (`src/channels/even-g2.ts`,
Verdrahtung `src/channels/even-g2-runtime.ts`).

## Feste Regeln (im Code, nicht per Config änderbar)

| Regel | Umsetzung |
|---|---|
| Standard **aus** | startet nur mit `channels.evenG2.enabled=true` **und** `NOVA_EVEN_G2_TOKEN` (≥ 24 Zeichen) |
| Nur am Main | auf Workern (`NOVA_NODE_ONLY=true`) startet der Dienst nie; jede Frage und jede Kartenantwort prüft den Main-Fence (`assertFenced('nova-main', live)`), im `enforce`-Modus sonst 503 |
| Nur Loopback | bindet immer an `127.0.0.1` — es gibt absichtlich keine `host`-Option; von außen nur über `tailscale serve` |
| Owner-Token | `Authorization: Bearer <Token>`, Vergleich in konstanter Zeit, Token wird nie geloggt oder zurückgegeben; ohne/falsch → 401, die Pipeline läuft nicht |
| Doppelte Fragen | die Even-App schickt jede Frage zweimal; gleiche Frage innerhalb 30 s → **ein** Pipeline-Lauf, beide Anfragen bekommen dieselbe Antwort |
| Antwortform | höchstens 400 Zeichen, ohne Markdown und Emoji, an Satzgrenze gekürzt |
| Zeitbudget | 24 s (Even-Frist ~28 s). Dauert es länger: „Ich arbeite dran, Ergebnis kommt in Telegram.“ — das Ergebnis geht genau einmal an den Telegram-Owner |
| Pipeline | normale Message-Pipeline, Kanal `even-g2`, Principal `even-g2:owner` mit Owner-Rechten (das Token ist der Owner-Ausweis, wie beim Desktop-Token) |
| Sprache | `/hud/voice` entscheidet nie allein über Karten mit Wirkung nach außen (siehe unten); die Audiodaten werden weder geloggt noch gespeichert, das Token nie geloggt |
| Karten | nur `ja`/`nein` über `answerApprovalCard`: Owner-Prüfung, Einmal-Token (zweiter Tap → 409), Nie-Liste bekommt nie eine Karte, „Immer erlauben“ gibt es auf der Brille nie; die Knopf-Tokens bleiben auf dem Server, die Brille kennt nur Karten-IDs |

## Einrichtung (am Main)

1. **Token erzeugen** und in die Umgebung des Dienstes legen (Secrets-Datei/Env des Dienstes,
   nicht in `xaventra.config.json`, nicht ins Repo):

   ```bash
   openssl rand -hex 32        # Ausgabe als NOVA_EVEN_G2_TOKEN setzen
   ```

2. **Config** (`xaventra.config.json`):

   ```json
   "channels": {
     "evenG2": { "enabled": true, "port": 18790, "allowOrigins": [] }
   }
   ```

   `allowOrigins` leer = CORS-Antwort `*` nur für `/hud`, `/hud/answer` und `/hud/voice` (die Even-Hub-App
   läuft im WebView mit unbekanntem Origin; ohne Bearer-Token liefert der Feed trotzdem nur 401,
   Cookies gibt es nicht). Mit Einträgen wird nur genau dieser Origin erlaubt. `POST /` (Even AI)
   sendet nie CORS-Header.

3. **Optional: gleiches Gedächtnis wie Telegram** — Principal verknüpfen
   (`userPrincipals` wie in `src/users/principal-id.ts` beschrieben):

   ```json
   "userPrincipals": { "even-g2:owner": "<dein Telegram-Principal>" }
   ```

4. **Dienst neu starten.** Im Log steht dann
   `[EvenG2] ✅ aktiv auf http://127.0.0.1:18790 (nur Loopback; HTTPS über tailscale serve)`
   bzw. der Grund, warum er nicht startet (`aus`, `Token fehlt`, `Worker-Knoten`).

5. **HTTPS nur im Tailnet** mit `tailscale serve` (kein Funnel — der Dienst soll nicht ins
   offene Internet). HTTPS ist nötig, weil die Even-App kein HTTP annimmt und die Hub-App im
   WebView sonst an „Mixed Content“ scheitert:

   ```bash
   tailscale serve --bg --https=8790 http://127.0.0.1:18790
   tailscale serve status        # zeigt https://<main>.<tailnet>.ts.net:8790
   ```

   (Syntax ab Tailscale 1.52; bei älteren Versionen `tailscale serve --help` prüfen.)
   Das Telefon muss im selben Tailnet sein (Tailscale-App an).

6. **Even-App → Even AI → „Add Agent“**: URL `https://<main>.<tailnet>.ts.net:8790/`
   (die Wurzel, nicht `/v1/chat/completions`), Token = `NOVA_EVEN_G2_TOKEN`.

7. **HUD-App** aus dem Quietglass-Repo
   (<https://github.com/samuelvoltarius/quietglass-g2/tree/main/apps/xaventra-hud>, dort steht
   die Anleitung zum Bauen und Laden): in `app.json` die Tailnet-Adresse in die
   `network`-Whitelist eintragen, per `evenhub qr` aufs Telefon laden, in der App Adresse +
   Token speichern.

8. **Sprache** (optional): `/hud/voice` nutzt dieselbe Spracherkennung wie Telegram-
   Sprachnachrichten, keine neue Abhängigkeit: zuerst der eigene Sprachdienst
   (`xaventra-voice`), dann `whisper-gpu` im eigenen Netz, zuletzt lokales `whisper` auf dem
   Main (`whisper` im PATH). Ist nichts davon erreichbar, antwortet der Endpunkt mit 503.
   Sprache geht nie in eine Cloud. Zusätzliche Config ist nicht nötig.

## Schnittstellen

### `POST /` (auch `/v1/chat/completions`)

Anfrage wie vom Even-AI-Plugin:

```http
POST /
Authorization: Bearer <Token>
Content-Type: application/json

{"model":"openclaw","messages":[{"role":"user","content":"Was steht heute an?"}]}
```

Antwort (nicht gestreamt):

```json
{"id":"chatcmpl-…","object":"chat.completion","created":1790000000,"model":"openclaw",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Zwei Termine …"},"finish_reason":"stop"}]}
```

Fehler: 401 (Token), 400 (kein JSON / keine Frage), 413 (> 64 KB), 503 (nicht der Main).

### `GET /hud?since=<version>&wait=<s>`

Long-Poll (höchstens 25 s): kommt sofort zurück, wenn sich der Stand von `since` unterscheidet,
sonst spätestens nach `wait` Sekunden.

```json
{"version":"53186dacc6b60020","status":"Prüft Drucker — Schritt 1/2",
 "cards":[{"id":"k07fadcd8da05","titel":"Neues Modell Z testen?","text":"Modell Z war … Wechseln?",
           "wirkung":"intern","antworten":["ja","nein"],"gueltigBis":"2026-10-02T13:31:25.939Z"}],
 "at":"2026-10-01T13:31:28.092Z"}
```

`status` kommt aus denselben Daten wie `/jetzt` (laufende Statuskarten, aktuelle Aufgabe,
Mission, Warteschlange). Es werden höchstens 5 offene Karten gezeigt, Texte gekürzt.

### `POST /hud/answer`

```json
{"cardId":"k07fadcd8da05","answer":"ja"}
```

| Status | Bedeutung |
|---|---|
| 200 | angenommen/abgelehnt, `message` = Ergebnis des Ausführungswegs |
| 400 | Antwort ist nicht `ja`/`nein` (also auch kein „immer“) |
| 403 | kein numerischer Telegram-Owner in `channels.telegram.allowFrom`, oder Nie-Liste |
| 404 | Karte unbekannt |
| 409 | Karte schon beantwortet (Einmal-Token) |
| 410 | Karte abgelaufen |

Die Entscheidung wird wie ein Telegram-Knopf behandelt (Outcome-Ledger, `/gedanken`),
`decidedBy` = `even-g2:<Owner-ID>`; die Telegram-Kopien der Karte werden nachgezogen
(Knöpfe weg, Ergebnis drin).

### `POST /hud/voice`

Mikrofon-Audio der Brille. Gleiche Authentifizierung (Bearer), gleiches CORS und gleicher
Main-Fence wie `/hud/answer`.

```http
POST /hud/voice[?cardId=<Karten-ID>]
Authorization: Bearer <Token>
Content-Type: application/octet-stream

<16 kHz, 16 Bit, mono, Little-Endian-PCM>
```

**Audioformat** (alles andere → 400 bzw. 415):

| `Content-Type` | Inhalt |
|---|---|
| `application/octet-stream` oder `audio/L16` (optional `; rate=16000; channels=1`) | rohes PCM, 16 kHz, 16 Bit, mono |
| `audio/wav` (auch `audio/x-wav`) | WAV-Datei, nur PCM, 16 kHz, 16 Bit, mono (Kopf wird geprüft) |

**Grenzen:**

| Fall | Status |
|---|---|
| leer oder kürzer als 0,3 s | 400 |
| länger als 20 s oder mehr als 700 000 Bytes | 413 |
| Format nicht 16 kHz / 16 Bit / mono, kaputtes WAV | 400 |
| anderer `Content-Type` | 415 |
| Token fehlt oder falsch | 401 (Spracherkennung läuft nicht) |
| nicht der aktive Main | 503 |
| keine Spracherkennung erreichbar | 503 (`Spracherkennung nicht verfügbar.`) |
| Spracherkennung dauert länger als 12 s | 504 |

**Antwort** (200):

```json
{"transcript":"ja","action":"answered_ja","cardId":"k07fadcd8da05","reply":"Erledigt."}
```

| `action` | Bedeutung |
|---|---|
| `answered_ja` | Karte wurde mit Ja beantwortet (nur Karten mit Wirkung `intern`), derselbe Weg wie `/hud/answer`; `reply` = Ergebnis |
| `answered_nein` | Karte wurde abgelehnt (bei jeder Wirkung erlaubt); `reply` = Ergebnis |
| `needs_confirm` | „Ja“ verstanden, aber die Karte wirkt physisch, nach außen oder auf Infrastruktur: **nichts wurde beantwortet**, die HUD-App muss den ausdrücklichen Tap zur Bestätigung einholen (dann `POST /hud/answer`) |
| `message` | keine Karte betroffen: das Gesagte ging wie bei `POST /` an den Agenten (gleiches Zeitbudget, gleiche Doppelfrage-Erkennung, späte Antwort nach Telegram); `reply` = Antwort, höchstens 400 Zeichen, ohne Markdown |
| `none` | nichts ausgeführt (leeres oder unklares Gesagtes); `transcript` zeigt, was verstanden wurde |

`transcript` ist der erkannte Text (höchstens 500 Zeichen); er und das Audio werden nicht
geloggt.

**Sicherheitsregeln:**

- Offene Karte: ohne `cardId` gilt die erste offene Karte des Feeds, mit `?cardId=` genau die
  auf der Brille gezeigte (ist sie nicht mehr offen, wird nichts entschieden).
- Nur sehr kurze, eindeutige Antworten zählen (höchstens 3 Wörter): Ja = ja, yes, okay,
  genehmigt, mach, freigeben; Nein = nein, no, stopp, ablehnen, abbrechen, „lehne ab“. Gemischtes
  („ja nein“, „nicht freigeben“) oder Unbekanntes entscheidet nichts (`none`).
- Ein ganzer Satz oder eine Frage (mehr als 3 Wörter oder mit „?“) ist keine Antwort, sondern
  geht als `message` an den Agenten; die Karte bleibt offen.
- Sprache bestätigt nie selbst eine Karte mit Wirkung nach außen, im Raum oder auf
  Infrastruktur (`needs_confirm`); „Immer erlauben“ gibt es per Sprache nie.
- Die Nie-Liste gilt unverändert: solche Aktionen bekommen nie eine Karte.

### `GET /health`

`{"ok":true}` ohne Token, ohne weitere Angaben.

## Grenzen

- Kein Streaming, keine Bilder, kein Push zur Brille: die Even-App fragt, Xaventra antwortet.
  Proaktive Meldungen kommen weiter über Telegram; die HUD-App holt sie per Long-Poll.
- Dieselbe Frage innerhalb von 30 s bekommt dieselbe Antwort (gewollt wegen der Doppel-Anfrage).
- Lange Aufgaben laufen weiter (höchstens 10 min), das Ergebnis kommt nur in Telegram.
- Ohne Telegram-Owner gibt es keine Nachlieferung und keine Kartenantworten.
- Die HUD-App verlangt bei *physischen* und *nach außen wirkenden* Karten einen zweiten Tap
  innerhalb von 4 s.
- Das Even-App-Protokoll ist nicht dokumentiert (Stand: Hermes-Plugin
  `kisaragi-mochi/hermes-even-ai-plugin` v0.2.0); ein App-Update kann es ändern.

## Abnahme

Automatisch (vitest, `src/channels/even-g2.test.ts`, `even-g2-voice.test.ts`, `even-g2-runtime.test.ts`):
ohne/falscher Token → 401 und keine Pipeline; doppelte Frage → ein Lauf; Antwort ≤ 400 Zeichen
ohne Markdown; Zeitbudget → Zwischenantwort + genau eine Nachlieferung; Worker startet nicht;
Fence → 503; Kartenantwort nur mit Token und nur einmal; Nie-Liste ohne Karte; kein „immer“;
Standard aus; Bindung nur `127.0.0.1`. Sprache: Token-Prüfung vor der Spracherkennung, WAV und
rohes PCM, Formatgrenzen (400/413/415), Zeitlimit (504), Ja/Nein-Erkennung, Karten mit Wirkung nie
per Sprache bestätigt, Freitext als Nachricht.

Mit echter Brille (Owner):

1. Log zeigt `[EvenG2] ✅ aktiv auf http://127.0.0.1:18790`; `ss -ltnp | grep 18790` zeigt nur
   `127.0.0.1:18790`.
2. Vom Laptop im Tailnet: `curl -i https://<main>.<tailnet>.ts.net:8790/hud` → 401;
   mit `-H "Authorization: Bearer $NOVA_EVEN_G2_TOKEN"` → 200 mit `status`.
3. „Hey Even, wie spät ist es?“ → Antwort auf der Brille; im Log genau **ein**
   `[Nova] [even-g2] Nachricht von even-g2:owner` für die Frage.
4. Eine lange Frage („Recherchiere …“) → Brille zeigt „Ich arbeite dran …“, das Ergebnis kommt
   in Telegram.
5. Eine echte Knopf-Karte offen lassen → erscheint in der HUD-App → Tap → Telegram-Karte zeigt
   „→ Ja“, `/gedanken` zeigt „angenommen“; zweiter Tap → „bereits beantwortet“.
6. Worker: auf ns1/ns2/NAS ist Port 18790 nicht offen.
7. Sprache: in der HUD-App eine kurze Frage sprechen → Antwort erscheint; bei offener Karte
   „ja“ bzw. „nein“ sprechen → Karte beantwortet bzw. (bei Wirkung nach außen) Bestätigungs-Tap
   verlangt.

Rückweg: `channels.evenG2.enabled=false` (oder Token entfernen) und Dienst neu starten;
`tailscale serve --https=8790 off`.
