# Arbeitsdaten mitnehmen (Entwurf, 2.86 Paket J Punkt 4)

Ziel (Alfred, 02.10.2026): Eine Aufgabe läuft auf dem Knoten, der sie am besten
kann – und ihre Arbeitsdaten (Git-Repos, Arbeitsordner) kommen mit. „Dann kann
es irgendwo laufen, wo ist mir egal.“ Nichts Privates in die Cloud.

## Stand

| Teil | Status |
|---|---|
| Wohin? `rankNodes` (src/mesh/node-strengths.ts), `spawn_subagent mesh_node="auto"` | gebaut, getestet |
| Quelle prüfen: nur eigenes Mesh, nur ssh/https, keine Zugangsdaten in der URL (`assessWorkspaceSource`) | gebaut, getestet |
| Genau einen Commit holen und prüfen (`fetchPinnedCommit`, `verifyCheckout`, `fetchWorkspace`) | gebaut, mit echtem git lokal getestet |
| Übergabe im `agent.request` (Feld `workspace`) | Entwurf (unten) |
| Ergebnisse zurückschreiben | Entwurf (unten), Owner-Entscheidung offen |
| Verschlüsselung im Ruhezustand auf dem NAS | Entwurf (unten), Owner-Entscheidung offen |

Nichts davon ist live geschaltet; es gibt keinen neuen Port und keine neue
Verbindungsart. Die Aufgabe selbst geht weiter nur über den signierten
Mesh-Transport (`agent.request`).

## Regeln (im Code erzwungen)

- **Nur eigenes Mesh.** Erlaubte Hosts: Mesh-Knoten (Knoten-ID/Hostname aus den
  signierten Profilen), Tailnet (`100.64.0.0/10`, `*.ts.net`, `fd7a:115c:a1e0::/48`)
  und private Adressen (RFC 1918, ULA). Alles andere – auch github.com – wird
  abgelehnt: „nicht im eigenen Mesh“.
- **Nur verschlüsselt.** `ssh://`, `user@host:pfad` oder `https://`. `http://`,
  `git://`, `file://` und Remote-Helfer (`ext::`, `fd::` …) werden abgelehnt;
  zusätzlich läuft git mit `protocol.allow=never` und nur ssh/https erlaubt.
- **Fester Stand.** Nur volle Commit-IDs, keine Zweignamen (kein wanderndes Ziel).
  Nach dem Holen: `HEAD == Commit` und kein geänderter/fremder Inhalt.
- **Keine Shell, keine Abfragen.** `execFile('git', …)`, `GIT_TERMINAL_PROMPT=0`,
  `--` vor der Quelle, Optionen aus URL/Pfad werden abgelehnt.
- **Keine Zugangsdaten in der URL.** ssh nutzt den Schlüssel des Dienstkontos
  des ausführenden Knotens (Deploy-Key nur lesend, Owner-Entscheidung).

## Ablauf (Entwurf)

1. Der Main wählt den Knoten (`resolveMeshPlacement` → `rankNodes`) und schreibt
   die Begründung ins Outcome-Ledger (`route.selected`, `meshNode`, `meshCapability`).
2. Der Main kennt das Arbeits-Repo des Auftrags (z. B. `ssh://git@xaventra-nas/srv/git/<projekt>.git`)
   und den Commit, auf dem gearbeitet wird. Er legt beides als
   `workspace: { source, commit }` in den signierten `agent.request`.
3. Der ausführende Knoten prüft die Quelle **selbst** gegen seine eigene
   Mesh-Liste (`assessWorkspaceSource`), holt den Commit in
   `.nova-data/workspaces/<requestId>` (`fetchWorkspace`) und startet den
   Lauf mit diesem Arbeitsverzeichnis (vorhandener `workspace`-Weg des Subagenten).
4. Ergebnis: der Knoten schreibt auf einen eigenen Zweig `xaventra/<requestId>`
   im selben Mesh-Repo zurück (nie auf `main`), meldet Commit-ID + Prüfsumme im
   `run.result`; der Main übernimmt erst nach Prüfung (Kernel-Validierung).
5. Aufräumen: Arbeitsverzeichnis nach Abschluss löschen (nur unterhalb von
   `.nova-data/workspaces/`).

## Verschlüsselung im Ruhezustand (Entwurf)

- Transport ist verschlüsselt (ssh/https, zusätzlich WireGuard im Tailnet).
- Für das Repo auf dem NAS zwei Wege, Owner wählt:
  a) verschlüsseltes Volume (LUKS/ZFS-native) für `/srv/git` – einfach, schützt bei Diebstahl;
  b) Inhalte mit dem Mesh-Schlüssel verschlüsselt (z. B. git-crypt/age) – schützt auch
     gegen einen kompromittierten NAS-Dienst, braucht Schlüsselverteilung (Paket K, k-von-n).

## Offene Punkte / Owner-Entscheidungen

- Welches Repo ist die Quelle je Projekt (Konvention `ssh://git@xaventra-nas/srv/git/<projekt>.git`?), wer legt es an?
- Schreibrecht für Ergebnis-Zweige: ein Deploy-Key je Knoten (nur `xaventra/*`-Zweige) oder Rückgabe als signiertes Bundle im `run.result` (kein Schreibrecht auf dem NAS nötig).
- Verschlüsselung im Ruhezustand: a) Volume oder b) Inhalt (siehe oben).
- Der NAS-Git-Dienst muss Protokoll v2 sprechen (Holen einer einzelnen Commit-ID).
- Missions-Checkpoints (nicht Git) laufen weiter über `run.checkpoint`; Abgleich mit Paket K (Zustands-Journal).
