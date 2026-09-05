/**
 * Voice Input - Whisper STT
 * 
 * Converts speech to text using:
 * - faster-whisper (local, GPU-accelerated via Metal/CUDA — RECOMMENDED)
 * - whisper CLI (local fallback)
 * - OpenAI Whisper API (cloud)
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    const langArg = config.language ? `"${config.language}"` : 'None'

    // Inline Python script for faster-whisper
    const script = `
import sys, json
from faster_whisper import WhisperModel
model = WhisperModel("${model}", device="auto", compute_type="${computeType}")
segments, info = model.transcribe("${audioPath.replace(/"/g, '\\"')}", language=${langArg}, beam_size=5, vad_filter=True)
text = " ".join([s.text.strip() for s in segments])
print(json.dumps({"text": text, "language": info.language, "duration": info.duration}))
`

    try {
        const result = execSync(`${pythonPath} -c '${script.replace(/'/g, "'\\''")}'`, {
            encoding: 'utf-8',
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024,
        }).trim()

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
    const outputPath = audioPath.replace(/\.[^.]+$/, '.txt')

    try {
        const langArg = language ? `--language ${language}` : ''
        execSync(`whisper "${audioPath}" --output_format txt ${langArg}`, {
            encoding: 'utf-8',
            timeout: 60000,
        })

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

