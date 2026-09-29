/**
 * Voice Input - Whisper STT
 * 
 * Converts speech to text using:
 * - faster-whisper (local, GPU-accelerated via Metal/CUDA — RECOMMENDED)
 * - whisper CLI (local fallback)
 * - OpenAI Whisper API (cloud)
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { execFile, execSync } from 'node:child_process'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * MI-14: transcription runs asynchronously (no execSync on the event loop)
 * and without a shell; paths and options are passed as arguments.
 */
function runFile(file: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) reject(error)
            else resolve(String(stdout ?? ''))
        })
    })
}

// ============================================
// Types
// ============================================

export interface TranscriptionResult {
    text: string
    language?: string
    duration?: number
    confidence?: number
}

export interface VoiceInputConfig {
    model: 'faster-whisper' | 'whisper-1' | 'whisper-local' | 'google'
    apiKey?: string
    language?: string
    /** Path to Python with faster-whisper installed (e.g. ~/agentv/.venv/bin/python) */
    pythonPath?: string
    /** faster-whisper model size */
    whisperModel?: string
    /** Compute type for faster-whisper (int8, float16, etc.) */
    computeType?: string
}

// ============================================
// Transcription Providers
// ============================================

/**
 * Transcribe using faster-whisper (8x faster than OpenAI whisper, Metal GPU support)
 * Calls AgentV's Python venv with faster-whisper installed.
 */
async function transcribeWithFasterWhisper(
    audioPath: string,
    config: VoiceInputConfig
): Promise<TranscriptionResult> {
    const pythonPath = config.pythonPath || join(process.env.HOME || '~', 'agentv', '.venv', 'bin', 'python')
    const model = config.whisperModel || 'large-v3-turbo'
    const computeType = config.computeType || 'int8'
    // Inline Python script for faster-whisper; all values arrive via argv.
    const script = `
import sys, json
from faster_whisper import WhisperModel
audio, model_name, compute_type, language = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] or None
model = WhisperModel(model_name, device="auto", compute_type=compute_type)
segments, info = model.transcribe(audio, language=language, beam_size=5, vad_filter=True)
text = " ".join([s.text.strip() for s in segments])
print(json.dumps({"text": text, "language": info.language, "duration": info.duration}))
`

    try {
        const result = (await runFile(pythonPath, ['-c', script, audioPath, model, computeType, config.language || ''], 60_000)).trim()

        const data = JSON.parse(result)
        console.log(`[VoiceInput] faster-whisper: "${data.text}" (${data.language}, ${data.duration?.toFixed(1)}s)`)
        return {
            text: data.text,
            language: data.language,
            duration: data.duration,
        }
    } catch (err) {
        console.log(`[VoiceInput] faster-whisper failed, falling back to local whisper: ${err}`)
        return transcribeWithLocalWhisper(audioPath, config.language)
    }
}

/**
 * Transcribe using OpenAI Whisper API
 */
async function transcribeWithOpenAI(
    audioPath: string,
    apiKey: string,
    language?: string
): Promise<TranscriptionResult> {
    const FormData = (await import('form-data')).default
    const fs = await import('node:fs')

    const form = new FormData()
    form.append('file', fs.createReadStream(audioPath))
    form.append('model', 'whisper-1')
    if (language) form.append('language', language)

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...form.getHeaders(),
        },
        body: form as any,
    })

    if (!response.ok) {
        throw new Error(`OpenAI Whisper error: ${response.statusText}`)
    }

    const data = await response.json() as { text: string }
    return { text: data.text }
}

/**
 * Transcribe using local Whisper CLI (requires whisper installed)
 */
async function transcribeWithLocalWhisper(
    audioPath: string,
    language?: string
): Promise<TranscriptionResult> {
    // whisper writes <name>.txt into --output_dir (default: cwd), so pin it
    // next to the audio file where the result is read from.
    const outputDir = dirname(audioPath)
    const outputPath = join(outputDir, `${basename(audioPath, extname(audioPath))}.txt`)

    try {
        await runFile('whisper', [
            audioPath, '--output_format', 'txt', '--output_dir', outputDir,
            ...(language ? ['--language', language] : []),
        ], 60_000)

        if (existsSync(outputPath)) {
            const text = readFileSync(outputPath, 'utf-8').trim()
            unlinkSync(outputPath)
            return { text }
        }
        throw new Error('Whisper output not found')
    } catch (err) {
        throw new Error(`Local Whisper failed: ${err}`)
    }
}

// ============================================
// Main API
// ============================================

/**
 * Transcribe audio file to text
 */
export async function transcribe(
    audioPath: string,
    config: VoiceInputConfig = { model: 'faster-whisper' }
): Promise<TranscriptionResult> {
    if (!existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`)
    }

    console.log(`[VoiceInput] Transcribing: ${audioPath} with ${config.model}`)

    switch (config.model) {
        case 'faster-whisper':
            return transcribeWithFasterWhisper(audioPath, config)

        case 'whisper-1':
            if (!config.apiKey) throw new Error('OpenAI API key required')
            return transcribeWithOpenAI(audioPath, config.apiKey, config.language)

        case 'whisper-local':
            return transcribeWithLocalWhisper(audioPath, config.language)

        default:
            // Default to faster-whisper
            return transcribeWithFasterWhisper(audioPath, config)
    }
}

/**
 * Check if faster-whisper is available
 */
export function isFasterWhisperAvailable(pythonPath?: string): boolean {
    const python = pythonPath || join(process.env.HOME || '~', 'agentv', '.venv', 'bin', 'python')
    try {
        execSync(`${python} -c "import faster_whisper"`, { encoding: 'utf-8', stdio: 'pipe' })
        return true
    } catch {
        return false
    }
}

/**
 * Check if local whisper CLI is available
 */
export function isWhisperAvailable(): boolean {
    try {
        execSync('whisper --help', { encoding: 'utf-8', stdio: 'pipe' })
        return true
    } catch {
        return false
    }
}

export default {
    transcribe,
    isFasterWhisperAvailable,
    isWhisperAvailable,
}

