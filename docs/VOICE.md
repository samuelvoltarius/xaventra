# Voice I/O Guide

Speech input and output for Nova.

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
