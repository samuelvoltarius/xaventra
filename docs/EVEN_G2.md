# Even G2 — Smartglasses als Kanal

Autonomie-Plan Phase 5a. Die Brille spricht direkt mit Xaventra:

1. **„Hey Even“-Agent** — die Even-App leitet Sprachfragen an Xaventra weiter, die Antwort
   erscheint als Text auf der Brille.
2. **HUD-Feed** — eine kleine Even-Hub-App (`apps/even-g2/`) zeigt, woran Xaventra gerade
   arbeitet, und offene Knopf-Karten. Tap = Ja, Doppeltap = Nein.

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

   `allowOrigins` leer = CORS-Antwort `*` nur für `/hud` und `/hud/answer` (die Even-Hub-App
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

7. **HUD-App** (`apps/even-g2/README.md`): in `app.json` die Tailnet-Adresse in die
   `network`-Whitelist eintragen, per `evenhub qr` aufs Telefon laden, in der App Adresse +
   Token speichern.

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

Automatisch (vitest, `src/channels/even-g2.test.ts`, `even-g2-runtime.test.ts`):
ohne/falscher Token → 401 und keine Pipeline; doppelte Frage → ein Lauf; Antwort ≤ 400 Zeichen
ohne Markdown; Zeitbudget → Zwischenantwort + genau eine Nachlieferung; Worker startet nicht;
Fence → 503; Kartenantwort nur mit Token und nur einmal; Nie-Liste ohne Karte; kein „immer“;
Standard aus; Bindung nur `127.0.0.1`.

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

Rückweg: `channels.evenG2.enabled=false` (oder Token entfernen) und Dienst neu starten;
`tailscale serve --https=8790 off`.
