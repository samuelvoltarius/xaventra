# Xaventra HUD für Even G2 (minimale Even-Hub-App)

Zeigt auf der Brille, woran Xaventra gerade arbeitet, und offene Knopf-Karten.

- **Tap = Ja**, **Doppeltap = Nein**, **Wischen = nächste Karte**.
- Karten mit Wirkung *physisch* oder *nach außen* (drucken, schalten, senden …) brauchen
  einen **zweiten Tap** innerhalb von 4 s als Bestätigung.
- „Immer erlauben“ gibt es auf der Brille nie.
- Ohne offene Karte beendet ein Doppeltap die App.

Der Feed kommt vom Even-G2-Endpunkt in Xaventra (`GET /hud`, `POST /hud/answer`),
Einrichtung und Grenzen: [`docs/EVEN_G2.md`](../../docs/EVEN_G2.md).

## Bauen (getrennt von der Haupt-Suite)

Die App gehört nicht zum Xaventra-Build und nicht zur vitest-Suite. Die SDK-Pakete
(`@evenrealities/even_hub_sdk`, `evenhub-cli`, `evenhub-simulator`) werden nur hier installiert:

```bash
cd apps/even-g2
npm install
npm run typecheck
npm run dev          # Vite auf http://127.0.0.1:5173
npm run sim          # Even-Hub-Simulator gegen den Dev-Server
```

Im Simulator: am „Telefon“-Teil Adresse `http://127.0.0.1:18790` (lokaler Xaventra-Endpunkt)
und das Token eintragen, **Speichern** — oder für `npm run dev` eine `.env.local` mit
`VITE_XAVENTRA_URL=http://127.0.0.1:18790` und `VITE_XAVENTRA_TOKEN=…` anlegen (wird nur im
Dev-Modus gelesen, nie in den Build übernommen; `.env.local` nicht committen). Auf echter Hardware nur die HTTPS-Adresse aus
`tailscale serve` verwenden.

## Auf die Brille

1. In `app.json` unter `permissions[0].whitelist` die eigene Tailnet-Adresse eintragen
   (statt `https://xaventra.example.ts.net`).
2. `npx evenhub qr` (Sideload per QR in der Even-App) oder `npx evenhub pack` für ein Paket.
3. In der App auf dem Telefon Adresse + Token speichern (bleibt nur auf dem Telefon,
   im Local-Storage der Even-App).

Dateien: `src/hud.ts` (Anzeige + Gesten, ohne SDK), `src/main.ts` (SDK, Long-Poll, Senden).
