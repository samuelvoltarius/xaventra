# Voice I/O Guide

Speech input and output for Nova.

---

## Lokaler Sprachdienst (2.86, Paket O)

Der empfohlene Weg: der Werkzeugkasten-Eintrag **„Lokaler Sprachdienst Deutsch“**
(`sprachdienst:de`). Er installiert ein fest eingetragenes Bündel (feste URLs,
Größen, sha256, Lizenzen in `src/voice/voice-artifacts.ts`): Silero VAD,
Nemotron 3.5 ASR Streaming 0.6B INT8 (560 ms), Piper „Ramona“ (Standard) und
„Thorsten“, sherpa-onnx für Node. Danach startet der Xaventra-Dienst des
Knotens den Sprachdienst `xaventra-voice` (Port 18795, nur eigenes Netz) und
der KI-Scanner findet ihn im Mesh.

- **Telegram:** Sprachnachrichten werden über den gefundenen Dienst verstanden;
  Antwort als Text, auf Wunsch zusätzlich als Sprachnachricht („antworte per
  Sprache“, „ab jetzt immer per Sprache“, „wieder per Text“ oder Schalter in der App).
- **App → Anrufen:** Freisprechen ohne Taste (VAD mit 300 ms Pre-Roll, Partials,
  Dazwischenreden bricht ab). Mikrofon braucht HTTPS, z. B. `tailscale serve`
  vor dem Dashboard; den `.ts.net`-Namen in `dashboard.publicHosts` eintragen.
- **Web-App:** Manifest + Service-Worker (nur statische Seitendateien im Cache,
  nie API-Antworten oder Token) – auf dem Handy „Zum Startbildschirm“.

Schnittstelle des Dienstes: `src/voice/voice-contract.ts`.

---

## Echt telefonieren (2.87, Paket P)

### Antwort wortweise

Im Anruf (App und Telefon) wird die Antwort gesprochen, **während** die Pipeline
noch arbeitet. Gedächtnis, Werkzeuge und Regeln gelten unverändert:

- Nur die Modellrunden, die der Agenten-Runner ausdrücklich als „sprechbar“
  markiert (erste Runde, Folgerunden nach Werkzeugen), streamen ihren sichtbaren
  Text in den Phrasenpuffer (`src/voice/voice-turn-stream.ts`). Prüf-, Reparatur-
  und Zusammenfassungsaufrufe sprechen nie mit.
- Für genau diese Aufrufe gilt request-lokal „ohne Denken“ (`enable_thinking=false`
  bei Qwen/vLLM, `reasoning_effort=none`); keine globale Änderung, andere Kanäle
  sehen nichts davon.
- Der erste ganze Satz geht sofort an die Sprachausgabe; was währenddessen
  entsteht, wird gebündelt (≈120 Zeichen) nachgeschoben.
- Werkzeugrunde → einmal „Ich schau kurz nach.“ statt Stille.
- Ändern die Prüfungen der Pipeline die Antwort nachträglich, sagt sie ehrlich
  „Korrektur: …“; ergänzen sie nur etwas, wird nur der Rest gesprochen.
- Dazwischenreden bricht Strom, Werkzeugrunde und Sprache ab. Schon ausgeführte
  Werkzeuge werden **nicht** rückgängig gemacht, sondern genannt („Schon erledigt
  war: … – das bleibt so.“), auch zu Beginn der nächsten Antwort.

### Kurzantworten

Uhrzeit, Datum, „läuft alles?“ und – wenn `OPENWEATHER_API_KEY` eingerichtet ist –
das Wetter kommen ohne Modellrunde (`src/voice/voice-quick.ts`). Schalten
(„Mach die Stehlampe an“) geht wie bisher deterministisch an `/geraete` und legt
eine Vorschau-Karte an. Neu: im **App-Anruf** fragt sie „Soll ich das machen? Sag
ja.“ – das gesprochene „ja“ gilt nur, wenn

1. der Anruf als Owner angemeldet ist (App-Anruf mit Owner-Ticket) **und**
2. die Karte noch offen ist und genau die vorgelesene Aktion beschreibt.

Am **Telefon** gilt ein gesprochenes „ja“ nie als Freigabe (Rufnummern lassen sich
fälschen); die Karte bleibt in App und Telegram.

### Telefon einrichten – direkt (Standard)

App → **Verbindungen → Telefon** oder Telegram `/telefon`. Drei Angaben reichen:

| Feld | Zadarma |
|---|---|
| Server | `sip.zadarma.com` |
| Login | deine SIP-Kennung (Zahl, im Zadarma-Konto unter „Einstellungen → SIP-Verbindung“) |
| Passwort | dein SIP-Passwort – nur in der App oder per `/telefon passwort …` |

Standard für Zadarma: **TLS, Port 5061** (Zadarma-Doku „FreePBX PJSIP setup“:
5060 Standard, 5061 mit Verschlüsselung). Andere Anbieter: UDP 5060, frei änderbar.
Optional: eigene Rufnummer, Owner-Nummern (wer anrufen darf), Anzeigename.

- Das Passwort liegt nur in der Secrets-Ablage
  (`.nova-data/secrets/connections/c-telefon.json`, 0600) – nie in der
  Konfiguration, nie in einer Antwort, nie im Log (`/telefon passwort` wird wie
  Anmelde-Befehle nicht protokolliert). Nachricht danach im Chat löschen.
- **„Anmeldung prüfen“** fragt beim Anbieter nach, ob der Zugang stimmt
  (REGISTER ohne Contact = reine Abfrage nach RFC 3261 §10.2.3: ändert nichts,
  andere Telefone bleiben angemeldet). Ergebnis in Alltagssprache: „Telefon
  angemeldet …“ bzw. „Anmeldung bei Zadarma hat nicht geklappt — Passwort prüfen.“
- Ohne eigene Rufnummer: „Für Anrufe von außen fehlt noch eine Telefonnummer im
  Zadarma-Konto.“ Ein SIP-Login allein ist vom Festnetz nicht erreichbar.
- **Noch offen:** Gespräche direkt aus Xaventra brauchen einen SIP/RTP-Baustein
  (siehe Entscheidung unten). Bis dahin: Login prüfen geht, telefonieren über
  eine Telefonanlage.

### Telefon über eine vorhandene Telefonanlage (Asterisk)

Die Anlage bleibt für SIP/RTP zuständig; Xaventra bekommt das Gespräch nur lokal
per **AudioSocket** (`src/voice/telefon-bridge.ts`):

1. Die Anlage fragt `GET http://127.0.0.1:18797/anruf?nummer=<Anrufer>` und
   bekommt eine Einmal-Kennung (30 s). Ob die Nummer eine Owner-Nummer ist,
   entscheidet nur Xaventra.
2. Die Anlage verbindet `AudioSocket(<Kennung>,127.0.0.1:18796)`.
   Owner-Nummer → Gespräch. Fremde oder unterdrückte Nummer → ein höflicher Satz,
   dann auflegen (kein Zuhören, keine Pipeline).

Beide Ports lauschen **nur auf 127.0.0.1** und **nur**, wenn der Owner Weg
„Telefonanlage“ gewählt, das Telefon eingeschaltet und mindestens eine
Owner-Nummer eingetragen hat. Ohne das lauscht nichts und nichts ruft an.

**Freischalten in der Anlage (macht der Owner selbst, Xaventra liest/ändert keine
Anlagen-Dateien).** Vorlage auch in der App unter „Vorlage für deine
Telefonanlage“ bzw. `/telefon vorlage`. Minimal für eine chan_sip-Anlage, die
eingehende Anrufe heute im Kontext `[incoming]` per `Dial(SIP/livekit-sip/…)` an
einen lokalen Dienst weiterreicht:

```ini
; extensions.conf — neuer Kontext
[xaventra]
exten => s,1,NoOp(Anruf an Xaventra von ${CALLERID(num)})
 same => n,Set(XAVENTRA_ID=${CURL(http://127.0.0.1:18797/anruf?nummer=${URIENCODE(${CALLERID(num)})})})
 same => n,GotoIf($["${XAVENTRA_ID}" = ""]?ende)
 same => n,Answer()
 same => n,AudioSocket(${XAVENTRA_ID},127.0.0.1:18796)
 same => n(ende),Hangup()

; in [incoming]: die Zeile mit Dial(SIP/livekit-sip/...) ersetzen durch
;   same => n,Goto(xaventra,s,1)
```

Danach `asterisk -rx "dialplan reload"`. Voraussetzungen: Module `app_audiosocket`
und `func_curl` (`asterisk -rx "module show like audiosocket"`). Kein Port nach
außen, keine Firewall-Änderung. Ist der Anbieter-Trunk nicht registriert
(`sip show registry` → „No Authentication“), kommt kein Anruf an – das ist ein
Thema des Anbieter-Zugangs (Passwort/Kennung beim Anbieter prüfen).

**Ausgehend (optional):** An Owner-Nummern direkt, an jede andere Nummer nur per
Karte (Wirkung „extern“: kostet Guthaben). Gewählt wird über **ARI** der Anlage
auf `http://127.0.0.1:8088` (in `http.conf` nur `bindaddr=127.0.0.1`, in
`ari.conf` ein eigener Benutzer). ARI-Benutzer, -Passwort und Ausgangsleitung
(z. B. `SIP/{nummer}@meinanbieter`) trägt der Owner in den Telefon-Einstellungen
ein; der Rückweg läuft über den Kontext `[xaventra-raus]` aus der Vorlage.

### Sicherheit am Telefon

- Rufnummern sind fälschbar: Anrufe laufen im Raum „Telefon“ mit **Nutzer-**,
  nicht Owner-Rechten (`telefon:<nummer>`); Wirkungen nur über Karten.
- Im Log steht nie die volle Rufnummer, nie ein Passwort.
- Maximale Gesprächsdauer 30 Minuten; Kennungen gelten einmal und 30 Sekunden.

### Entscheidung SIP/RTP-Baustein (offen für die Hauptsitzung)

Geprüft (Oktober 2026): Es gibt keine gepflegte, reine Node-Bibliothek für
SIP **mit** RTP über UDP. SIP.js und JsSIP setzen SIP über WebSocket und WebRTC-
Medien voraus (in Node nur mit nativen Zusatzmodulen); drachtio-srf braucht einen
eigenen C++-Server und einen Medienserver. Ein selbstgebauter SIP/RTP-Stack ist
ausgeschlossen. Darum heute: Asterisk-Weg ohne neue Abhängigkeit, direkter Weg mit
Login-Prüfung und vorbereiteter Schnittstelle. Für den direkten Gesprächsweg
schlagen wir einen lokal gesteuerten, BSD-lizenzierten SIP-Client (z. B. baresip
über seine lokale Steuerschnittstelle, als Werkzeugkasten-Eintrag) oder eine
mitgelieferte Asterisk-Instanz vor.

---

## Requirements

- Edge-TTS (included)
- Whisper (for transcription)
- ffmpeg (for audio conversion)

---

## Enable Voice

```json
{
  "voiceEnabled": true,
  "voiceLanguage": "de-DE"
}
```

---

## Voice Output (TTS)

Nova uses Microsoft Edge TTS:

### Available Voices

| Voice | Language |
|-------|----------|
| `de-DE-ConradNeural` | German (DE) |
| `de-AT-JonasNeural` | Austrian German |
| `en-US-GuyNeural` | English (US) |
| `en-GB-RyanNeural` | English (UK) |

### Usage

```typescript
import { speak } from './tools/voice-output'

await speak("Hallo, ich bin Nova!", "de-DE-ConradNeural")
```

---

## Voice Input (STT)

Whisper transcribes voice messages:

### Local Whisper

```bash
pip install openai-whisper
```

Models:
- `tiny` - Fastest, less accurate
- `base` - Good balance
- `small` - Better accuracy
- `medium` - High accuracy

### OpenAI Whisper API

```json
{
  "openaiApiKey": "sk-..."
}
```

---

## Telegram Voice

1. Send voice message
2. Nova transcribes
3. Nova processes text
4. Nova responds with voice

---

## Troubleshooting

### No audio output?
- Check `voiceEnabled: true`
- Verify ffmpeg installed

### Transcription fails?
- Install Whisper locally
- Or add OpenAI API key

### Wrong language?
- Set `voiceLanguage` correctly
- Use language-specific voice
