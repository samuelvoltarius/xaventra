/**
 * Nova Image Generation Tool
 *
 * Generates images using OpenAI DALL-E 3 API.
 * Auth: Uses OPENAI_API_KEY env var, or OpenAI OAuth token.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Constants
// ============================================

const ENDPOINT = 'https://api.openai.com/v1/images/generations'
const IMAGE_DIR = join(process.cwd(), '.nova-data', 'images')

async function resolveComfyEndpoint(): Promise<string | null> {
    const probe = async (base: string) => fetch(`${base}/system_stats`, {
        signal: AbortSignal.timeout(2_000),
    }).then(r => r.ok).catch(() => false)
    const tunnel = 'http://127.0.0.1:18188'
    if (await probe(tunnel)) return tunnel

    try {
        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))
        const node = (config.nodes || []).find((entry: any) => entry?.services?.comfyui)
        const direct = String(node?.services?.comfyui || '').replace(/\/$/, '')
        if (direct && await probe(direct)) return direct

        // ComfyUI may be intentionally private on the Spark. Reuse Nova's
        // configured SSH identity and expose it only on localhost.
        if (node?.host) {
            const child = spawn('ssh', [
                '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
                '-o', 'ServerAliveInterval=30', '-L',
                '127.0.0.1:18188:127.0.0.1:8188', String(node.host),
            ], { detached: true, stdio: 'ignore', windowsHide: true })
            child.unref()
            for (let i = 0; i < 8; i++) {
                await new Promise(resolve => setTimeout(resolve, 250))
                if (await probe(tunnel)) return tunnel
            }
        }
    } catch { /* ComfyUI is optional; cloud provider may still work */ }
    return null
}

async function generateWithComfyUI(prompt: string, outputPath: string, aspectRatio: string) {
    const base = await resolveComfyEndpoint()
    if (!base) return null
    const dimensions: Record<string, [number, number]> = {
        '1:1': [1024, 1024], '16:9': [1216, 704], '9:16': [704, 1216],
        '4:3': [1152, 896], '3:4': [896, 1152],
    }
    const [width, height] = dimensions[aspectRatio] || dimensions['1:1']
    const objectInfo: any = await fetch(`${base}/object_info/CheckpointLoaderSimple`, {
        signal: AbortSignal.timeout(5_000),
    }).then(r => r.json())
    const checkpoints: string[] = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || []
    const checkpoint = checkpoints.find(name => /realvis|sdxl/i.test(name)) || checkpoints[0]
    if (!checkpoint) throw new Error('ComfyUI: kein Bild-Checkpoint installiert')

    const workflow = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, distorted, watermark, text', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
        '5': { class_type: 'KSampler', inputs: { seed: Date.now() % 2_147_483_647, steps: 28, cfg: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'Nova', images: ['6', 0] } },
    }
    const queued: any = await fetch(`${base}/prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }), signal: AbortSignal.timeout(10_000),
    }).then(async r => {
        if (!r.ok) throw new Error(`ComfyUI queue HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        return r.json()
    })
    if (!queued.prompt_id) throw new Error('ComfyUI hat keine prompt_id geliefert')
    for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 1_000))
        const history: any = await fetch(`${base}/history/${queued.prompt_id}`, {
            signal: AbortSignal.timeout(5_000),
        }).then(r => r.json())
        const record = history?.[queued.prompt_id]
        if (!record) continue
        if (record.status?.status_str === 'error') throw new Error('ComfyUI Workflow fehlgeschlagen')
        const image = Object.values(record.outputs || {}).flatMap((output: any) => output.images || [])[0] as any
        if (!image) continue
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
        const imageBuffer = await fetch(`${base}/view?${params}`, { signal: AbortSignal.timeout(15_000) }).then(r => r.arrayBuffer())
        const bytes = Buffer.from(new Uint8Array(imageBuffer))
        writeFileSync(outputPath, bytes)
        return { path: outputPath, model: `comfyui/${checkpoint}` }
    }
    throw new Error('ComfyUI Bildgenerierung Timeout')
}

// ============================================
// Auth Token Loading
// ============================================

async function getApiKey(): Promise<string> {
    // 1. Direct API key from env
    const envKey = process.env.OPENAI_API_KEY
    if (envKey) return envKey

    // 2. OpenAI OAuth token (auto-refreshes if expired)
    try {
        const { getOpenAIAccessToken } = await import('../auth/openai-oauth.js')
        const token = await getOpenAIAccessToken()
        if (token) return token
    } catch { /* OAuth not available */ }

    throw new Error('Kein OpenAI API-Key gefunden. Setze OPENAI_API_KEY oder nutze /login openai.')
}

// ============================================
// Model Resolution (via central config/resolver)
// ============================================

async function resolveImageModel(): Promise<string> {
    try {
        const { resolveModel } = await import('../core/model-resolver.js')
        const resolved = await resolveModel('image_gen')
        if (resolved) {
            console.log(`[ImageGen] 🎯 Model from resolver: ${resolved.id} (${resolved.provider})`)
            return resolved.id
        }
    } catch (err) {
        console.log(`[ImageGen] ⚠️ Model resolver unavailable: ${err}`)
    }

    // Fallback if resolver has no image model yet
    return 'dall-e-3'
}

// ============================================
// Model-aware size mapping
// ============================================

function getSizeForModel(model: string, aspectRatio: string): string {
    const isGptImage = model.startsWith('gpt-image')

    const sizeMap: Record<string, string> = isGptImage
        ? {
            '1:1': '1024x1024',
            '16:9': '1536x1024',
            '9:16': '1024x1536',
            '4:3': '1024x1024',
            '3:4': '1024x1536',
        }
        : {
            // DALL-E sizes
            '1:1': '1024x1024',
            '16:9': '1792x1024',
            '9:16': '1024x1792',
            '4:3': '1024x1024',
            '3:4': '1024x1792',
        }

    return sizeMap[aspectRatio] || '1024x1024'
}

// ============================================
// Image Generation
// ============================================

export async function generateImage(
    prompt: string,
    options: { aspectRatio?: string; outputPath?: string; background?: string } = {}
): Promise<{ path: string; revisedPrompt?: string; model: string }> {
    // Ensure image directory exists
    if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true })

    const outputPath = options.outputPath || join(IMAGE_DIR, `nova_${Date.now()}.png`)
    const comfyResult = await generateWithComfyUI(prompt, outputPath, options.aspectRatio || '1:1')
    if (comfyResult) {
        console.log(`[ImageGen] Image saved (${comfyResult.model}): ${outputPath}`)
        return comfyResult
    }

    const apiKey = await getApiKey()
    const model = await resolveImageModel()
    const size = getSizeForModel(model, options.aspectRatio || '1:1')

    console.log(`[ImageGen] 🎨 Generating image with ${model}: "${prompt.substring(0, 60)}..." (${size})`)

    // Build request body — GPT Image models support extra fields
    const isGptImage = model.startsWith('gpt-image')
    const requestBody: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
    }

    // GPT Image models support background transparency
    if (isGptImage && options.background) {
        requestBody.background = options.background
    }

    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
        const errorText = await response.text()
        if (response.status === 429) {
            throw new Error('Rate Limit erreicht (429). Quota erschöpft. Versuche es später erneut.')
        }
        throw new Error(`Image API Fehler (${response.status}): ${errorText.substring(0, 200)}`)
    }

    const data = await response.json() as {
        data?: Array<{ b64_json?: string; revised_prompt?: string }>
    }

    const imageData = data.data?.[0]?.b64_json
    if (!imageData) {
        throw new Error('Kein Bild in der API-Antwort gefunden.')
    }

    writeFileSync(outputPath, Buffer.from(imageData, 'base64'))
    console.log(`[ImageGen] ✅ Image saved (${model}): ${outputPath}`)

    return {
        path: outputPath,
        revisedPrompt: data.data?.[0]?.revised_prompt,
        model,
    }
}

// ============================================
// Tool Definition for Nova Registry
// ============================================

export const imageGenToolDef = {
    name: 'generate_image',
    description: 'Generiert ein Bild basierend auf einer Beschreibung. Nutzt DALL-E 3 Image Generation. Gibt den Dateipfad des generierten Bildes zurück.',
    parameters: {
        type: 'object' as const,
        properties: {
            prompt: {
                type: 'string',
                description: 'Beschreibung des zu generierenden Bildes (Englisch empfohlen für beste Ergebnisse)',
            },
            aspect_ratio: {
                type: 'string',
                description: 'Seitenverhältnis: 1:1 (Standard), 16:9, 9:16, 4:3, 3:4',
            },
        },
        required: ['prompt'],
    },
}

export async function executeImageGen(args: Record<string, unknown>): Promise<string> {
    const prompt = String(args.prompt || '')
    const aspectRatio = String(args.aspect_ratio || '1:1')

    if (!prompt) return '❌ Kein Prompt angegeben.'

    try {
        const result = await generateImage(prompt, { aspectRatio })
        let response = `✅ Bild generiert: ${result.path}`
        if (result.revisedPrompt) response += `\nRevisierter Prompt: ${result.revisedPrompt}`

        // Auto-send via Telegram if available
        try {
            const { getTelegramAdapter } = await import('../channels/telegram.js')
            const tg = getTelegramAdapter()
            if (tg) {
                let chatId = tg.getLastActiveChat()

                // Fallback: Check global state for active chat
                if (!chatId) {
                    const globalState = (globalThis as any).__novaState
                    chatId = globalState?.lastActiveChatId
                }

                if (chatId) {
                    // Never expose the raw user/planner prompt as a photo caption.
                    await tg.sendPhoto(chatId, result.path, `🖼️ Erstellt mit ${result.model}`)
                    response += '\n📤 Bild an Telegram gesendet.'
                    console.log(`[ImageGen] ✅ Auto-sent photo to chat ${chatId}`)
                } else {
                    console.log('[ImageGen] ⚠️ Kein aktiver Chat — Bild gespeichert, aber nicht gesendet.')
                    response += '\n⚠️ Kein aktiver Chat — nutze send_file zum Senden.'
                }
            }
        } catch (sendErr) {
            const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr)
            console.log(`[ImageGen] ❌ Telegram auto-send failed: ${errMsg}`)
            response += `\n⚠️ Auto-Send fehlgeschlagen: ${errMsg}. Bild ist unter ${result.path} gespeichert.`
        }

        return response
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[ImageGen] ❌ Error: ${msg}`)
        return `❌ Bildgenerierung fehlgeschlagen: ${msg}`
    }
}
