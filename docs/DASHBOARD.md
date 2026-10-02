# Xaventra im Browser

Der Main liefert **dieselbe Oberfläche wie die Desktop-App** über HTTP aus –
es gibt kein eigenes Dashboard mehr. Bereiche, Bedienung und Gestaltung stehen
in [DESKTOP_REDESIGN.md](DESKTOP_REDESIGN.md) und [DESKTOP.md](DESKTOP.md).

## Zugang

| | |
|---|---|
| Adresse | `http://127.0.0.1:3011/` (aus `dashboard.host` / `dashboard.port`) |
| Anmeldung | In der Seite unter **Einstellungen › Desktop-Token** das Token eintragen |
| Owner-Ansichten | Heute, Arbeit, System, Gedächtnis brauchen `NOVA_DESKTOP_API_TOKEN` (der Owner) |
| Ohne `NOVA_DESKTOP_API_TOKEN` | Das Gateway-Token (`.nova-gateway-token`) öffnet nur den Nicht-Owner-Modus der Desktop-API (Unterhaltung); die Ansichten melden „nur für den Owner“ |

Das Token bleibt im Browser nur in `sessionStorage` dieses Tabs (beim Schließen
weg); Darstellung und Benutzername merkt sich der Browser in `localStorage`.
Ein alter Lesezeichen-Link `/?token=…` leitet ohne Token auf `/` um und setzt
kein Cookie mehr.

Von einem anderen Rechner: SSH-/Tailscale-Tunnel auf den Loopback-Port oder
`dashboard.host` auf die Tailnet-Adresse des Mains setzen. Nie öffentlich
binden, nie `tailscale funnel`.

## Sicherheitsregeln

- Ein Port, eine Bindung (`dashboard.host`, Standard `127.0.0.1`); belegt = Fehler, kein Ausweichen.
- Unbekannter `Host` (DNS-Rebinding) oder fremder `Origin` → `403`, vor allem anderen.
- Jede `/api`-Anfrage braucht ein Token (Bearer oder `x-nova-dashboard-token`);
  mit `NOVA_DESKTOP_API_TOKEN` prüft die Desktop-API selbst.
- Ausgeliefert werden genau vier Dateien (`index.html`, `bridge.js`, `app.js`,
  `styles.css`) mit `Content-Security-Policy` (nur eigene Skripte/Styles,
  `connect-src 'self'`, `frame-ancestors 'none'`) und `Cache-Control: no-store`.
  Sie enthalten keine Daten und kein Token.
- Daten gibt es nur über `/api/desktop/*`; alle anderen `/api`-Pfade → `404`.

## Was weggefallen ist (2.83)

Die frühere eigene Dashboard-Seite (`src/dashboard/public`), ihre rund
70 Sonder-Endpunkte (`/api/status`, `/api/config`, `/api/memory*`, `/api/logs`,
`/api/proposals`, `/api/scheduler`, `/api/mesh/*` …), der WebSocket-Live-Feed
mit Cookie-Anmeldung und der experimentelle Next.js-Client `dashboard/`.
Begründung und Zuordnung der sinnvollen Teile: [DESKTOP_REDESIGN.md](DESKTOP_REDESIGN.md#was-entfällt).

Build: `npm run build` kopiert `desktop/renderer` nach `dist/dashboard/public`
(`src/dev/copy-dashboard-assets.ts`); das Release-Image enthält `dist/`.
