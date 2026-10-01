# vLLM-Modellwechsel am Spark

Entscheidung des Owners (01.10.2026): „Ein vLLM-Modellwechsel am Spark darf laufen — als Knopf-Karte mit
automatischem Rückweg. ‚vLLM stoppen ohne Rückweg‘ bleibt auf der Nie-Liste.“

## Was Xaventra tut

1. `/modelle wechsel <aufgabe> <ziel>` — `<ziel>` kommt aus der geschlossenen Liste
   (`routing.vllm.targets`, Standard: `coder qwen27 qwen35 ornith ornith15 flash nano nemotron`).
   Freier Text, Shell-Zeichen, Pfade oder Großschreibung werden abgelehnt.
2. Vorbedingungen **vor der Karte und noch einmal vor der Ausführung**: Host-Agent eingerichtet, keine
   Wartungsmarke, kein laufender Wechsel, Ziel ≠ aktuelles Ziel, altes Ziel und beide erwarteten Modell-IDs
   bekannt (sonst kein prüfbarer Rückweg), keine laufende Mission / Team-Lauf / Subagent / Aufgabe, die das LLM
   braucht, Speicher des Knotens bekannt und nicht kritisch.
3. Karte `vllm-wechsel` (L2): **[Ja] [Nein] [Später]** — „Immer erlauben“ gibt es nicht, und die
   Vertrauensleiter schlägt nie L1 vor (`NUR_EINZELNES_JA` in `src/core/action-policy.ts`).
4. Nach „Ja“: Wartungsmarke setzen → `spark-models.sh switch <neu>` abgekoppelt → bis 15 min prüfen
   (Neustart gesehen **und** `/v1/models` listet die erwartete ID **und** eine Mini-Chat-Probe mit max. 16
   Tokens, Thinking aus, gelingt) → Marke weg.
5. Kein Erfolg in der Frist, Probe 3× gescheitert oder Skript mit Fehlercode beendet → **automatisch**
   `switch <alt>`, warten bis alt wieder antwortet, Meldung „zurückgerollt“ mit Grund. Scheitert auch das:
   Marke entfernen (der vLLM-Wächter übernimmt) und dringender Gedanke (Telegram).
6. Während des Wechsels: Statusmeldung „Modellwechsel läuft, ~15 min ohne lokales LLM“. Der lokale
   LLM-Anbieter ruft genau diesen vLLM-Endpunkt nicht auf und antwortet mit einer klaren Meldung statt zu
   hängen; andere lokale Endpunkte bleiben nutzbar. Es gibt **keinen** Cloud-Ausweichweg für lokale Anfragen.

Es gibt keinen Stopp-Befehl. Arten/Effekte wie `vllm-stoppen`, `vllm-wechsel-stoppen`, `vllm:kill`,
`vllm-container-stop` sind Nie-Liste (L3).

## Host-Seite (macht der Owner)

Der Host-Agent (`xaventra-host.service`, läuft als root) bekommt einen `vllm`-Abschnitt in seiner
Betreiber-Konfiguration. Ohne diesen Abschnitt existieren die Routen nicht und Xaventra lehnt ehrlich ab
(„Host-Agent nicht eingerichtet“).

```json
{
  "vllm": {
    "ticketPublicKeyFile": "/etc/xaventra-host/vllm-ticket.pub",
    "user": { "uid": 1000, "gid": 998, "home": "/home/tgbrutus", "name": "tgbrutus" },
    "script": "/home/tgbrutus/spark-models.sh",
    "targets": ["coder", "qwen27", "qwen35", "ornith", "ornith15", "flash", "nano", "nemotron"]
  }
}
```

- `uid` = tgbrutus, `gid` = Gruppe mit Docker-Zugriff (z. B. `docker`, `getent group docker`). Node setzt
  beim Benutzerwechsel **keine Zusatzgruppen**; deshalb muss die Docker-Gruppe die primäre gid des Aufrufs sein.
- Der Agent startet nur `[<script>, "switch", <ziel>]` ohne Shell, in eigener Sitzung (wie `setsid … &`),
  Ausgabe nach `<stateDir>/vllm/switch-<ticket>.log`. Er wartet nie auf den Start.
- Gelesen werden (ohne Symlinks zu folgen) `~/.spark-current-model` und `~/.spark-model-ids`
  (`ziel=id`, `ziel id` oder `ziel: id` je Zeile). Geschrieben wird nur `~/.spark-stage-saved-target`
  (Inhalt: altes Ziel, nur wenn noch keine Marke existiert, gehört danach tgbrutus). Entfernt wird nur die
  **eigene** Marke; eine Marke von Alfreds eigener Wartung bleibt immer stehen.
- `freigeben` nach Abschluss; der Wächter `~/vllm-guard.sh` übernimmt danach wieder.

Main-Seite (Umgebung des Xaventra-Dienstes): `XAVENTRA_HOST_AGENT_SOCKET`, `XAVENTRA_HOST_AGENT_TOKEN_FILE`,
`XAVENTRA_HOST_AGENT_NODE_ID`, `XAVENTRA_HOST_AGENT_CLIENT_ID` und `XAVENTRA_VLLM_TICKET_KEY_FILE`
(privater ed25519-Schlüssel; ohne ihn wird `XAVENTRA_INSTALL_TICKET_KEY_FILE` verwendet). Tickets sind
5 min gültig, einmalig, an Knoten, Client, Plan, Schritt und Ziel gebunden und von Installations-Tickets
getrennt signiert (`xaventra-vllm-ticket:`).

### sudoers

Im Standardaufbau ist **kein sudoers-Eintrag nötig**: der Host-Agent ist root und wechselt für den Aufruf
selbst auf uid/gid von tgbrutus. Xaventra setzt sudoers nie (Nie-Liste), und `sudo` steht auf der
Befehls-Nie-Liste des Host-Agenten — ein sudo-basierter Aufruf ist in diesem Bau nicht vorgesehen. Wer den
Host-Agenten künftig ohne root betreiben will, muss das als eigene Owner-Entscheidung neu planen.

## Prüfen ohne Wechsel

`POST /v1/vllm/state` am Host-Agenten (authentifiziert) zeigt aktuelles Ziel, Marke, eigene Marke,
Modell-IDs, laufenden Start und den `sparkrun_*_solo`-Container — rein lesend.
