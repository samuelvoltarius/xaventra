/**
 * Nova - Canvas/Image Generation Tool
 * 
 * Generate and edit images using AI.
 * Supports OpenAI DALL-E and similar APIs.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface ImageGenConfig {
    provider: 'openai' | 'stability' | 'local'
    apiKey?: string
    model?: string
    outputDir: string
}

export interface GeneratedImage {
    path: string
    prompt: string
    width: number
    height: number
    timestamp: number
    revisedPrompt?: string
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: ImageGenConfig = {
    provider: 'openai',
    model: 'dall-e-3',
    outputDir: '.nova-images',
}

// ============================================
// Image Generator
// ============================================

export class ImageGenerator {
    private config: ImageGenConfig

    constructor(config: Partial<ImageGenConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }

        // Ensure output directory exists
        if (!existsSync(this.config.outputDir)) {
            mkdirSync(this.config.outputDir, { recursive: true })
        }
    }

    // ============================================
    // Generation
    // ============================================

    async generate(
        prompt: string,
        options: {
            size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792'
            quality?: 'standard' | 'hd'
            style?: 'natural' | 'vivid'
        } = {}
    ): Promise<GeneratedImage> {
        console.log(`[ImageGen] Generating: ${prompt.slice(0, 50)}...`)

        const size = options.size || '1024x1024'
        const [width, height] = size.split('x').map(Number)

        switch (this.config.provider) {
            case 'openai':
                return this.generateWithOpenAI(prompt, { ...options, size })
            case 'stability':
                return this.generateWithStability(prompt, width, height)
            default:
                return this.generatePlaceholder(prompt, width, height)
        }
    }

    // ============================================
    // OpenAI DALL-E
    // ============================================

    private async generateWithOpenAI(
        prompt: string,
        options: {
            size?: string
            quality?: 'standard' | 'hd'
            style?: 'natural' | 'vivid'
        }
    ): Promise<GeneratedImage> {
        if (!this.config.apiKey) {
            throw new Error('OpenAI API key required for image generation')
        }

        const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.config.model || 'dall-e-3',
                prompt,
                n: 1,
                size: options.size || '1024x1024',
                quality: options.quality || 'standard',
                style: options.style || 'vivid',
                response_format: 'b64_json',
            }),
        })

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`)
        }

        const data = await response.json() as {
            data: Array<{ b64_json: string; revised_prompt?: string }>
        }

        const imageData = data.data[0]
        const [width, height] = (options.size || '1024x1024').split('x').map(Number)

        // Save image
        const timestamp = Date.now()
        const filename = `image-${timestamp}.png`
        const filepath = join(this.config.outputDir, filename)

        const buffer = Buffer.from(imageData.b64_json, 'base64')
        writeFileSync(filepath, buffer)

        console.log(`[ImageGen] Saved: ${filepath}`)

        return {
            path: filepath,
            prompt,
            width,
            height,
            timestamp,
            revisedPrompt: imageData.revised_prompt,
        }
    }

    // ============================================
    // Stability AI
    // ============================================

    private async generateWithStability(
        prompt: string,
        width: number,
        height: number
    ): Promise<GeneratedImage> {
        const apiKey = process.env.STABILITY_API_KEY || this.config.apiKey

        if (!apiKey) {
            console.log('[ImageGen] No Stability API key, falling back to placeholder')
            return this.generatePlaceholder(prompt, width, height)
        }

        try {
            const response = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    text_prompts: [{ text: prompt, weight: 1 }],
                    cfg_scale: 7,
                    height: Math.min(height, 1024),
                    width: Math.min(width, 1024),
                    samples: 1,
                    steps: 30,
                }),
            })

            if (!response.ok) {
                throw new Error(`Stability API error: ${response.status}`)
            }

            const data = await response.json() as { artifacts: Array<{ base64: string }> }

            // Save image
            const timestamp = Date.now()
            const filename = `stability-${timestamp}.png`
            const filepath = join(this.config.outputDir, filename)

            const buffer = Buffer.from(data.artifacts[0].base64, 'base64')
            writeFileSync(filepath, buffer)

            console.log(`[ImageGen] Stability AI saved: ${filepath}`)

            return {
                path: filepath,
                prompt,
                width,
                height,
                timestamp,
            }
        } catch (err) {
            console.log(`[ImageGen] Stability AI error: ${err}, using placeholder`)
            return this.generatePlaceholder(prompt, width, height)
        }
    }

    // ============================================
    // Placeholder (for testing)
    // ============================================

    private async generatePlaceholder(
        prompt: string,
        width: number,
        height: number
    ): Promise<GeneratedImage> {
        const timestamp = Date.now()
        const filename = `placeholder-${timestamp}.txt`
        const filepath = join(this.config.outputDir, filename)

        // Create a text placeholder
        writeFileSync(filepath, `Image placeholder\nPrompt: ${prompt}\nSize: ${width}x${height}`)

        return {
            path: filepath,
            prompt,
            width,
            height,
            timestamp,
        }
    }

    // ============================================
    // Edit (Inpainting)
    // ============================================

    async edit(
        imagePath: string,
        prompt: string,
        maskPath?: string
    ): Promise<GeneratedImage> {
        console.log(`[ImageGen] Editing: ${imagePath}`)

        // Would implement image editing here
        // For now, just generate new image based on prompt
        return this.generate(prompt)
    }

    // ============================================
    // Variations
    // ============================================

    async createVariation(imagePath: string): Promise<GeneratedImage> {
        console.log(`[ImageGen] Creating variation of: ${imagePath}`)

        // Would implement variations here
        return this.generatePlaceholder('Variation', 1024, 1024)
    }
}

// ============================================
// Factory
// ============================================

let generatorInstance: ImageGenerator | null = null

export function getImageGenerator(apiKey?: string): ImageGenerator {
    if (!generatorInstance) {
        generatorInstance = new ImageGenerator({ apiKey })
    }
    return generatorInstance
}

export function createImageGenerator(config?: Partial<ImageGenConfig>): ImageGenerator {
    return new ImageGenerator(config)
}

export default { ImageGenerator, getImageGenerator, createImageGenerator }
