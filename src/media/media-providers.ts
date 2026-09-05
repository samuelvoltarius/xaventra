/**
 * Nova Media Providers
 * 
 * Multi-provider AI media pipeline inspired by OpenClaw's media-understanding/
 * (23 files, runner.ts 741 lines, 7 provider dirs)
 * 
 * Supports: Image Vision, Audio Transcription, Video Understanding
 * Providers: OpenAI, Anthropic, Deepgram, Local Whisper, Nova LLM
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { tmpdir, homedir, platform } from 'node:os'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { getDefaultModel } from '../core/model-defaults.js'

// ============================================
// Types
// ============================================

export type MediaCapability = 'image' | 'audio' | 'video'

export interface MediaProvider {
    id: string
    name: string
    capabilities: MediaCapability[]
    requiresApiKey: boolean
    envKey?: string
    describeImage?: (filePath: string, prompt?: string) => Promise<MediaResult>
    transcribeAudio?: (filePath: string) => Promise<MediaResult>
    describeVideo?: (filePath: string, prompt?: string) => Promise<MediaResult>
}

export interface MediaResult {
    text: string
    provider: string
    model?: string
    duration?: number
    tokens?: { input: number; output: number }
    metadata?: Record<string, unknown>
}

export interface MediaAttachment {
    path: string
    mime: string
    size: number
    capability: MediaCapability
    name: string
}

export interface MediaDecision {
    capability: MediaCapability
    provider: string
    model?: string
    outcome: 'success' | 'skipped' | 'failed'
    reason?: string
    duration?: number
}

export interface MediaPipelineResult {
    results: MediaResult[]
    decisions: MediaDecision[]
    attachmentsProcessed: number
}

// ============================================
// MIME → Capability Mapping
// ============================================

const IMAGE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    'image/tiff', 'image/svg+xml', 'image/heic', 'image/heif', 'image/avif',
])

const AUDIO_MIMES = new Set([
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/flac',
    'audio/aac', 'audio/m4a', 'audio/x-m4a', 'audio/webm', 'audio/opus',
    'audio/amr', 'audio/x-wav',
])

const VIDEO_MIMES = new Set([
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/avi', 'video/mov', 'video/mkv', 'video/3gpp',
])

export function mimeToCapability(mime: string): MediaCapability | null {
    const lower = mime.toLowerCase().trim()
    if (IMAGE_MIMES.has(lower)) return 'image'
    if (AUDIO_MIMES.has(lower)) return 'audio'
    if (VIDEO_MIMES.has(lower)) return 'video'
    if (lower.startsWith('image/')) return 'image'
    if (lower.startsWith('audio/')) return 'audio'
    if (lower.startsWith('video/')) return 'video'
    return null
}

// ============================================
// Provider: OpenAI (GPT-4V + Whisper)
// ============================================

function createOpenAIProvider(): MediaProvider {
    const apiKey = () => process.env.OPENAI_API_KEY || ''

    return {
        id: 'openai',
        name: 'OpenAI',
        capabilities: ['image', 'audio'],
        requiresApiKey: true,
        envKey: 'OPENAI_API_KEY',

        describeImage: async (filePath: string, prompt?: string): Promise<MediaResult> => {
            const start = Date.now()
            const key = apiKey()
            if (!key) throw new Error('OPENAI_API_KEY nicht gesetzt')

            const data = readFileSync(filePath)
            const base64 = data.toString('base64')
            const ext = extname(filePath).toLowerCase().replace('.', '')
            const mimeMap: Record<string, string> = {
                jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
            }
            const mime = mimeMap[ext] || 'image/jpeg'

            const body = JSON.stringify({
                model: 'auto',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt || 'Beschreibe dieses Bild detailliert.' },
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
                    ],
                }],
                max_tokens: 1000,
            })

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body,
            })
            const json = await response.json() as Record<string, unknown>
            const choices = json.choices as Array<{ message: { content: string } }>
            const text = choices?.[0]?.message?.content || ''
            const usage = json.usage as { prompt_tokens: number; completion_tokens: number } | undefined

            return {
                text,
                provider: 'openai',
                model: 'auto',
                duration: Date.now() - start,
                tokens: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens } : undefined,
            }
        },

        transcribeAudio: async (filePath: string): Promise<MediaResult> => {
            const start = Date.now()
            const key = apiKey()
            if (!key) throw new Error('OPENAI_API_KEY nicht gesetzt')

            const data = readFileSync(filePath)
            const blob = new Blob([data])
            const formData = new FormData()
            formData.append('file', blob, basename(filePath))
            formData.append('model', 'whisper-1')

            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}` },
                body: formData,
            })
            const json = await response.json() as { text: string }

            return {
                text: json.text || '',
                provider: 'openai',
                model: 'whisper-1',
                duration: Date.now() - start,
            }
        },
    }
}

// Legacy cloud provider removed — use OpenAI instead

// ============================================
// Provider: Anthropic Claude (Vision)
// ============================================

function createAnthropicProvider(): MediaProvider {
    const apiKey = () => process.env.ANTHROPIC_API_KEY || ''

    return {
        id: 'anthropic',
        name: 'Anthropic Claude',
        capabilities: ['image'],
        requiresApiKey: true,
        envKey: 'ANTHROPIC_API_KEY',

        describeImage: async (filePath: string, prompt?: string): Promise<MediaResult> => {
            const start = Date.now()
            const key = apiKey()
            if (!key) throw new Error('ANTHROPIC_API_KEY nicht gesetzt')

            const data = readFileSync(filePath)
            const base64 = data.toString('base64')
            const ext = extname(filePath).toLowerCase().replace('.', '')
            const mimeMap: Record<string, string> = {
                jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                gif: 'image/gif', webp: 'image/webp',
            }
            const mediaType = mimeMap[ext] || 'image/jpeg'

            const body = JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                        { type: 'text', text: prompt || 'Beschreibe dieses Bild detailliert.' },
                    ],
                }],
            })

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                },
                body,
            })
            const json = await response.json() as Record<string, unknown>
            const content = json.content as Array<{ text: string }>
            const text = content?.[0]?.text || ''
            const usage = json.usage as { input_tokens: number; output_tokens: number } | undefined

            return {
                text,
                provider: 'anthropic',
                model: 'claude-sonnet-4-20250514',
                duration: Date.now() - start,
                tokens: usage ? { input: usage.input_tokens, output: usage.output_tokens } : undefined,
            }
        },
    }
}

// ============================================
// Provider: Deepgram (Audio Transcription)
// ============================================

function createDeepgramProvider(): MediaProvider {
    const apiKey = () => process.env.DEEPGRAM_API_KEY || ''

    return {
        id: 'deepgram',
        name: 'Deepgram',
        capabilities: ['audio'],
        requiresApiKey: true,
        envKey: 'DEEPGRAM_API_KEY',

        transcribeAudio: async (filePath: string): Promise<MediaResult> => {
            const start = Date.now()
            const key = apiKey()
            if (!key) throw new Error('DEEPGRAM_API_KEY nicht gesetzt')

            const data = readFileSync(filePath)
            const ext = extname(filePath).toLowerCase().replace('.', '')
            const mimeMap: Record<string, string> = {
                mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
                flac: 'audio/flac', m4a: 'audio/mp4', webm: 'audio/webm',
            }
            const mime = mimeMap[ext] || 'audio/mpeg'

            const response = await fetch(
                'https://api.deepgram.com/v1/listen?model=nova-2&language=de&punctuate=true',
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Token ${key}`,
                        'Content-Type': mime,
                    },
                    body: data,
                }
            )
            const json = await response.json() as Record<string, unknown>
            const results = json.results as { channels: Array<{ alternatives: Array<{ transcript: string }> }> }
            const text = results?.channels?.[0]?.alternatives?.[0]?.transcript || ''

            return { text, provider: 'deepgram', model: 'nova-2', duration: Date.now() - start }
        },
    }
}

// ============================================
// Provider: Local Whisper (CLI)
// ============================================

function createLocalWhisperProvider(): MediaProvider {
    let whisperBinary: string | null = null

    const findWhisper = (): string | null => {
        if (whisperBinary !== null) return whisperBinary
        const candidates = ['whisper-cli', 'whisper', 'whisper.cpp']
        for (const cmd of candidates) {
            try {
                const which = platform() === 'win32' ? 'where' : 'which'
                execSync(`${which} ${cmd}`, { stdio: 'pipe' })
                whisperBinary = cmd
                return cmd
            } catch {
                // not found
            }
        }
        whisperBinary = ''
        return null
    }

    return {
        id: 'local-whisper',
        name: 'Local Whisper',
        capabilities: ['audio'],
        requiresApiKey: false,

        transcribeAudio: async (filePath: string): Promise<MediaResult> => {
            const start = Date.now()
            const binary = findWhisper()
            if (!binary) throw new Error('whisper-cli/whisper nicht gefunden')

            const tmpOut = join(tmpdir(), `nova-whisper-${Date.now()}`)
            try {
                if (binary === 'whisper-cli') {
                    const modelPath = process.env.WHISPER_CPP_MODEL || ''
                    const modelArg = modelPath ? `-m "${modelPath}"` : ''
                    execSync(
                        `${binary} ${modelArg} -otxt -of "${tmpOut}" -np -nt "${filePath}"`,
                        { timeout: 120_000, stdio: 'pipe' }
                    )
                    const outFile = `${tmpOut}.txt`
                    const text = existsSync(outFile) ? readFileSync(outFile, 'utf-8').trim() : ''
                    try { unlinkSync(outFile) } catch { /* ignore */ }
                    return { text, provider: 'local-whisper', model: binary, duration: Date.now() - start }
                } else {
                    const result = execSync(
                        `${binary} --model turbo --output_format txt --output_dir "${tmpdir()}" --verbose False "${filePath}"`,
                        { timeout: 120_000, stdio: 'pipe' }
                    )
                    const text = result.toString().trim()
                    return { text, provider: 'local-whisper', model: binary, duration: Date.now() - start }
                }
            } catch (err: unknown) {
                throw new Error(`Whisper Transkription fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
            }
        },
    }
}

// ============================================
// Provider: Nova Primary LLM (via OAuth)
// Uses the already-connected daemon LLM — no API keys needed!
// ============================================

function createNovaLLMProvider(): MediaProvider {
    return {
        id: 'nova-llm',
        name: 'Nova Primary LLM',
        capabilities: ['image', 'audio', 'video'],
        requiresApiKey: false,

        describeImage: async (filePath: string, prompt?: string): Promise<MediaResult> => {
            const start = Date.now()
            const llm = (globalThis as any).__novaState?.llm
            if (!llm) throw new Error('Nova LLM nicht verfügbar')

            const data = readFileSync(filePath)
            const base64Data = data.toString('base64')
            const ext = extname(filePath).toLowerCase().replace('.', '')
            const mimeMap: Record<string, string> = {
                jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
            }
            const mime = mimeMap[ext] || 'image/jpeg'

            const messages = [{
                role: 'user' as const,
                content: prompt || 'Beschreibe dieses Bild detailliert.',
                image: { data: base64Data, mimeType: mime },
            }]

            const response = await llm.complete(messages)
            const text = response?.content || response?.text || ''

            return {
                text,
                provider: 'nova-llm',
                model: llm.modelId || 'primary',
                duration: Date.now() - start,
            }
        },

        transcribeAudio: async (filePath: string): Promise<MediaResult> => {
            const start = Date.now()
            const llm = (globalThis as any).__novaState?.llm
            if (!llm) throw new Error('Nova LLM nicht verfügbar')

            const data = readFileSync(filePath)
            const base64Data = data.toString('base64')
            const ext = extname(filePath).toLowerCase().replace('.', '')
            const mimeMap: Record<string, string> = {
                mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
                flac: 'audio/flac', m4a: 'audio/mp4', webm: 'audio/webm',
            }
            const mime = mimeMap[ext] || 'audio/mpeg'

            const messages = [{
                role: 'user' as const,
                content: 'Transkribiere dieses Audio vollständig. Gib nur den Text zurück.',
                image: { data: base64Data, mimeType: mime },
            }]

            const response = await llm.complete(messages)
            const text = response?.content || response?.text || ''

            return {
                text,
                provider: 'nova-llm',
                model: llm.modelId || 'primary',
                duration: Date.now() - start,
            }
        },

        describeVideo: async (filePath: string, prompt?: string): Promise<MediaResult> => {
            const start = Date.now()
            const llm = (globalThis as any).__novaState?.llm
            if (!llm) throw new Error('Nova LLM nicht verfügbar')

            const data = readFileSync(filePath)
            const base64Data = data.toString('base64')
            const ext = extname(filePath).toLowerCase().replace('.', '')
            const mimeMap: Record<string, string> = {
                mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
            }
            const mime = mimeMap[ext] || 'video/mp4'

            const messages = [{
                role: 'user' as const,
                content: prompt || 'Beschreibe dieses Video detailliert.',
                image: { data: base64Data, mimeType: mime },
            }]

            const response = await llm.complete(messages)
            const text = response?.content || response?.text || ''

            return {
                text,
                provider: 'nova-llm',
                model: llm.modelId || 'primary',
                duration: Date.now() - start,
            }
        },
    }
}

// ============================================
// Provider Registry
// ============================================

const providerRegistry = new Map<string, MediaProvider>()

function ensureRegistry(): Map<string, MediaProvider> {
    if (providerRegistry.size === 0) {
        const providers = [
            createNovaLLMProvider(),
            createOpenAIProvider(),
            createAnthropicProvider(),
            createDeepgramProvider(),
            createLocalWhisperProvider(),
        ]
        for (const p of providers) {
            providerRegistry.set(p.id, p)
        }
    }
    return providerRegistry
}

export function getProvider(id: string): MediaProvider | undefined {
    return ensureRegistry().get(id)
}

export function listProviders(): MediaProvider[] {
    return [...ensureRegistry().values()]
}

export function getAvailableProviders(): MediaProvider[] {
    return listProviders().filter(p => {
        if (!p.requiresApiKey) return true
        const key = p.envKey ? process.env[p.envKey] : ''
        return Boolean(key)
    })
}

// ============================================
// Auto-Select Best Provider
// ============================================

const PROVIDER_PRIORITY: Record<MediaCapability, string[]> = {
    image: ['nova-llm', 'openai', 'anthropic'],
    audio: ['local-whisper', 'nova-llm', 'openai', 'deepgram'],
    video: ['nova-llm', 'openai'],
}

export function selectBestProvider(capability: MediaCapability): MediaProvider | null {
    const available = getAvailableProviders()
    const order = PROVIDER_PRIORITY[capability]

    for (const id of order) {
        const provider = available.find(p => p.id === id && p.capabilities.includes(capability))
        if (provider) return provider
    }
    return null
}

// ============================================
// Media Pipeline Runner
// ============================================

export async function processMedia(
    filePath: string,
    capability: MediaCapability,
    options?: { provider?: string; prompt?: string }
): Promise<MediaResult> {
    const provider = options?.provider
        ? getProvider(options.provider)
        : selectBestProvider(capability)

    if (!provider) {
        throw new Error(`Kein Provider für ${capability} verfügbar. Setze API Keys: ${PROVIDER_PRIORITY[capability].map(id => getProvider(id)?.envKey).filter(Boolean).join(', ')}`)
    }

    switch (capability) {
        case 'image':
            if (!provider.describeImage) throw new Error(`${provider.name} unterstützt keine Bildanalyse`)
            return await provider.describeImage(filePath, options?.prompt)
        case 'audio':
            if (!provider.transcribeAudio) throw new Error(`${provider.name} unterstützt keine Audio-Transkription`)
            return await provider.transcribeAudio(filePath)
        case 'video':
            if (!provider.describeVideo) throw new Error(`${provider.name} unterstützt keine Videoanalyse`)
            return await provider.describeVideo(filePath, options?.prompt)
    }
}

export async function processMediaBatch(
    attachments: MediaAttachment[],
    options?: { provider?: string; prompt?: string }
): Promise<MediaPipelineResult> {
    const results: MediaResult[] = []
    const decisions: MediaDecision[] = []

    for (const att of attachments) {
        const start = Date.now()
        try {
            const result = await processMedia(att.path, att.capability, options)
            results.push(result)
            decisions.push({
                capability: att.capability,
                provider: result.provider,
                model: result.model,
                outcome: 'success',
                duration: Date.now() - start,
            })
        } catch (err: unknown) {
            decisions.push({
                capability: att.capability,
                provider: options?.provider || 'auto',
                outcome: 'failed',
                reason: err instanceof Error ? err.message : String(err),
                duration: Date.now() - start,
            })
        }
    }

    return { results, decisions, attachmentsProcessed: attachments.length }
}

// ============================================
// File → Attachment Helper
// ============================================

export function fileToAttachment(filePath: string): MediaAttachment | null {
    if (!existsSync(filePath)) return null
    const ext = extname(filePath).toLowerCase()
    const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.webm': 'audio/webm',
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    const capability = mimeToCapability(mime)
    if (!capability) return null

    const stats = statSync(filePath)
    return {
        path: filePath,
        mime,
        size: stats.size,
        capability,
        name: basename(filePath),
    }
}
