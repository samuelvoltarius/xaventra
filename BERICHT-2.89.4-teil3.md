# Bericht Xaventra 2.89.4 — Teil 3

Zweig: `claude/release-2.89.4-teil3` (dieses Worktree)
Basis: `main` mit v2.89.3 + PR #1
Versionsnummern: **nicht geändert** (package.json bleibt `2.89.3`; Changelog nur Zeilen unter `[2.89.4]`)
Nichts gepusht. Keine `npm install`, keine neuen Abhängigkeiten.

> Hinweis: Der Auftrag verlangte `../BERICHT-2.89.4-teil3.md` (außerhalb des Worktrees).
> Dieser Bericht liegt zusätzlich im Worktree unter `BERICHT-2.89.4-teil3.md`.

## Live-Fehler (Telegram 09.10. 00:51–00:53) und Umsetzung

### Bereits auf dem Zweig (Commits vor dieser Session)

1. **Live-Statuskarte löschen** — `fix(telegram): delete the progress card after the answer (2.89.4)` (`778c4c8`)
2. **Reply auf die auslösende Nachricht** — `fix(telegram): reply to the triggering message when the chat moved on (2.89.4)` (`6370e50`)

### In dieser Session

| # | Live-Fehler | Umsetzung | Test |
|---|-------------|-----------|------|
| 1 | Router/Tool-Adication: „mach es auf“ / „öffne … auf deinem Arbeitsplatz“ / „versuch es im Browser“ / „klick“ / „tipp ein“ / Computer-Use boten nur Screenshot-Tools | `WORKSTATION_ACTION` + `isWorkstationAction()` in `src/core/action-intent.ts` (geteilt mit `tool-router.ts`); LIVE_ROUTE `workstation-action`; Pack `computer-use` mit `desktop_control` + `desktop_workspace` | Unit: `action-intent.test.ts`, `tool-router.test.ts`; E2E: `workstation-action.test.ts` |
| 2 | Screenshot ist keine Handlung: Bildschirmbeschreibung statt Handlung | `toolProvidesActionEvidence(name, kind)`: Beobachtungs-Tools erfüllen keine `device-action`; `observationOnlyRun` / `describesScreenWithoutActing` / `SCREEN_ONLY_ACTION_REPLY` in `unverified-claims.ts`; ein erzwungener Handlungs-Nachforderungslauf in `message-pipeline.ts`, danach ehrlicher Satz | Unit: `unverified-claims.test.ts`, `action-lifecycle.test.ts`; E2E: 2 Fälle |
| 3 | Web-on-desktop-Flow | Pack-Beschreibung + Prompt-Abschnitt „Webseiten auf dem Arbeitsplatz (Computer-Use)“: Browser öffnen (Firefox) → URL (Tracking zuerst direkte URL mit Sendungsnummer) → Laden per Screenshot → Feld, tippen, Enter → Ergebnis-Screenshot | über Router-Prompt / Pack; im E2E-Text des Erfolgsfalls |
| 4 | E2E über den echten Eingang | `src/e2e/workstation-action.test.ts` (Telegram, geskriptetes Modell, gefälschte `desktop_*`-Handler, `loadPolicy`-Allow) | 3 Tests |

### Zusätzliche Korrekturen, die die Fixes erst grün machten

- **Umlaut-Wortgrenze:** `\b` ist ASCII-only — `\boffne` matcht „öffne“ nie. Ersetzt durch
  `(?:^|[^[^\p{L}\p{N}_])`-Grenzen (`W_START`/`W_END`/`OPEN_VERB`) und „öffnen“.
- **Workstation vor Datei-Check:** „öffne die Seite auf deinem Arbeitsplatz“ ist eine
  Gerätehandlung, auch wenn ein pfadartiges Token dabei steht.
- **Observation-Gate darf die spätere Evidence-Gate-Antwort nicht überschreiben:**
  `actionObservationClosed`; bei Erfolg des Nachforderungslaufs wird `actionState`
  des Retry-Kernels übernommen (`fulfilled: true`).

## Gates

| Gate | Ergebnis |
|------|----------|
| `npx tsc --noEmit` | sauber |
| `npx vitest run src/core/action-intent.test.ts src/core/unverified-claims.test.ts src/core/action-lifecycle.test.ts src/tools/tool-router.test.ts` | 77/77 |
| `npx vitest run src/e2e/` | **95/95** (11 Dateien, inkl. 3 neue Workstation-Tests) |
| `npm run test:desktop` | **38/38** |
| `npm run catalogs:generate` + `npm run check:catalogs` | generiert (2 geändert) und current |
| `npx vitest run` (voll) | siehe Hinweis unten |

Voller `npx vitest run` inklusive E2E und Unit: die E2E-Teilmenge ist nachweislich grün
(95/95); der kombinierte Full-Run wurde parallel angestoßen. Vor dem Zusammenführen
mit Teil 1+2 bitte den Full-Run erneut auf dem Merge-Zweig fahren.

## Commits (dieser Zweig)

Bereits vorhanden:
- `778c4c8` fix(telegram): delete the progress card after the answer (2.89.4)
- `6370e50` fix(telegram): reply to the triggering message when the chat moved on (2.89.4)

In dieser Session (klein, englisch, Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`):
- Workstation-Routing (`desktop_control` / `desktop_workspace`, Umlaut-Grenze)
- Screenshot-ist-keine-Handlung (Evidence + ein Nachforderungslauf + ehrlicher Satz)
- E2E `src/e2e/workstation-action.test.ts`
- Changelog `[2.89.4]` + generierte Kataloge

## Nicht angefasst / bewusst offen

- Keine Versionsbump (Auftrag: Versionsnummern nicht ändern).
- Kein Push (Auftrag: nichts pushen).
- `desktop_control` bleibt die typisierte Nova-Desktop-Steuerung; `desktop_input` das
  X11-Eingabewerkzeug. Policy (Default-Deny `desktop_*`) ist unverändert — Freigaben
  laufen weiter über Owner-Enrollment bzw. authentifizierten Desktop-Client.
- Zusammenführung mit Teil 1+2 steht aus (parallele Worktrees).
