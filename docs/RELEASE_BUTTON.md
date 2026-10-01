# Release-Knopf (Autonomie-Plan Phase 6a)

Statt `git push origin <sha>:refs/heads/main` von Hand drückt der Owner in
Telegram auf **Ja**. Xaventra erkennt den Release-Kandidaten, fragt per
Knopf-Karte und löst dann genau einen geprüften GitHub-Workflow aus. Der
Workflow prüft alles selbst noch einmal und setzt `main` per reinem
Fast-Forward. Es gibt kein Force-Push und kein Überschreiben; bei jeder
Abweichung bricht der Ablauf ab.

Standardmäßig ist der Knopf **aus**.

## Ablauf

1. **Kandidat**: ein Zweig `claude/release-*` im öffentlichen Repo
   `samuelvoltarius/xaventra`, für den gilt:
   - der neueste CI-Lauf (`.github/workflows/ci.yml`, Ereignis `push`) für
     **genau diesen Commit und genau diesen Zweig** ist fertig, und alle Jobs
     (mindestens 10) sind grün,
   - der Commit ist ein reiner Fast-Forward von `main` (vor `main`, 0 zurück),
   - `package.json` und `desktop/package.json` haben dieselbe Version, und sie
     ist neuer als die von `main`,
   - Tag `v<version>` und Release `v<version>` gibt es noch nicht.
2. **Erkennen** (nur Main, nur lesend): alle `intervalMinutes` liest Xaventra
   die GitHub-API ausschließlich per GET (Zeitlimit 10 s je Anfrage). Pro SHA
   entsteht höchstens eine Karte. Ein abgelehnter Kandidat ergibt einen Gedanken
   mit Grund, je SHA und Grund nur einmal.
3. **Karte** (Ausführer `release-promote`, Wirkung *nach außen*):
   „Release 2.x.y bereit: Commit …, CI-Lauf … grün, Änderungen (Auszug aus
   CHANGELOG). Freigeben?“ Die Karte hat nur **Ja / Nein / Später**.
   „Immer erlauben“ gibt es hier nie. Nur der Owner kann antworten (numerische
   Telegram-ID in `allowFrom`), und jeder Knopf wirkt nur einmal.
4. **Ja**: Xaventra prüft den Kandidaten erneut und löst danach genau einmal
   `POST /repos/samuelvoltarius/xaventra/actions/workflows/promote-release.yml/dispatches`
   aus (`ref: main`, Eingaben `candidate_sha`, `version`). Dafür nutzt es das
   eng begrenzte Token aus `XAVENTRA_RELEASE_DISPATCH_TOKEN`. Für dieselbe SHA
   wird nie ein zweites Mal ausgelöst, auch nicht nach einer neuen Karte oder
   bei unklarem Netzergebnis.
5. **Workflow `promote-release.yml`**:
   - Job `verify` (`contents: read`, `actions: read`, kein Token mit
     Schreibrecht, Checkout ohne gespeicherte Zugangsdaten): Er läuft nur, wenn
     er von `main` ausgelöst wurde. Er prüft SHA und Version, ob der Commit ein
     Fast-Forward ist (GitHub-Vergleich und lokales `merge-base --is-ancestor`),
     ob der Commit die Spitze genau eines `claude/release-*`-Zweigs ist, die
     exakte Kandidaten-CI (headSha **und** headBranch, neuester Lauf, alle
     Jobs ≥ 10 grün), die Version (synchron, neuer als `main`) und dass Tag und
     Release fehlen. Danach läuft **Gitleaks 8.30.1** (Binary, SHA256 gegen
     die offizielle Checksummen-Datei gepinnt) über `origin/main..<SHA>`.
   - Job `promote` in der Environment **`release-promotion`**
     (nirgends `contents: write`): Er prüft, dass sich `main` seit `verify`
     nicht bewegt hat und der Push ein Fast-Forward ist. Dann führt er
     `git push origin "<SHA>:refs/heads/main"` aus, ohne Force, mit dem
     **Deploy-Key** aus dem Environment-Secret `RELEASE_PROMOTION_DEPLOY_KEY`,
     und liest das Ergebnis per `ls-remote` zurück. Fehlt der Key, bricht der
     Job ab (kein stiller Rückfall auf `GITHUB_TOKEN`).
6. **Rückmeldung**: Xaventra verfolgt den Lauf nur lesend (alle 30 s, höchstens
   45 min) und meldet als Gedanke und als Telegram-Text: *läuft*,
   *erfolgreich* oder *abgebrochen* mit Job- und Schrittname. Es löst dabei
   nie etwas erneut aus.

Ohne Token löst Xaventra nichts aus. Karte und Antwort sagen dann ehrlich
„Token fehlt“ und zeigen den Befehl zum Selbstausführen:
`git push origin <sha>:refs/heads/main`.

Worker (`NOVA_NODE_ONLY=true`) tun nichts: Sie lesen nicht, erzeugen keine
Karte und lösen nichts aus. Ohne Main-/Telegram-Autorität (Fencing) entsteht
keine Karte.

## Main-CI und Signierung nach dem Push (Entscheidung Alfred 01.10.2026: Variante A)

GitHub startet für Pushes mit `GITHUB_TOKEN` keine `push`-Workflows. Deshalb
pusht der Job mit einem **Deploy-Key**, der nur als Secret der geschützten
Environment `release-promotion` existiert. Ein solcher Push ist ein normales
`push`-Ereignis: Main-CI und danach `update-release.yml` (Signierung) laufen
wie bei einem Push von Hand. Die Release-Gates bleiben unverändert. Der letzte
Schritt meldet, ob die Main-CI innerhalb von 90 s gestartet ist.

## Einrichtung (macht der Owner; Xaventra und Claude ändern keine GitHub-Einstellungen)

1. **Environment `release-promotion` anlegen**: GitHub → Repo → Settings →
   Environments → *New environment* → `release-promotion`.
   - *Deployment branches and tags*: **Selected branches and tags** → nur
     `main`. Dann darf nur der `main`-Workflow die Environment nutzen.
   - Optional *Required reviewers*: Owner eintragen. Dann wartet der Push-Job
     zusätzlich auf die Freigabe in GitHub, nachdem `verify` grün war.
   - **Deploy-Key anlegen** (einmalig, auf einem eigenen Rechner):
     `ssh-keygen -t ed25519 -N "" -C xaventra-release-promotion -f release-promotion`.
     Den öffentlichen Teil (`release-promotion.pub`) unter Repo → Settings →
     *Deploy keys* → *Add deploy key* eintragen, Titel
     `xaventra-release-promotion`, **Allow write access** anhaken. Den
     privaten Teil (`release-promotion`) als **Environment-Secret**
     `RELEASE_PROMOTION_DEPLOY_KEY` in `release-promotion` speichern (nicht als
     Repository-Secret). Danach beide Dateien lokal löschen.
   - Falls `main` geschützt ist: Der Deploy-Key muss Fast-Forward-Pushes auf
     `main` dürfen (Branch-Regel/Ruleset: Deploy-Key in der Bypass-Liste,
     Force-Push bleibt verboten).
   - *Settings → Actions → General → Workflow permissions* darf auf
     „Read repository contents“ bleiben. Der Push-Job fordert `contents: write`
     selbst an.
2. **Fine-grained PAT anlegen**: GitHub → Settings → Developer settings →
   Personal access tokens → *Fine-grained tokens* → *Generate new token*.
   - Resource owner: `samuelvoltarius`. Repository access: **Only select
     repositories** → `xaventra`.
   - Repository permissions: **Actions: Read and write**. Sonst nichts;
     *Metadata: Read* setzt GitHub automatisch.
   - Ablauf: kurz (zum Beispiel 90 Tage). Danach erneuern.
   - Mit diesem Token lassen sich nur Workflows auslösen. Pushen kann es
     nicht. `main` bewegt allein der geschützte Workflow.
3. **Token am Main (Spark) hinterlegen**: Trage
   `XAVENTRA_RELEASE_DISPATCH_TOKEN=<Token>` in die Dienst-Umgebung des Mains
   ein. Am Spark ist das die root-0600-`service.env` des nativen Dienstes.
   Nicht in `nova.config.json`, nicht in `.env` im Repo und nicht in Notizen.
   Xaventra liest das Token erst beim Knopfdruck und sendet es nur als
   `Authorization`-Header des einen Dispatch-POST. Es schreibt das Token weder
   in Logs noch in Gedanken, Karten, Ledger oder Zustand.
4. **Einschalten** in `nova.config.json` des Mains:

   ```json
   { "autonomy": { "releaseButton": { "enabled": true, "intervalMinutes": 30 } } }
   ```

   `intervalMinutes` liegt zwischen 10 und 1440 (Standard 30). Nach dem
   Neustart meldet das Log `Release-Knopf aktiv (alle 30 min, Token
   vorhanden|fehlt)`.

Zustand (je SHA: Karte, Gedanke, Auslösung) liegt in
`.nova-data/release-button.json`, die Karten in `.nova-data/approval-cards/`.

## Rückweg

- **Sofort aus**: `autonomy.releaseButton.enabled=false` (oder Eintrag
  löschen) und Neustart. Danach liest Xaventra nichts mehr. Ein Ja auf eine
  noch offene Karte löst dann nichts aus.
- **Token entziehen**: Token aus der Dienst-Umgebung entfernen und in GitHub
  widerrufen (Fine-grained tokens → *Revoke*). Danach zeigen Karten nur noch
  den Befehl.
- **Deploy-Key entziehen**: Repo → Settings → *Deploy keys* → löschen und
  das Environment-Secret entfernen. Danach bricht der Push-Job ab.
- **Workflow sperren**: GitHub → Actions → *Promote release candidate* →
  *Disable workflow*. Alternativ die Environment `release-promotion` löschen,
  dann bricht der Push-Job ab.
- **Falsches Release auf `main`**: Nie force-pushen. Korrigiert wird mit einem
  neuen Commit (Revert) über den normalen Ablauf aus Runbook §3.1.
