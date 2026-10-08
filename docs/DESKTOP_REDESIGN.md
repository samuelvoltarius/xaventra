# Xaventra Desktop – Neugestaltung (eine Oberfläche)

Xaventra arbeitet selbstständig. Die Oberfläche ist deshalb ein **Fenster zum
Mitschauen und Knöpfe-Drücken**, kein Bedien-Cockpit. Sie zeigt, was sie tut,
woran sie arbeitet und was sie sich merkt – und fragt nur dort, wo eine
Knopf-Karte auf Alfred wartet.

Es gibt **eine** Oberfläche (`desktop/renderer`): Die Desktop-App lädt sie aus
dem Paket, der Main liefert dieselben Dateien im Browser aus
(`http://127.0.0.1:3011/`). Nur die Transportschicht unterscheidet sich
(`preload.cjs` in Electron, `bridge.js` im Browser).

## Hauptbereiche

```
┌────┬──────────────────────────────────────────────────────────────┐
│ X  │  Freitag, 2. Oktober                                  [⟳]    │
│    │  Guten Morgen                                                │
│Heute  Xaventra arbeitet selbstständig …                           │
│ (2)│ ┌──────────────────────────────────────────────────────────┐ │
│Unter│ │● Mission: Sicherung prüfen — Schritt 2/3     [verbunden]│ │
│halt.│ └──────────────────────────────────────────────────────────┘ │
│Arbeit ┌─ Braucht dich · 2 ──────────────┐ ┌─ Gedanken ──────────┐ │
│System │ Bildbetrachter installieren      │ │ ! Prüfsumme …        │ │
│Gedächt│ Nur Xaventra selbst · bis 05:51  │ │ ~ Labor-VM gestoppt  │ │
│    │ │ [Ja] [Nein] Später  Immer erl.   │ │ ✓ Dienst geheilt     │ │
│    │ └──────────────────────────────────┘ │ ✕ verworfen …        │ │
│Mehr│ ┌─ Morgenbericht (Vorschau) ───────┐ └─────────────────────┘ │
│Einst│ │ 4 erledigt · 1 repariert · …     │ ┌─ Zuletzt entschieden┐ │
└────┴──────────────────────────────────────────────────────────────┘
```

| Bereich | Inhalt | Quelle (vorhandenes Modul) |
|---|---|---|
| **Heute** (Start) | Was sie gerade tut (inkl. Live-Schritt eines laufenden Auftrags), Warteschlange; offene Knopf-Karten mit den Knöpfen der Karte; Vorschau des nächsten Morgen-/Abendberichts; Gedanken (auch verworfene); zuletzt entschieden | `now-view` (`collectJetzt`, `collectGedanken`), `approval-cards`, `planner/briefing` (`buildBriefing`, nur lesend), `GET /api/desktop/fortschritt` |
| **Unterhaltung** | Räume (auch umbenennen), Chat, Projektordner, Wissenspakete, Modell je Raum (unverändert funktional) | `/api/desktop/rooms*` |
| **Anrufen** | Sprachanruf mit Xaventra (nur Web/Browser) | `anruf.js` |
| **Arbeit** | Reiter Missionen (Schritte, Versuch, Übergabe), Aufträge (aktiv + Verlauf, Live-Schritt), **Aktivität** (was sie gerade und im Hintergrund tut), Delegationen mit Prüfung, Verantwortungen (erfüllt/verletzt), „macht sie inzwischen selbst“ (Vertrauensleiter + dauerhafte Erlaubnisse), Geplant (Planer-Jobs) | `responsibility-runtime` (`readArbeitState`), `autonomous-executor`, `delegation`, `action-policy`, `planner`, `sehen.js` |
| **Geräte (System)** | Reiter Übersicht: Knoten mit Messwerten und 24-h-Verlauf, Erreichbarkeit, Vorausschau (Platte/RAM, Zertifikate, Sicherungen), Nachtwache, Desktops (Ansehen/Übernehmen im eigenen Fenster), VMs, Modelle; Reiter **Bildschirme** (vormals „Ihr Computer“) | `watch` (`getWatchOverview`, Messproben), `desktop-direct`, `infra/proxmox` (`readVmsInventory`), Modellkatalog, `sehen.js` |
| **Verbindungen** (2.85) | Gefunden / Möglich / Verbunden für Dienste (geprüfter Katalog, MCP-Verzeichnis), KI-Modelle (lokal gefunden, Cloud per API-Key oder erlaubter Konto-Anmeldung) und Hilfsdienste (SearXNG) — eine Stelle | `connections-view` (`collectConnections`), Quelle `ki-modelle` aus `llm-connections` (`connection-docks.ts`) |
| **Gedächtnis** | Reiter Entscheidungen (kausales Gedächtnis), Prozeduren, Werkzeuge der Schmiede (ohne Code), Wissen (Wissenspakete, bestätigte Fakten) | `decisions`, `skill-builder`, Memory-Katalog/-Governance |
| **Mehr** | Werkzeugkasten, Regeln, Belege & Reparaturen (Ergebnisakte, Doctor mit geprüfter Patch-Freigabe), Spezialisten (mit „Verbindung prüfen“), Studio, Abwehr, Knoten aufnehmen, Erster Start | bestehende Desktop-Endpunkte |
| **Einstellungen** | Verbindung, Token, Farbschema (System/Hell/Dunkel), Unterhaltung, Projektordner | lokal (Electron) bzw. Browser |

Zur Navigation (2.89.4): Die Hauptleiste hat sieben Ziele plus „Mehr“ und
„Einstellungen“. Die IDs `heute`, `chat`, `arbeit`, `system`, `gedaechtnis`,
`mehr`, `settings`, `trust` bleiben für die UI-Prüfung erhalten. Alte Links
(`computer`/`bildschirme`, `aktivitaet`, `memory`) landen im passenden Reiter.
Werkzeugkasten und Regeln stehen unter „Mehr“ und nicht mehr in der Hauptleiste
(damit geht der Auftrag „wenige Hauptbereiche“ vor die Owner-Entscheidung
02.10.; die Karten-Freigabe für Installieren/Entfernen bleibt unverändert).

## Neue Lese-Endpunkte (nur Owner)

Alle in `src/desktop/desktop-api.ts`, gebaut in `src/desktop/desktop-views.ts`.
Sie lesen nur vorhandene Module, kürzen Texte, schwärzen Geheimnisse
(`redactSecrets`) und antworten `403` ohne Desktop-Owner-Token
(`NOVA_DESKTOP_API_TOKEN`).

| Endpunkt | Zweck |
|---|---|
| `GET /api/desktop/heute` | Jetzt, offene/entschiedene Karten, Berichtsvorschau, Gedanken |
| `GET /api/desktop/arbeit` | Missionen, Aufträge, Delegationen, Verantwortungen, Vertrauen, Geplant |
| `GET /api/desktop/system` | Wächter-Übersicht, Messverlauf (≤ 48 Punkte/Knoten/24 h), Desktops |
| `GET /api/desktop/system/vms` | Proxmox-Inventar (lesend, wie `/vms`) |
| `GET /api/desktop/gedaechtnis` | Entscheidungen, Werkzeuge (ohne Code/Tests) |
| `POST /api/desktop/karten/:id/antwort` | Antwort auf eine Karte – **über `answerApprovalCard`** mit dem Einmal-Token der Karte und der Owner-ID aus `channels.telegram.allowFrom` (wie Telegram und Even G2); der erste Druck verbraucht alle Knöpfe |
| `POST /api/desktop/direct/:id/link` | Einmal-Link von Desktop-Direkt (derselbe Speicher, dieselben Regeln wie der Telegram-Knopf; Audit „desktop:…“) |

Keine zweite Freigabe-Logik: Die App kennt nur die Antworten, die die Karte
selbst anbietet (`antworten`), nie die Knopf-Tokens. „Immer erlauben“ fragt in
der App einmal nach. Der Einmal-Link für noVNC erreicht den Renderer nie: Der
Hauptprozess holt ihn, prüft ihn (nur `https`, nur `/desktop/s/<token>`) und
öffnet ein eigenes Fenster mit eigener, flüchtiger Sitzung, ohne Preload und
ohne Berechtigungen. Fenster schließen = Sitzung beendet (eine Übernahme gibt
Xaventras Eingaben wieder frei). Eingebettet als `iframe` geht nicht – der
Gateway sendet bewusst `frame-ancestors 'none'`.

## Was verschoben wurde (und warum)

| Vorher | Jetzt | Warum |
|---|---|---|
| Spezialisten (Bot-Profile, Hermes/OpenClaw) als Hauptpunkt | Mehr › Spezialisten | Xaventra zieht Spezialisten selbst hinzu; im Alltag nicht nötig. Server-Endpunkte bleiben. |
| Studio-Module | Mehr › Studio | Startet nur Räume; kein täglicher Blick nötig. |
| Defense mit Red-Team-Knopf | Mehr › Abwehr | Ein Selbsttest-Knopf ist Bediener-Arbeit; bleibt erreichbar. |
| Evidence/Trust | Mehr › Belege & Reparaturen | Nachweise für Fachleute; die geprüfte Patch-Freigabe bleibt dort. |
| Xaventra Nodes (Inventar + Aufnahme) | Knoten-Zustand unter System, Aufnahme unter Mehr | Zustand ist Mitschauen, Aufnahme ist Einrichtung. |
| Gedächtnis (Assets + Fakten) | Gedächtnis › Wissen | Neben Entscheidungen und Werkzeugen. |
| Aktivität (2.88) | Arbeit › Aktivität | Was sie tut, gehört zur Arbeit – ein Hauptbereich weniger. |
| Ihr Computer (2.88) | Geräte › Bildschirme (du-Form: „Dein Computer“) | Bildschirme sind ein Gerät wie Knoten und VMs. |
| Werkzeugkasten (2.85) | Mehr › Werkzeugkasten | Seltene Aktion; Hauptleiste bleibt kurz (Auftrag 2.89.4). |
| Regeln (2.88) | Mehr › Regeln | Klartext-Regeln braucht man selten im Alltag. |
| Inspector „Kontrollzentrum“ | Seitenleiste „Was gerade passiert“ nur in der Unterhaltung | Weniger Technik (Epochen, Router-Samples) im Blick. |

## Was entfällt

- **Das alte Browser-Dashboard** (`src/dashboard/public`, ~4 200 Zeilen) und
  seine rund 70 Sonder-Endpunkte (`/api/status`, `/api/config`, `/api/memory*`,
  `/api/graph`, `/api/logs`, `/api/proposals`, `/api/scheduler`, `/api/mesh/*`,
  …) samt WebSocket-Live-Feed. Gründe: zweite Oberfläche neben der App
  (Doppelung), Bediener-Cockpit (Konfiguration roh bearbeiten, Graph
  zurücksetzen, Speicher löschen, Selbst-Updates freigeben am Karten-Mechanismus
  vorbei), eigene Doppel-Endpunkte (u. a. `GET /api/tasks` war zweimal
  registriert; `PUT /api/core-facts` wurde aufgerufen, existierte aber nicht;
  `/api/mesh/bundle` konnte der Abrufbefehl ohne Token gar nicht laden).
  Was davon sinnvoll war, steckt jetzt in der gemeinsamen Oberfläche:
  Status/Knoten → System, Chat → Unterhaltung, Trust → Belege, Scheduler →
  Arbeit › Geplant, Speicher/Fakten → Gedächtnis › Wissen.
- **Der Next.js-Client** `dashboard/` (`@xaventra/legacy-dashboard`): wurde
  nie vom Main ausgeliefert, sprach mit einem nicht mehr existierenden
  Clawdbot-Gateway (`192.0.2.12:18789`), rief `/api/memory` ohne Route auf und
  zeigte fest „Brutus“. Mit ihm entfallen der CI-Job `legacy-dashboard` und die
  `dashboard:*`-Skripte.
- Die Status-Hooks der Pipeline ins alte Dashboard (`updateNovaStatus`,
  geschätzte Token-„Kosten“): ohne Abnehmer; „was sie gerade tut“ kommt jetzt
  aus `now-view`.

## Geschmacksentscheidungen (änderbar)

| Entscheidung | Wo ändern |
|---|---|
| Startbereich „Heute“ statt Unterhaltung | `state.section` in `renderer/app.js` |
| Ruhige Slate-Töne, ein Akzent Blau (`#2F5FD0` hell / `#7DA4FF` dunkel), Grün/Orange/Rot nur für Zustände | Tokens oben in `renderer/styles.css` |
| Systemschrift (Segoe UI Variable / system-ui), keine Webfonts | `:root` in `styles.css` |
| Linke Leiste mit Symbol + Beschriftung, Zähler offener Karten an „Heute“ | `NAV_MAIN`, `.rail` |
| Karten-Knöpfe: „Ja“ gefüllt, „Nein“ umrandet, „Später“/„Immer erlauben“ als Textknopf; „Immer erlauben“ mit Rückfrage | `askCard`, `answerCard` |
| Wirkung farbig am linken Kartenrand (intern blau, VMs violett, Raum/außer Haus orange) | `.ask-card.wirkung-*` |
| Bericht als Vorschau „seit dem letzten Bericht“, Morgen- vor 14 Uhr, sonst Abendbericht | `previewReport` |
| Gedanken: 12 sichtbar, Rest über „Alle zeigen“ | `heuteView` |
| Aktualisierung alle 20 s (nur sichtbare Ansicht + Zähler) | `startRefresh` |
| Sprache „sie“ für Xaventra, „du“ für Alfred | Texte in `app.js` |

## Prüfung

- `npm run test:desktop` – Hauptprozess (Link nur im Hauptprozess, Link-Prüfung,
  Farbschema, keine Punkt-Segmente) und Browser-Transport (`bridge.js`).
- `npx vitest run src/desktop src/dashboard` – nur Owner, keine Geheimnisse in
  Karten/Antworten, Karten nur über `answerApprovalCard`, Desktop-Direkt-Link,
  HTTP-Auslieferung (Token-Pflicht, keine Daten/Token in den Dateien, keine
  Alt-Endpunkte, Host/Origin-Sperre).
- `npm run check:desktop-ui` – gepacktes Electron gegen die Attrappe
  (`scripts/fixtures/desktop-views.mjs`): Heute zuerst, Karten über den
  Karten-Endpunkt, alle Bereiche, Renderer bekommt keinen Link, gesperrte
  Ansichten ohne Owner-Token.
- `node scripts/preview-desktop-ui.mjs` – dieselbe Oberfläche im Browser mit
  erfundenen Daten (kein Core, kein Token).
