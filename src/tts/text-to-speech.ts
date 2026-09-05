/**
 * Nova Text-to-Speech Module
 *
 * Multi-provider TTS:
 * - OpenAI TTS API (tts-1, tts-1-hd, gpt-4o-mini-tts)
 * - Edge TTS (free, Microsoft Edge voices)
 * - ElevenLabs (premium voices)
 *
 * Inspired by OpenClaw's tts-core.ts (19KB)
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ============================================
// Types
// ============================================

export type TtsProvider = 'openai' | 'edge' | 'elevenlabs' | 'piper' | 'macos-say'

export interface TtsRequest {
    text: string
    provider?: TtsProvider
    voice?: string
    model?: string
    outputPath?: string      // If not set, uses temp file
    speed?: number           // 0.5 - 2.0
    format?: 'mp3' | 'opus' | 'wav'
}

export interface TtsResult {
    success: boolean
    outputPath?: string
    provider?: TtsProvider
    duration?: number
    error?: string
    size?: number
}

interface TtsConfig {
    openai?: {
        apiKey: string
        model: string
        voice: string
        baseUrl?: string     // Custom endpoint (e.g. Kokoro, LocalAI)
    }
    elevenlabs?: {
        apiKey: string
        voiceId: string
        modelId: string
    }
    edge?: {
        voice: string
        lang: string
        rate?: string
        pitch?: string
    }
}

// ============================================
// Constants
// ============================================

const OPENAI_VOICES = [
    'alloy', 'ash', 'ballad', 'cedar', 'coral',
    'echo', 'fable', 'juniper', 'marin', 'onyx',
    'nova', 'sage', 'shimmer', 'verse',
] as const

const OPENAI_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const

const EDGE_DEFAULT_VOICE = 'de-DE-KatjaNeural'
const EDGE_DEFAULT_LANG = 'de-DE'

const TEMP_DIR = join(tmpdir(), 'nova-tts')

// ============================================
// Provider: OpenAI TTS
// ============================================

async function openaiTTS(request: TtsRequest, config: TtsConfig['openai']): Promise<TtsResult> {
    if (!config?.apiKey) {
        return { success: false, error: 'OpenAI API Key nicht konfiguriert. Setze OPENAI_API_KEY in nova.config.json' }
    }

    const model = request.model || config.model || 'tts-1'
    const voice = request.voice || config.voice || 'nova'
    const format = request.format || 'mp3'
    const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')

    const outputPath = request.outputPath || getTempPath(format)

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)

        const response = await fetch(`${baseUrl}/audio/speech`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                input: request.text,
                voice,
                response_format: format,
                speed: request.speed || 1.0,
            }),
            signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!response.ok) {
            const errText = await response.text()
            return { success: false, error: `OpenAI TTS Fehler (${response.status}): ${errText.slice(0, 200)}` }
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        ensureTempDir()
        writeFileSync(outputPath, buffer)

        return {
            success: true,
            outputPath,
            provider: 'openai',
            size: buffer.length,
        }
    } catch (err: any) {
        return { success: false, error: `OpenAI TTS: ${err.message}` }
    }
}

// ============================================
// Provider: Edge TTS (Free)
// ============================================

async function edgeTTS(request: TtsRequest, config: TtsConfig['edge']): Promise<TtsResult> {
    const voice = request.voice || config?.voice || EDGE_DEFAULT_VOICE
    const format = request.format || 'mp3'
    const outputPath = request.outputPath || getTempPath(format)

    try {
        // Edge TTS via npm package edge-tts or node-edge-tts
        const { execSync } = await import('node:child_process')

        // Try using edge-tts CLI
        ensureTempDir()
        execSync(
            `npx -y edge-tts --voice "${voice}" --text "${request.text.replace(/"/g, '\\"')}" --write-media "${outputPath}"`,
            { encoding: 'utf-8', timeout: 30_000 },
        )

        return {
            success: true,
            outputPath,
            provider: 'edge',
        }
    } catch (err: any) {
        return { success: false, error: `Edge TTS: ${err.message}` }
    }
}

// ============================================
// Provider: ElevenLabs
// ============================================

async function elevenLabsTTS(request: TtsRequest, config: TtsConfig['elevenlabs']): Promise<TtsResult> {
    if (!config?.apiKey) {
        return { success: false, error: 'ElevenLabs API Key nicht konfiguriert' }
    }

    const voiceId = config.voiceId || '21m00Tcm4TlvDq8ikWAM'  // Rachel
    const modelId = request.model || config.modelId || 'eleven_multilingual_v2'
    const format = request.format || 'mp3'
    const outputPath = request.outputPath || getTempPath(format)

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)

        const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': config.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                body: JSON.stringify({
                    text: request.text,
                    model_id: modelId,
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true,
                    },
                }),
                signal: controller.signal,
            },
        )

        clearTimeout(timeout)

        if (!response.ok) {
            return { success: false, error: `ElevenLabs Fehler (${response.status})` }
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        ensureTempDir()
        writeFileSync(outputPath, buffer)

        return {
            success: true,
            outputPath,
            provider: 'elevenlabs',
            size: buffer.length,
        }
    } catch (err: any) {
        return { success: false, error: `ElevenLabs: ${err.message}` }
    }
}

// ============================================
// Main TTS Function
// ============================================

/**
 * Convert text to speech using configured provider
 */
export async function speak(request: TtsRequest): Promise<TtsResult> {
    const startTime = Date.now()
    const config = loadTtsConfig()

    let provider = request.provider

    // Auto-detect provider
    if (!provider) {
        if (config.openai?.apiKey) provider = 'openai'
        else if (config.elevenlabs?.apiKey) provider = 'elevenlabs'
        else provider = 'edge'  // Free fallback
    }

    let result: TtsResult

    switch (provider) {
        case 'openai':
            result = await openaiTTS(request, config.openai)
            break
        case 'elevenlabs':
            result = await elevenLabsTTS(request, config.elevenlabs)
            break
        case 'piper':
            result = await piperTTS(request)
            break
        case 'macos-say':
            result = await macosSayTTS(request)
            break
        case 'edge':
        default:
            result = await edgeTTS(request, config.edge)
            break
    }

    result.duration = Date.now() - startTime
    return result
}

/**
 * List available voices for a provider
 */
export function listVoices(provider?: TtsProvider): {
    provider: string
    voices: string[]
    models?: string[]
} {
    switch (provider) {
        case 'openai':
            return {
                provider: 'openai',
                voices: [...OPENAI_VOICES],
                models: [...OPENAI_MODELS],
            }
        case 'elevenlabs':
            return {
                provider: 'elevenlabs',
                voices: ['Rachel (21m00Tcm4TlvDq8ikWAM)', 'Domi', 'Bella', 'Antoni', 'Elli', 'Josh', 'Arnold', 'Adam', 'Sam'],
                models: ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_monolingual_v1'],
            }
        case 'edge':
        default:
            return {
                provider: 'edge',
                voices: [
                    'de-DE-KatjaNeural', 'de-DE-ConradNeural', 'de-DE-AmalaNeural',
                    'en-US-JennyNeural', 'en-US-GuyNeural', 'en-US-AriaNeural',
                    'en-GB-SoniaNeural', 'en-GB-RyanNeural',
                    'fr-FR-DeniseNeural', 'es-ES-ElviraNeural',
                    'tr-TR-EmelNeural', 'tr-TR-AhmetNeural',
                ],
            }
    }
}

// ============================================
// Helpers
// ============================================

function getTempPath(format: string): string {
    ensureTempDir()
    return join(TEMP_DIR, `nova-tts-${Date.now()}.${format}`)
}

// ============================================
// Provider: Piper TTS (Local)
// ============================================

async function piperTTS(request: TtsRequest): Promise<TtsResult> {
    const format = request.format || 'wav'
    const outputPath = request.outputPath || getTempPath(format)
    const voice = request.voice || 'de_DE-thorsten-high'

    try {
        const { execSync } = await import('node:child_process')
        ensureTempDir()

        // Piper expects text on stdin
        execSync(
            `echo "${request.text.replace(/"/g, '\\"')}" | piper --model ${voice} --output_file "${outputPath}"`,
            { encoding: 'utf-8', timeout: 30_000 }
        )

        return { success: true, outputPath, provider: 'piper' }
    } catch (err: any) {
        return { success: false, error: `Piper TTS: ${err.message}` }
    }
}

// ============================================
// Provider: macOS Say (Built-in)
// ============================================

async function macosSayTTS(request: TtsRequest): Promise<TtsResult> {
    const format = request.format || 'wav'
    const outputPath = request.outputPath || getTempPath(format)
    const voice = request.voice || 'Anna'

    try {
        const { execSync } = await import('node:child_process')
        ensureTempDir()

        if (request.outputPath) {
            // Save to file
            execSync(
                `say -v "${voice}" -o "${outputPath}" --data-format=LEI16@22050 "${request.text.replace(/"/g, '\\"').slice(0, 500)}"`,
                { encoding: 'utf-8', timeout: 30_000 }
            )
            return { success: true, outputPath, provider: 'macos-say' }
        } else {
            // Speak directly (no file needed)
            execSync(
                `say -v "${voice}" "${request.text.replace(/"/g, '\\"').slice(0, 500)}"`,
                { encoding: 'utf-8', timeout: 30_000 }
            )
            return { success: true, provider: 'macos-say' }
        }
    } catch (err: any) {
        return { success: false, error: `macOS Say: ${err.message}` }
    }
}

function ensureTempDir(): void {
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true })
    }
}

function loadTtsConfig(): TtsConfig {
    const config: TtsConfig = {}

    // OpenAI
    const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_TTS_API_KEY
    if (openaiKey) {
        config.openai = {
            apiKey: openaiKey,
            model: process.env.OPENAI_TTS_MODEL || 'tts-1',
            voice: process.env.OPENAI_TTS_VOICE || 'nova',
            baseUrl: process.env.OPENAI_TTS_BASE_URL,
        }
    }

    // ElevenLabs
    const elevenKey = process.env.ELEVENLABS_API_KEY
    if (elevenKey) {
        config.elevenlabs = {
            apiKey: elevenKey,
            voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
            modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
        }
    }

    // Edge (always available, free)
    config.edge = {
        voice: process.env.EDGE_TTS_VOICE || EDGE_DEFAULT_VOICE,
        lang: process.env.EDGE_TTS_LANG || EDGE_DEFAULT_LANG,
    }

    return config
}

/**
 * Cleanup old temp files
 */
export function cleanupTempFiles(maxAgeMs = 5 * 60 * 1000): number {
    if (!existsSync(TEMP_DIR)) return 0

    const { readdirSync, statSync } = require('node:fs')
    const files = readdirSync(TEMP_DIR) as string[]
    let cleaned = 0
    const now = Date.now()

    for (const file of files) {
        const filePath = join(TEMP_DIR, file)
        try {
            const stat = statSync(filePath)
            if (now - stat.mtimeMs > maxAgeMs) {
                unlinkSync(filePath)
                cleaned++
            }
        } catch { /* ignore */ }
    }

    return cleaned
}

export default {
    speak,
    listVoices,
    cleanupTempFiles,
}
