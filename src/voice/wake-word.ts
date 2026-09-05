/**
 * Wake Word — Voice Pipeline for Nova
 *
 * Continuous listening → Wake Word detection → Record → faster-whisper STT → Nova → TTS → Play
 * Designed for macOS (Apple Silicon) and Linux (PI5/Jetson) with microphone + speaker.
 *
 * Uses OpenWakeWord (Python) for offline wake word detection.
 * Falls back to energy-based detection if OpenWakeWord is not installed.
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execSync, ChildProcess } from 'node:child_process'
import { platform } from 'node:os'

const DATA_DIR = join(process.cwd(), '.nova-data', 'voice')

// ============================================
// Types
// ============================================

export type VoiceState = 'idle' | 'listening' | 'recording' | 'thinking' | 'speaking' | 'error'

interface WakeWordConfig {
    modelPath: string           // Path to .onnx wake word model
    threshold: number           // Detection threshold (0.0-1.0)
    wakeWord: string            // e.g. "hey nova"
    recordDurationMs: number    // How long to record after wake word
    /** STT engine: 'faster-whisper' (recommended) or 'whisper' */
    sttEngine: 'faster-whisper' | 'whisper'
    whisperModel: string        // Whisper model size
    /** Path to Python with faster-whisper */
    pythonPath: string
    /** TTS engine */
    ttsEngine: 'edge-tts' | 'piper' | 'macos-say'
    /** TTS voice (for edge-tts or piper model name) */
    ttsVoice: string
    language: string
    sampleRate: number
    /** Local LLM via LM Studio (if set, uses this instead of Nova's cloud LLM) */
    lmStudioUrl?: string
    lmStudioModel?: string
}

function getDefaultPythonPath(): string {
    if (platform() === 'win32') return 'python'
    return join(process.env.HOME || '~', 'agentv', '.venv', 'bin', 'python')
}

const DEFAULT_CONFIG: WakeWordConfig = {
    modelPath: join(DATA_DIR, 'wakeword.onnx'),
    threshold: 0.5,
    wakeWord: 'hey nova',
    recordDurationMs: 8000,
    sttEngine: 'faster-whisper',
    whisperModel: 'large-v3-turbo',
    pythonPath: getDefaultPythonPath(),
    ttsEngine: platform() === 'darwin' ? 'macos-say' : 'edge-tts',
    ttsVoice: platform() === 'darwin' ? 'Anna' : 'de-DE-KatjaNeural',
    language: 'de',
    sampleRate: 16000,
    lmStudioUrl: 'http://localhost:1234/v1',
    lmStudioModel: undefined,  // Auto-detect from LM Studio
}

// ============================================
// State
// ============================================

let currentState: VoiceState = 'idle'
let listenerProcess: ChildProcess | null = null
let config: WakeWordConfig = { ...DEFAULT_CONFIG }
let onStateChange: ((state: VoiceState) => void) | null = null

// ============================================
// Voice Pipeline
// ============================================

/**
 * Initialize voice pipeline
 */
export function initVoicePipeline(customConfig?: Partial<WakeWordConfig>): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    if (customConfig) config = { ...DEFAULT_CONFIG, ...customConfig }

    // Generate Python wake word listener script
    generateWakeWordScript()
    console.log(`[WakeWord] ✅ Voice pipeline initialized (wake: "${config.wakeWord}", stt: ${config.sttEngine}, tts: ${config.ttsEngine})`)
}

/**
 * Start continuous listening for wake word
 */
export function startListening(
    processMessage: (text: string) => Promise<string>,
    stateCallback?: (state: VoiceState) => void
): void {
    if (listenerProcess) {
        console.log('[WakeWord] Already listening')
        return
    }

    onStateChange = stateCallback || null
    setState('listening')

    // Start Python wake word detector
    const scriptPath = join(DATA_DIR, 'wake_listener.py')
    if (!existsSync(scriptPath)) {
        console.log('[WakeWord] ❌ Wake word script not found. Run initVoicePipeline() first.')
        return
    }

    listenerProcess = spawn(config.pythonPath || 'python3', [scriptPath], {
        cwd: DATA_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
    })

    listenerProcess.stdout?.on('data', async (data: Buffer) => {
        const msg = data.toString().trim()

        if (msg === 'WAKE_DETECTED') {
            console.log('[WakeWord] 🎤 Wake word detected!')
            setState('recording')
        } else if (msg.startsWith('TRANSCRIPTION:')) {
            const text = msg.replace('TRANSCRIPTION:', '').trim()
            if (text) {
                console.log(`[WakeWord] 📝 "${text}"`)
                setState('thinking')

                try {
                    let reply: string

                    // Use local LM Studio if configured
                    if (config.lmStudioUrl) {
                        reply = await queryLocalLLM(text)
                    } else {
                        reply = await processMessage(text)
                    }

                    setState('speaking')
                    await speakResponse(reply)
                } catch (err) {
                    console.log(`[WakeWord] ❌ Error: ${err}`)
                    setState('error')
                    await speakResponse('Entschuldigung, da ist ein Fehler aufgetreten.')
                }

                setState('listening')
            }
        }
    })

    listenerProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim()
        if (msg && !msg.includes('ALSA') && !msg.includes('jack') && !msg.includes('PortAudio')) {
            console.log(`[WakeWord] ⚠ ${msg}`)
        }
    })

    listenerProcess.on('close', () => {
        listenerProcess = null
        setState('idle')
    })

    console.log('[WakeWord] 👂 Listening for wake word...')
}

/**
 * Stop listening
 */
export function stopListening(): void {
    if (listenerProcess) {
        listenerProcess.kill()
        listenerProcess = null
    }
    setState('idle')
    console.log('[WakeWord] ⏹ Stopped listening')
}

/**
 * Get current voice state
 */
export function getVoiceState(): VoiceState {
    return currentState
}

// ============================================
// Local LLM (LM Studio)
// ============================================

async function queryLocalLLM(text: string): Promise<string> {
    const url = config.lmStudioUrl || 'http://localhost:1234/v1'

    // Auto-detect model if not set
    let model = config.lmStudioModel
    if (!model) {
        try {
            const resp = await fetch(`${url}/models`)
            const data = await resp.json() as { data: Array<{ id: string }> }
            model = data.data?.find(m => !m.id.includes('embed'))?.id
        } catch { /* ignore */ }
    }

    const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model || 'default',
            messages: [
                {
                    role: 'system',
                    content: 'Du bist Nova, ein intelligenter lokaler Sprachassistent. Antworte kurz und präzise – du wirst vorgelesen. Antworte in der Sprache des Benutzers (Deutsch, English, Türkçe, العربية). Keine Markdown-Formatierung.',
                },
                { role: 'user', content: text },
            ],
            temperature: 0.3,
            max_tokens: 500,
        }),
    })

    if (!response.ok) {
        throw new Error(`LM Studio error: ${response.status}`)
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> }
    let reply = data.choices?.[0]?.message?.content || 'Keine Antwort.'

    // Strip thinking tags (Qwen 3.5)
    if (reply.includes('<think>')) {
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        if (!reply) reply = 'Ich habe die Anfrage verarbeitet.'
    }

    // Strip EOS tokens
    reply = reply.replace(/<\|im_end\|>/g, '').trim()

    return reply
}

// ============================================
// TTS
// ============================================

async function speakResponse(text: string): Promise<void> {
    if (!text.trim()) return

    // Truncate for TTS
    const ttsText = text.slice(0, 500)

    return new Promise((resolve) => {
        if (config.ttsEngine === 'macos-say') {
            // macOS native TTS (always available, no dependencies)
            const voice = config.ttsVoice || 'Anna'
            const say = spawn('say', ['-v', voice, ttsText])
            say.on('close', resolve)
            say.on('error', () => resolve())
        } else if (config.ttsEngine === 'piper') {
            const outputPath = join(DATA_DIR, 'response.wav')
            const piper = spawn('piper', ['--model', config.ttsVoice, '--output_file', outputPath])
            piper.stdin?.write(ttsText)
            piper.stdin?.end()
            piper.on('close', () => {
                playAudio(outputPath).then(resolve)
            })
            piper.on('error', () => {
                // Fallback to macOS say
                const say = spawn('say', [ttsText])
                say.on('close', resolve)
            })
        } else {
            // Edge TTS
            const outputPath = join(DATA_DIR, 'response.mp3')
            const voice = config.ttsVoice || 'de-DE-KatjaNeural'
            const tts = spawn('edge-tts', [
                '--voice', voice,
                '--text', ttsText,
                '--write-media', outputPath,
            ])
            tts.on('close', () => {
                playAudio(outputPath).then(resolve)
            })
            tts.on('error', () => {
                // Fallback to macOS say
                if (platform() === 'darwin') {
                    const say = spawn('say', [ttsText])
                    say.on('close', resolve)
                } else {
                    resolve()
                }
            })
        }
    })
}

/**
 * Play an audio file using the platform's default player
 */
async function playAudio(path: string): Promise<void> {
    return new Promise((resolve) => {
        if (platform() === 'darwin') {
            // macOS
            const player = spawn('afplay', [path], { stdio: 'ignore' })
            player.on('close', resolve)
            player.on('error', () => resolve())
        } else if (platform() === 'win32') {
            // Windows — try ffplay (ffmpeg) first (blocks until done), fallback to PowerShell
            const ffplay = spawn('ffplay', ['-nodisp', '-autoexit', path], { stdio: 'ignore' })
            ffplay.on('close', resolve)
            ffplay.on('error', () => {
                // PowerShell fallback: wait for NaturalDuration instead of fixed sleep
                const psScript = [
                    `Add-Type -AssemblyName PresentationCore`,
                    `$mp = New-Object System.Windows.Media.MediaPlayer`,
                    `$mp.Open([uri]"file:///${path.replace(/\\/g, '/').replace(/^\//, '')}")`,
                    `$mp.Play()`,
                    `$waited = 0`,
                    `while (-not $mp.NaturalDuration.HasTimeSpan -and $waited -lt 30) { Start-Sleep -Milliseconds 100; $waited++ }`,
                    `if ($mp.NaturalDuration.HasTimeSpan) {`,
                    `  $ms = [int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds + 300`,
                    `  Start-Sleep -Milliseconds $ms`,
                    `} else { Start-Sleep -Seconds 15 }`,
                    `$mp.Close()`,
                ].join('; ')
                const ps = spawn('powershell', [
                    '-NoProfile', '-NonInteractive', '-Command', psScript,
                ], { stdio: 'ignore' })
                ps.on('close', resolve)
                ps.on('error', () => resolve())
            })
        } else {
            // Linux - try aplay, then mpv, then paplay
            const player = spawn('aplay', [path], { stdio: 'ignore' })
            player.on('close', resolve)
            player.on('error', () => {
                const mpv = spawn('mpv', ['--no-video', path], { stdio: 'ignore' })
                mpv.on('close', resolve)
                mpv.on('error', () => resolve())
            })
        }
    })
}

// ============================================
// Wake Word Script Generator
// ============================================

function generateWakeWordScript(): void {
    const useFasterWhisper = config.sttEngine === 'faster-whisper'

    const script = `#!/usr/bin/env python3
"""Nova Wake Word Listener — runs continuously, detects wake word, records, transcribes."""
import sys
import os
import time
import wave
import struct
import subprocess
import tempfile
import json

try:
    import pyaudio
    AUDIO_BACKEND = "pyaudio"
except ImportError:
    try:
        import sounddevice as sd
        import numpy as np
        AUDIO_BACKEND = "sounddevice"
        print("WARNING: pyaudio not installed. Using sounddevice backend.", file=sys.stderr)
    except ImportError:
        print("ERROR: no microphone backend installed. Run: pip install sounddevice", file=sys.stderr)
        sys.exit(1)

try:
    from openwakeword.model import Model as WakeWordModel
    HAS_WAKEWORD = True
except ImportError:
    HAS_WAKEWORD = False
    print("WARNING: openwakeword not installed. Using simple energy detection.", file=sys.stderr)

${useFasterWhisper ? `
try:
    from faster_whisper import WhisperModel
    _whisper_model = None
    def get_whisper_model():
        global _whisper_model
        if _whisper_model is None:
            print("Loading faster-whisper model...", file=sys.stderr)
            _whisper_model = WhisperModel("${config.whisperModel}", device="auto", compute_type="int8")
            print("Model loaded!", file=sys.stderr)
        return _whisper_model
    HAS_FASTER_WHISPER = True
except ImportError:
    HAS_FASTER_WHISPER = False
    print("WARNING: faster-whisper not installed. Using whisper CLI.", file=sys.stderr)
` : 'HAS_FASTER_WHISPER = False'}

SAMPLE_RATE = ${config.sampleRate}
CHUNK_SIZE = 1280
RECORD_SECONDS = ${config.recordDurationMs / 1000}
THRESHOLD = ${config.threshold}
ENERGY_THRESHOLD = 500  # Fallback energy-based detection

def record_audio(stream, duration):
    """Record audio for given duration."""
    frames = []
    for _ in range(0, int(SAMPLE_RATE / CHUNK_SIZE * duration)):
        if AUDIO_BACKEND == "pyaudio":
            data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
        else:
            block, overflowed = stream.read(CHUNK_SIZE)
            data = block.astype(np.int16).tobytes()
        frames.append(data)
    return b''.join(frames)

def save_wav(frames, path):
    """Save raw audio frames to WAV file."""
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(frames)

def transcribe(audio_path):
    """Transcribe audio using faster-whisper or whisper CLI."""
    if HAS_FASTER_WHISPER:
        try:
            model = get_whisper_model()
            segments, info = model.transcribe(audio_path, language=None, beam_size=5, vad_filter=True)
            text = " ".join([s.text.strip() for s in segments])
            return text
        except Exception as e:
            print(f"faster-whisper error: {e}", file=sys.stderr)

    # Fallback to whisper CLI
    try:
        result = subprocess.run(
            ['whisper', audio_path, '--model', '${config.whisperModel}', '--language', '${config.language}', '--output_format', 'txt'],
            capture_output=True, text=True, timeout=30
        )
        txt_path = audio_path.rsplit('.', 1)[0] + '.txt'
        if os.path.exists(txt_path):
            with open(txt_path) as f:
                return f.read().strip()
    except Exception as e:
        print(f"Transcription error: {e}", file=sys.stderr)
    return ""

def main():
    p = None
    if AUDIO_BACKEND == "pyaudio":
        p = pyaudio.PyAudio()

        # Auto-detect sample rate
        info = p.get_default_input_device_info()
        actual_rate = int(info.get('defaultSampleRate', SAMPLE_RATE))

        stream = p.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=actual_rate,
            input=True,
            frames_per_buffer=CHUNK_SIZE
        )
    else:
        actual_rate = SAMPLE_RATE
        stream = sd.InputStream(
            samplerate=actual_rate,
            channels=1,
            dtype='int16',
            blocksize=CHUNK_SIZE
        )
        stream.start()

    # Load wake word model if available
    ww_model = None
    if HAS_WAKEWORD:
        try:
            ww_model = WakeWordModel(wakeword_models=["hey_jarvis"])
        except:
            pass

    print("READY", flush=True)

    while True:
        try:
            if AUDIO_BACKEND == "pyaudio":
                audio = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            else:
                block, overflowed = stream.read(CHUNK_SIZE)
                audio = block.astype(np.int16).tobytes()

            wake_detected = False

            if ww_model:
                prediction = ww_model.predict(audio)
                for key in prediction:
                    if prediction[key] > THRESHOLD:
                        wake_detected = True
                        break
            else:
                # Energy-based fallback
                samples = struct.unpack(f'{len(audio)//2}h', audio)
                energy = sum(abs(s) for s in samples) / len(samples)
                # Only trigger on very loud sounds (manual clap detection)
                if energy > ENERGY_THRESHOLD * 3:
                    wake_detected = True

            if wake_detected:
                print("WAKE_DETECTED", flush=True)

                # Record
                frames = record_audio(stream, RECORD_SECONDS)

                # Save and transcribe
                with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                    save_wav(frames, f.name)
                    text = transcribe(f.name)
                    if text:
                        print(f"TRANSCRIPTION:{text}", flush=True)
                    os.unlink(f.name)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"ERROR:{e}", file=sys.stderr)
            time.sleep(1)

    if AUDIO_BACKEND == "pyaudio":
        stream.stop_stream()
        stream.close()
        if p:
            p.terminate()
    else:
        stream.stop()
        stream.close()

if __name__ == "__main__":
    main()
`

    writeFileSync(join(DATA_DIR, 'wake_listener.py'), script)
}

// ============================================
// Helpers
// ============================================

function setState(state: VoiceState): void {
    currentState = state
    onStateChange?.(state)
}

export default {
    initVoicePipeline,
    startListening,
    stopListening,
    getVoiceState,
}
