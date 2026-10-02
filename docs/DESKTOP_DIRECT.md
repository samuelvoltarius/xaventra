# /desktop – Direktverbindung zu Xaventras Desktops

Alfred schaut aus Telegram direkt auf einen Desktop von Xaventra oder übernimmt
ihn — ohne Passworteingabe. Das VNC-Passwort bleibt auf dem Main; es taucht nie
im Chat, in einem Link, im Browser, in Logs, Karten oder im Zustand auf.

Standard: **aus** (`desktop.direct.enabled=false`). Worker (`NOVA_NODE_ONLY=true`)
starten nichts.

## Ablauf

1. `/desktop` in Telegram (nur Owner) → Liste der konfigurierten Desktops mit
   Knöpfen „👁 Ansehen“ / „🖱 Übernehmen“.
2. Knopfdruck → Xaventra schickt in den Privatchat einen **Einmal-Link**
   `https://<main>.<tailnet>.ts.net/desktop/s/<token>` (ohne Linkvorschau).
3. Link öffnen → Seite verbindet automatisch → noVNC im Browser, verbunden über
   den Gateway des Mains mit dem Desktop.
4. Ende: Fenster schließen, „Trennen“/„Zurückgeben“ auf der Seite, „↩️ Zurückgeben“
   unter der Telegram-Nachricht, oder Zeitlimit (`sessionMaxMinutes`, Standard 60).

| | Ansehen | Übernehmen |
|---|---|---|
| Bild | ja | ja |
| Tastatur, Maus, Zwischenablage → Desktop | **im Gateway verworfen** | erlaubt |
| Xaventras `desktop_input` auf diesem Desktop | läuft weiter | **pausiert** (bei `agentInput: true`) bis „Zurückgeben“/Sitzungsende |
| xvp (Neustart/Ausschalten über VNC) | verworfen | verworfen |

## Sicherheitsregeln (im Code fest)

- **Knöpfe** wie die Knopf-Karten (`src/core/approval-cards.ts`): `callback_data`
  ist `dk:<16 hex>` ohne Parameter, aufgelöst aus dem Speicher des Mains; nur
  eine numerische Owner-ID aus `channels.telegram.allowFrom` (dieselbe Prüfung
  `isCardOwner`); der erste Druck verbraucht alle Knöpfe dieser Auswahl. Links
  gehen nur in den Privatchat des drückenden Owners.
- **Einmal-Link**: 32 Zufallsbytes (base64url), gespeichert nur als SHA-256,
  gebunden an Desktop + Modus + Owner, höchstens 10 min gültig (auch wenn die
  Config mehr verlangt), genau einmal einlösbar, Vergleich in konstanter Zeit.
  Alles nur im Speicher: ein Daemon-Neustart macht alle Links ungültig.
- **GET prüft, POST löst ein**: `GET /desktop/s/<token>` verbraucht nichts und
  schickt ein selbst absendendes Formular; erst `POST` löst ein. So kann eine
  Linkvorschau oder ein Prefetcher den Link nie „verbrennen“.
- **Sitzung**: Einlösen erzeugt eine Sitzungs-ID (gleiche Stärke, nur gehasht),
  gültig für genau eine WebSocket-Verbindung innerhalb von 60 s. Trennung =
  Sitzungsende; erneut verbinden geht nur mit neuem Link.
- **Quelle**: nur Loopback (`tailscale serve` auf dem Main) oder 100.64.0.0/10
  (Tailnet), sonst 403. WebSocket und POST zusätzlich nur gleicher Origin.
  Nach 30 ungültigen Versuchen pro Minute und IP: 429.
- **Audit** `.nova-data/desktop-sessions.jsonl` (0600): Link ausgegeben,
  abgelehnt (Grund, Quell-IP), Sitzung Start/verbunden/Ende (wer, Desktop,
  Modus, Quell-IP, Dauer, Grund). Nie Token, Sitzungs-ID oder Passwort.

## Passwort: warum der Gateway selbst anmeldet

Gewählt: **RFB-VNC-Auth serverseitig im Gateway**. Der Gateway spricht mit dem
echten VNC-Server RFB 3.7/3.8, wählt VNC-Auth (Typ 2), liest das Passwort erst
beim Verbinden aus `vncPasswordFile`, beantwortet die DES-Challenge und
überschreibt den Puffer danach. Dem Browser bietet er ausschließlich
Sicherheitstyp **None** an — noVNC fragt nie nach einem Passwort, und es gibt
keinen Weg, es vom Gateway anzufordern.

Verworfen:
- *Passwort an noVNC übergeben* (URL-Parameter, Seite, `credentials`): das
  Passwort stünde im Browser (Verlauf, Speicher, Erweiterungen, Screenshots).
- *VNC ohne Passwort hinter dem Tailnet*: dann wäre jeder Prozess bzw. jedes
  Tailnet-Gerät mit Zugriff auf den Port ohne zweite Hürde am Desktop.

Grenzen der Variante: VNC-Auth ist schwach (DES, 8 Zeichen) — sie ist hier nur
die zweite Hürde; die eigentliche Absicherung sind „VNC nur auf 127.0.0.1 bzw.
nur tailscale0“, Tailnet und Einmal-Link. Der Gateway fordert vom VNC-Server
immer eine geteilte Verbindung (`shared`), damit Alfred keine andere Sitzung
(z. B. Xaventras eigene) hinauswirft. Single-DES fehlt im OpenSSL-3-Standard-
provider; der Gateway nutzt 2-Key-3DES mit K1 = K2 (mathematisch identisch).

Fehlermeldungen sind allgemein („VNC-Anmeldung fehlgeschlagen“, „Desktop nicht
erreichbar“) und enthalten nie das Passwort; die Tests prüfen das mit einer
Testpasswort-Attrappe gegen alle Antworten, Logs, Audit und Telegram-Text.

## Konfiguration

```json
"desktop": {
  "direct": {
    "enabled": true,
    "publicBaseUrl": "https://main.example.com",
    "host": "127.0.0.1",
    "port": 18793,
    "linkTtlMinutes": 10,
    "sessionMaxMinutes": 60,
    "novncDir": "/usr/share/novnc",
    "desktops": [
      { "id": "spark", "label": "Spark-Workstation", "target": "tcp://127.0.0.1:5900",
        "vncPasswordFile": "/etc/xaventra/vnc-spark.pass", "agentInput": true },
      { "id": "lab", "label": "Labor-VM", "target": "tcp://100.64.0.20:5901",
        "vncPasswordFile": "/etc/xaventra/vnc-lab.pass" }
    ]
  }
}
```

| Feld | Bedeutung |
|---|---|
| `publicBaseUrl` | HTTPS-Adresse aus `tailscale serve` (Pflicht, nur `https://`) |
| `host`/`port` | Listener des Gateways, Standard `127.0.0.1:18793` |
| `linkTtlMinutes` | Linkgültigkeit, höchstens 10 |
| `sessionMaxMinutes` | hartes Sitzungsende, 1–240, Standard 60 |
| `novncDir` | Verzeichnis mit `core/rfb.js`; ohne Angabe `/usr/share/novnc`, dann `@novnc/novnc` aus node_modules |
| `desktops[].target` | `tcp://host:port` (RFB direkt, empfohlen) oder `ws://`/`wss://` (websockify) |
| `desktops[].vncPasswordFile` | Klartext-Passwortdatei auf dem Main, reguläre Datei, `0600`, kein Symlink |
| `desktops[].agentInput` | `true` = Xaventras `desktop_input` wirkt auf diesem Desktop; „Übernehmen“ pausiert ihn |
| `desktops[].allowControl` | `false` = nur „Ansehen“ |

Unvollständige Config (kein https-URL, keine gültigen Desktops) → nichts startet,
`/desktop` meldet „aus“.

## Host-Einrichtung

### 1. noVNC-Client auf dem Main

Der Gateway lädt noVNC nie zur Laufzeit von einem CDN. Er liefert die Dateien
aus `novncDir` selbst aus (nur `.js/.css/.svg/.png/.ico/.woff*/.ttf`, kein
Pfad außerhalb). Bereitstellen auf dem Main (Debian/Ubuntu):

```bash
sudo apt install novnc      # legt /usr/share/novnc/core/rfb.js an
```

Alternative ohne apt: `@novnc/novnc` (ES-Module) in ein eigenes Verzeichnis
entpacken und `novncDir` darauf setzen. Es ist bewusst **keine** npm-Abhängigkeit
von Xaventra. Fehlt noVNC, antwortet der Link mit 503 und bleibt gültig.

### 2. VNC-Server nur lokal bzw. nur Tailnet

Labor-VM (`xaventra-lab`, XFCE auf `:1`), Beispiel x11vnc:

```bash
# Passwortdatei für x11vnc (verschleiert) und dieselbe Phrase als Klartext auf dem Main
x11vnc -storepasswd                      # → ~/.vnc/passwd
x11vnc -display :1 -rfbauth ~/.vnc/passwd -rfbport 5901 -shared -forever \
       -listen 100.64.0.20               # nur die Tailscale-Adresse, oder:
       # -localhost                      # nur 127.0.0.1, wenn der Main auf derselben Maschine läuft
```

Zusätzlich Firewall: Port 5901 nur auf `tailscale0` und nur vom Main:

```bash
sudo ufw allow in on tailscale0 from <tailnet-ip-des-mains> to any port 5901 proto tcp
sudo ufw deny 5901/tcp
```

Spark-Workstation (Main selbst): VNC nur auf `127.0.0.1` (`-localhost`),
`target: "tcp://127.0.0.1:5900"`, `agentInput: true`.

### 3. Passwortdatei auf dem Main

```bash
sudo install -d -m 0700 -o <daemon-user> /etc/xaventra
sudo install -m 0600 -o <daemon-user> /dev/null /etc/xaventra/vnc-lab.pass
sudoedit /etc/xaventra/vnc-lab.pass      # eine Zeile: das VNC-Passwort (max. 8 Zeichen wirksam)
```

Nie in die Config, `.env`, Git oder den Chat. Der Gateway verweigert Dateien mit
Gruppen-/Fremdrechten und Symlinks.

### 4. websockify (nur falls nötig)

Mit `tcp://` braucht es **kein** websockify — der Gateway spricht RFB direkt.
Nur wenn ein Desktop ausschließlich per WebSocket erreichbar ist:

```bash
websockify 127.0.0.1:6080 127.0.0.1:5901   # target: ws://127.0.0.1:6080
```

### 5. tailscale serve auf dem Main

```bash
sudo tailscale serve --bg --https=443 --set-path=/desktop http://127.0.0.1:18793/desktop
tailscale serve status
```

Nur `serve` (Tailnet), **nie** `funnel` (öffentlich). `publicBaseUrl` =
`https://<main>.<tailnet>.ts.net`. Die Pfade des Gateways beginnen alle mit
`/desktop/`; die Seite nutzt relative Pfade.

## Rückweg

1. `desktop.direct.enabled=false` (oder Abschnitt entfernen), Daemon neu starten
   → kein Listener, `/desktop` meldet „aus“, alle Links/Sitzungen sind weg und
   eine Pause von `desktop_input` ist aufgehoben (auch beim normalen Stopp).
2. `sudo tailscale serve --https=443 --set-path=/desktop off`
3. Optional VNC-Server/websockify stoppen und Passwortdateien löschen.

## Grenzen

- Ein Link = eine Verbindung. Netzabbruch beendet die Sitzung; neuer Link über `/desktop`.
- Die Pause betrifft Xaventras `desktop_input` (Main-Desktop mit `agentInput`).
  Andere Desktops ohne Xaventra-Eingabewerkzeug brauchen keine Pause.
- Nur RFB 3.7/3.8 mit Sicherheitstyp None oder VNC-Auth; VeNCrypt/TLS/Apple-Auth
  werden nicht unterstützt (Transport ist ohnehin WireGuard/Tailscale bzw. Loopback).
- Die Desktop-App (System › Desktops) holt denselben Einmal-Link über
  `POST /api/desktop/direct/:id/link` (nur Owner-Token, Audit `desktop:…`). Der
  Hauptprozess öffnet ihn in einem eigenen Fenster mit flüchtiger Sitzung; der
  Renderer sieht den Link nie. Fenster schließen = Sitzung beendet. Im Browser
  öffnet die gemeinsame Oberfläche den Link in einem neuen Tab. Andere Kanäle
  zeigen nur die Liste.
- Die Telegram-Nachricht mit dem (verbrauchten) Link bleibt im Chat stehen; der
  Link ist nach Nutzung oder 10 min wertlos.
