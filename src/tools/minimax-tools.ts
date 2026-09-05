/**
 * Nova Tools — MiniMax API Integration
 *
 * Implements: TTS (speech-2.8-hd), Image Generation (image-01),
 *             Image Vision (M3), Video Generation (I2V-01/Hailuo-2.3)
 *
 * API Key: from xaventra.config.json providers.minimax.apiKey
 * Base URL: https://api.minimax.io
 *
 * Critical gotchas (from Samuel_agentbot's guide):
 * - TTS audio output is HEX-encoded, NOT base64 → use Buffer.from(hex, 'hex')
 * - Image upload for I2V not directly possible → use CDN URL from image_generation
 * - Video generation is async → poll /v1/query/video_generation every 30s
 * - M3 vision input uses URLs, not base64
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NovaTool } from './complete-registry.js'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Config
// ============================================

const BASE_URL = 'https://api.minimax.io'

function getMiniMaxKey(): string {
    try {
        const cfgPath = resolveConfigPath()
        if (existsSync(cfgPath)) {
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
            const key = cfg.providers?.minimax?.apiKey || cfg.apis?.minimax_key
            if (key) return key
        }
    } catch { /* fall through */ }
    return process.env.MINIMAX_API_KEY || ''
}

function headers(): Record<string, string> {
    return {
        'Authorization': `Bearer ${getMiniMaxKey()}`,
        'Content-Type': 'application/json',
    }
}

// ============================================
// TTS — speech-2.8-hd
// ============================================

export interface TTSOptions {
    text: string
    voice?: string       // Default: German_SweetLady
    model?: string       // Default: speech-2.8-hd
    format?: 'mp3' | 'wav' | 'pcm'
    speed?: number       // 0.5–2.0
    outPath?: string     // Save to file
}

export interface TTSResult {
    audioPath?: string
    audioBuffer?: Buffer
    durationHint?: number
    characters: number
}

export async function minimaxTTS(opts: TTSOptions): Promise<TTSResult> {
    const key = getMiniMaxKey()
    if (!key) throw new Error('MiniMax API Key nicht konfiguriert')

    const body = {
        model: opts.model || 'speech-2.8-hd',
        text: opts.text,
        voice_setting: {
            voice_id: opts.voice || 'German_SweetLady',
            speed: opts.speed || 1.0,
        },
        audio_setting: {
            format: opts.format || 'mp3',
            sample_rate: 32000,
        },
    }

    const res = await fetch(`${BASE_URL}/v1/t2a_v2`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    })

    if (!res.ok) {
        const err = await res.text()
        throw new Error(`MiniMax TTS Fehler ${res.status}: ${err}`)
    }

    const data = await res.json() as any

    // Audio is HEX-encoded (NOT base64!)
    const hexAudio = data?.data?.audio
    if (!hexAudio) throw new Error('MiniMax TTS: Kein Audio in Antwort')

    const audioBuffer = Buffer.from(hexAudio, 'hex')

    // Save to file if path given or use temp
    const outDir = join(process.cwd(), '.nova-voice')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    const outPath = opts.outPath || join(outDir, `tts_${Date.now()}.${opts.format || 'mp3'}`)
    writeFileSync(outPath, audioBuffer)

    console.log(`[MiniMax TTS] ✅ ${opts.text.slice(0, 50)}... → ${outPath} (${audioBuffer.length} bytes)`)

    return {
        audioPath: outPath,
        audioBuffer,
        characters: opts.text.length,
    }
}

// ============================================
// Image Generation — image-01
// ============================================

export interface ImageGenOptions {
    prompt: string
    model?: string         // image-01 | image-01-live
    aspectRatio?: string   // 16:9 | 1:1 | 9:16 | 4:3
    n?: number             // 1-4
    outDir?: string
}

export interface ImageGenResult {
    imageUrls: string[]
    savedPaths: string[]
    prompt: string
}

export async function minimaxImageGen(opts: ImageGenOptions): Promise<ImageGenResult> {
    const key = getMiniMaxKey()
    if (!key) throw new Error('MiniMax API Key nicht konfiguriert')

    const body = {
        model: opts.model || 'image-01',
        prompt: opts.prompt,
        n: opts.n || 1,
        aspect_ratio: opts.aspectRatio || '1:1',
    }

    const res = await fetch(`${BASE_URL}/v1/image_generation`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    })

    if (!res.ok) {
        const err = await res.text()
        throw new Error(`MiniMax Image Gen Fehler ${res.status}: ${err}`)
    }

    const data = await res.json() as any
    const imageUrls: string[] = data?.data?.image_urls || []

    if (imageUrls.length === 0) throw new Error('MiniMax Image Gen: Keine Bilder generiert')

    // Download and save
    const outDir = opts.outDir || join(process.cwd(), '.nova-images')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    const savedPaths: string[] = []
    for (let i = 0; i < imageUrls.length; i++) {
        const imgRes = await fetch(imageUrls[i])
        if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer())
            const path = join(outDir, `img_${Date.now()}_${i}.png`)
            writeFileSync(path, buf)
            savedPaths.push(path)
        }
    }

    console.log(`[MiniMax ImageGen] ✅ ${savedPaths.length} Bild(er) generiert`)
    return { imageUrls, savedPaths, prompt: opts.prompt }
}

// ============================================
// Image Vision — M3 multimodal
// ============================================

export async function minimaxVision(imageUrl: string, question: string): Promise<string> {
    const key = getMiniMaxKey()
    if (!key) throw new Error('MiniMax API Key nicht konfiguriert')

    const body = {
        model: 'MiniMax-M3',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: question },
                { type: 'image', source: { type: 'url', url: imageUrl } },
            ],
        }],
        max_tokens: 1000,
    }

    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    })

    if (!res.ok) {
        const err = await res.text()
        throw new Error(`MiniMax Vision Fehler ${res.status}: ${err}`)
    }

    const data = await res.json() as any
    return data?.choices?.[0]?.message?.content || 'Keine Antwort'
}

// ============================================
// Video Generation — async (Hailuo-2.3 / I2V-01)
// ============================================

export interface VideoGenOptions {
    prompt: string
    model?: string            // MiniMax-Hailuo-2.3 (T2V) | I2V-01 (Image-to-Video)
    firstFrameImageUrl?: string  // For I2V: CDN URL from image_generation
    duration?: number         // seconds
}

export interface VideoGenResult {
    taskId: string
    status: 'pending' | 'processing' | 'success' | 'failed'
    videoUrl?: string
    downloadPath?: string
}

export async function minimaxVideoStart(opts: VideoGenOptions): Promise<string> {
    const key = getMiniMaxKey()
    if (!key) throw new Error('MiniMax API Key nicht konfiguriert')

    const body: Record<string, unknown> = {
        model: opts.model || 'MiniMax-Hailuo-2.3',
        prompt: opts.prompt,
    }
    if (opts.firstFrameImageUrl) {
        body.first_frame_image = opts.firstFrameImageUrl
    }

    const res = await fetch(`${BASE_URL}/v1/video_generation`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    })

    if (!res.ok) {
        const err = await res.text()
        throw new Error(`MiniMax Video Gen Fehler ${res.status}: ${err}`)
    }

    const data = await res.json() as any
    const taskId = data?.task_id
    if (!taskId) throw new Error('MiniMax Video Gen: Kein task_id')

    console.log(`[MiniMax VideoGen] 🎬 Task gestartet: ${taskId}`)
    return taskId
}

export async function minimaxVideoStatus(taskId: string): Promise<VideoGenResult> {
    const key = getMiniMaxKey()
    if (!key) throw new Error('MiniMax API Key nicht konfiguriert')

    const res = await fetch(`${BASE_URL}/v1/query/video_generation?task_id=${taskId}`, {
        headers: { Authorization: `Bearer ${key}` },
    })

    if (!res.ok) throw new Error(`MiniMax Video Status Fehler ${res.status}`)

    const data = await res.json() as any
    const status = (data?.status || '').toLowerCase()

    if (status === 'success' && data?.file_id) {
        // Get download URL
        const fileRes = await fetch(`${BASE_URL}/v1/files/retrieve?file_id=${data.file_id}`, {
            headers: { Authorization: `Bearer ${key}` },
        })
        const fileData = await fileRes.json() as any
        const videoUrl = fileData?.file?.download_url

        // Download
        if (videoUrl) {
            const outDir = join(process.cwd(), '.nova-videos')
            if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
            const downloadPath = join(outDir, `video_${taskId}.mp4`)
            const vidRes = await fetch(videoUrl)
            if (vidRes.ok) {
                writeFileSync(downloadPath, Buffer.from(await vidRes.arrayBuffer()))
                console.log(`[MiniMax VideoGen] ✅ Video gespeichert: ${downloadPath}`)
                return { taskId, status: 'success', videoUrl, downloadPath }
            }
        }
        return { taskId, status: 'success', videoUrl }
    }

    const mapped = status === 'processing' ? 'processing' :
        status === 'fail' ? 'failed' : 'pending'

    return { taskId, status: mapped as any }
}

// ============================================
// Nova Tools — registered in complete-registry
// ============================================

export const minimaxTools: NovaTool[] = [
    {
        name: 'minimax_tts',
        description: 'Generiert Audio/Sprache aus Text mit MiniMax TTS (speech-2.8-hd, HD-Qualität). Deutsche Stimmen verfügbar. Gibt Pfad zur MP3-Datei zurück.',
        category: 'media',
        parameters: [
            { name: 'text', type: 'string', description: 'Text der gesprochen werden soll', required: true },
            { name: 'voice', type: 'string', description: 'Stimme: German_SweetLady (default), German_Gentleman, Friendly_Person, Calm_Woman', required: false },
            { name: 'speed', type: 'number', description: 'Geschwindigkeit 0.5–2.0 (default: 1.0)', required: false },
        ],
        handler: async (params) => {
            const result = await minimaxTTS({
                text: params.text as string,
                voice: params.voice as string | undefined,
                speed: params.speed as number | undefined,
            })
            return {
                success: true,
                audioPath: result.audioPath,
                characters: result.characters,
                message: `✅ Audio generiert: ${result.audioPath}`,
            }
        },
    },
    {
        name: 'minimax_image_gen',
        description: 'Generiert ein Bild mit MiniMax image-01. Gibt URL und lokalen Pfad zurück. Für Video-Generierung: die URL direkt als first_frame_image nutzen.',
        category: 'media',
        parameters: [
            { name: 'prompt', type: 'string', description: 'Bildbeschreibung auf Englisch (bessere Ergebnisse)', required: true },
            { name: 'aspect_ratio', type: 'string', description: 'Seitenverhältnis: 1:1 (default), 16:9, 9:16, 4:3', required: false },
            { name: 'model', type: 'string', description: 'image-01 (default) oder image-01-live (mehr Details)', required: false },
        ],
        handler: async (params) => {
            const result = await minimaxImageGen({
                prompt: params.prompt as string,
                aspectRatio: params.aspect_ratio as string | undefined,
                model: params.model as string | undefined,
            })
            return {
                success: true,
                imageUrl: result.imageUrls[0],
                savedPath: result.savedPaths[0],
                allUrls: result.imageUrls,
                message: `✅ Bild generiert: ${result.savedPaths[0] || result.imageUrls[0]}`,
            }
        },
    },
    {
        name: 'minimax_vision',
        description: 'Analysiert ein Bild (URL) mit MiniMax M3 Vision. Erkennt Objekte, Texte, Szenen. Für Bilder von URLs — z.B. aus minimax_image_gen oder anderen Quellen.',
        category: 'media',
        parameters: [
            { name: 'image_url', type: 'string', description: 'URL des Bildes (https://...)', required: true },
            { name: 'question', type: 'string', description: 'Was soll analysiert werden? (default: Beschreibe das Bild)', required: false },
        ],
        handler: async (params) => {
            const question = (params.question as string) || 'Beschreibe dieses Bild detailliert auf Deutsch.'
            const answer = await minimaxVision(params.image_url as string, question)
            return { success: true, analysis: answer }
        },
    },
    {
        name: 'minimax_video_start',
        description: 'Startet eine Video-Generierung mit MiniMax (async). Gibt task_id zurück. Mit minimax_video_status den Status abfragen. Für Image-to-Video: image_url aus minimax_image_gen nutzen.',
        category: 'media',
        parameters: [
            { name: 'prompt', type: 'string', description: 'Video-Beschreibung/Bewegungsanweisung', required: true },
            { name: 'image_url', type: 'string', description: 'Optional: Start-Frame (CDN URL aus minimax_image_gen) für Image-to-Video', required: false },
            { name: 'model', type: 'string', description: 'MiniMax-Hailuo-2.3 (T2V, default) oder I2V-01 (Image-to-Video)', required: false },
        ],
        handler: async (params) => {
            const taskId = await minimaxVideoStart({
                prompt: params.prompt as string,
                firstFrameImageUrl: params.image_url as string | undefined,
                model: params.model as string | undefined,
            })
            return {
                success: true,
                taskId,
                message: `🎬 Video-Generierung gestartet (task_id: ${taskId}). Dauert 3-5 Minuten. Mit minimax_video_status(${taskId}) prüfen.`,
            }
        },
    },
    {
        name: 'minimax_video_status',
        description: 'Prüft den Status einer MiniMax Video-Generierung. Bei status=success gibt es den Download-Pfad. Alle 30-60s abfragen.',
        category: 'media',
        parameters: [
            { name: 'task_id', type: 'string', description: 'Task-ID aus minimax_video_start', required: true },
        ],
        handler: async (params) => {
            const result = await minimaxVideoStatus(params.task_id as string)
            return {
                ...result,
                message: result.status === 'success'
                    ? `✅ Video fertig: ${result.downloadPath || result.videoUrl}`
                    : result.status === 'processing'
                        ? '⏳ Video wird noch generiert... In 30s nochmal prüfen.'
                        : result.status === 'failed'
                            ? '❌ Video-Generierung fehlgeschlagen'
                            : '⏳ Video in der Warteschlange...',
            }
        },
    },
]

export default { minimaxTools, minimaxTTS, minimaxImageGen, minimaxVision, minimaxVideoStart, minimaxVideoStatus }
