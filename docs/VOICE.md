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
