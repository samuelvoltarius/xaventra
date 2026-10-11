# AI-Diensttests: Angebot, Bestätigung, Funktionsbeleg

## Stand 2026-10-11 — lokaler Fix, noch nicht veröffentlicht

Der Owner-Auftrag `Mach mir einen Check von allen ai Diensten die auf den nodes laufen`
wird vor der LLM-Werkzeugauswahl deterministisch behandelt. Der Server erstellt
ein konkretes Angebot aus aktuell zugeordneten Mesh-/lokalen Endpunkten. Ein
anschließendes `Ja` führt genau diese Tests aus. Damit wird keine LLM-generierte
Rückfrage als beliebige Ausführungsautorisierung behandelt.

Implementierung: `src/core/ai-service-test.ts`, eingebunden in
`src/core/message-pipeline.ts`. Bewusst vorhandener deterministischer Pipelineweg,
kein zweiter Agent und kein Shell-/SSH-Behelf des Modells.

## Grenzen

- Nur authentifizierter Owner im Direktchat; keine Gruppen, Systemnachrichten,
  fremden Principals oder Mesh-Agent-Aufträge.
- Bestätigung ist an Principal und Kanal gebunden, zehn Minuten gültig und
  einmalig. Andere Nachrichten einschließlich `/clear` löschen das Angebot.
  Nach Neustart muss es erneut angefordert werden.
- Vor Ausführung werden Ziele erneut aus aktueller Topologie gebunden. Kein
  beliebiger URL-Parameter, keine Credentials, DNS-Namen oder Weiterleitungen.
  Exakte aktuelle Peer-/lokale IP plus begrenzte AI-Portliste; SSRF-Guard bleibt
  aktiv. Loopback-Adressen anderer Nodes werden nicht lokal aufgerufen.
- Maximal 16 Endpunkte, drei parallele Zielprüfungen, drei Modelle je Dienst,
  zwölf Sekunden je Anfrage und 24 Sekunden gemeinsames Ausführungsbudget.
  Request-Abbruch wird an die Netzwerkanfragen weitergereicht.
- Keine Installation, Konfigurationsänderung, Neustarts, Cloud-Fallbacks oder
  Nutzeraufnahmen. Suchtests können über die vorhandene Suchmaschine eine
  externe öffentliche Suche auslösen; der Suchtext ist fest und synthetisch.
- Kein universeller Nachweis aller Modelle, Vision oder des gesamten Gedächtnisses.
  Nicht unterstützte Transports und nicht aufgeführte Dienste bleiben ungeprüft.

## Prüfkriterien

| Dienst | Test | Erfolgskriterium |
| --- | --- | --- |
| OpenAI-kompatibles LLM | `/v1/chat/completions`, synthetische Aufforderung | Erwartete Antwort `OK` |
| Ollama | `/api/chat` | Erwartete Antwort `OK` |
| Embeddings | `/v1/embeddings` oder Ollama `/api/embed` | Nichtleerer endlicher Zahlenvektor |
| Whisper/STT | `/v1/audio/transcriptions`, synthetische WAV-Probe | Erwarteter Satz korrekt transkribiert |
| SearXNG | Öffentlicher festgelegter Testsuchtext | Nichtleere Ergebnisliste |
| OpenAI-kompatibles TTS | `/v1/audio/speech`, synthetischer Text | WAV-Audiodaten; Verständlichkeit nicht separat abgenommen |

Die Sprachprobe ist generierter Testsatz (`This is a speech recognition test`),
16 kHz Mono-PCM, keine Aufnahme einer Person. Sie liegt komprimiert in
`src/core/ai-test-audio.ts`. Ein erster sehr kurzer Testsatz lieferte am realen
Dienst eine leere Antwort und wurde verworfen, nicht als Erfolg ausgegeben.

## Status-Semantik

`/status` zeigt alte Prüfbelege als `nicht aktuell geprüft`, nicht als
`nicht erreichbar`. Die Gültigkeit der Capability-Routing-Belege wird nicht
verlängert. Ein Heartbeat, Prozess oder Gesundheitsendpunkt ist weiterhin kein
Inferenz-/Transkriptionsnachweis. Testergebnisse nennen Zeitpunkt und konkrete
Prüfart, nicht pauschal „alles funktioniert“.

## Abnahme und Übergabe an Claude

- Regression enthält den realen Nachrichteneingang: Auftrag → Angebot → Ja →
  ausgeführter Funktionstest, ohne Nova-Agent-/Lern-Fallback.
- Weitere Tests: RBAC/Gruppen, Kanal-/Principalbindung, Einmaligkeit, Ablauf,
  `/clear`, IP-/Portbindung, HTTP-Fehler, echte Chat-Anfrage, Embedding-Vektor,
  synthetische Multipart-Sprachprobe und leere Antwort trotz HTTP 200.
- Am bestehenden Dienst unabhängig geprüft: Qwen-Inferenz mit tatsächlicher
  Antwort; längere synthetische Sprachprobe korrekt transkribiert.
- Noch offen: gesamter Release-/CI-Lauf, signierte Veröffentlichung und echte
  Telegram-End-to-End-Abnahme des geänderten Codes nach einem separat freigegebenen
  Rollout. Vorhandene Produktion bleibt unverändert.
- Codex-/Vision-Funktionstests und zusätzliche Dienstprotokolle sind nicht Teil
  dieses Fixes. Ungeprüfte Dienste nicht über Heartbeats als funktionierend melden.

Fokussierter Prüfbefehl:

```sh
NOVA_SKIP_MODEL_RESOLVER_INIT=1 npx vitest run src/core/ai-service-test.test.ts src/core/service-correction-live.test.ts src/core/status-endpoints.test.ts src/core/service-run-truth.test.ts src/core/deterministic-query.test.ts src/voice/whisper-gpu.test.ts src/voice/openai-audio.test.ts
npm run typecheck
```
