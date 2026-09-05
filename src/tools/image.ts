/**
 * Nova - Image Processor
 * 
 * Image processing using sharp.
 * Features: Resize, convert, metadata, LLM optimization.
 */

import { readFileSync, writeFileSync } from 'node:fs'

type SharpFactory = typeof import('sharp')['default']

// ============================================
// Types
// ============================================

export interface ImageMetadata {
    width: number
    height: number
    format: string
    size: number
    hasAlpha: boolean
    orientation?: number
    exif?: Record<string, unknown>
}

export interface ResizeOptions {
    width?: number
    height?: number
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
    background?: string
}

export interface ConvertOptions {
    format: 'jpeg' | 'png' | 'webp' | 'avif'
    quality?: number
}

export interface LLMOptimizeOptions {
    maxWidth?: number
    maxHeight?: number
    maxSizeKb?: number
    format?: 'jpeg' | 'png' | 'webp'
}

// ============================================
// Image Processor
// ============================================

export class ImageProcessor {
    private sharp: SharpFactory | null = null

    /**
     * Load sharp library (lazy)
     */
    private async loadSharp(): Promise<SharpFactory> {
        if (this.sharp) return this.sharp

        try {
            const sharpModule = await import('sharp')
            this.sharp = sharpModule.default
            return this.sharp
        } catch (err) {
            throw new Error(`Failed to load sharp: ${err}`)
        }
    }

    /**
     * Get image metadata
     */
    async getMetadata(input: string | Buffer): Promise<ImageMetadata> {
        const sharp = await this.loadSharp()

        const data = typeof input === 'string'
            ? readFileSync(input)
            : input

        const image = sharp(data)
        const meta = await image.metadata()
        const stats = await image.stats()

        return {
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            format: meta.format ?? 'unknown',
            size: data.length,
            hasAlpha: stats.isOpaque === false,
            orientation: meta.orientation,
            exif: meta.exif ? this.parseExif(meta.exif) : undefined,
        }
    }

    private parseExif(exifBuffer: Buffer): Record<string, unknown> {
        // Basic EXIF parsing - return raw for now
        return { raw: exifBuffer.toString('base64').slice(0, 100) + '...' }
    }

    /**
     * Resize an image
     */
    async resize(
        input: string | Buffer,
        options: ResizeOptions,
        outputPath?: string
    ): Promise<Buffer> {
        const sharp = await this.loadSharp()

        const data = typeof input === 'string'
            ? readFileSync(input)
            : input

        let image = sharp(data)

        image = image.resize({
            width: options.width,
            height: options.height,
            fit: options.fit ?? 'inside',
            background: options.background ?? { r: 255, g: 255, b: 255, alpha: 1 },
        })

        const result = await image.toBuffer()

        if (outputPath) {
            writeFileSync(outputPath, result)
        }

        return result
    }

    /**
     * Convert image format
     */
    async convert(
        input: string | Buffer,
        options: ConvertOptions,
        outputPath?: string
    ): Promise<Buffer> {
        const sharp = await this.loadSharp()

        const data = typeof input === 'string'
            ? readFileSync(input)
            : input

        let image = sharp(data)

        switch (options.format) {
            case 'jpeg':
                image = image.jpeg({ quality: options.quality ?? 80 })
                break
            case 'png':
                image = image.png({ compressionLevel: options.quality ? Math.floor((100 - options.quality) / 10) : 6 })
                break
            case 'webp':
                image = image.webp({ quality: options.quality ?? 80 })
                break
            case 'avif':
                image = image.avif({ quality: options.quality ?? 50 })
                break
        }

        const result = await image.toBuffer()

        if (outputPath) {
            writeFileSync(outputPath, result)
        }

        return result
    }

    /**
     * Optimize image for LLM vision (smaller, right format)
     */
    async optimizeForLLM(
        input: string | Buffer,
        options: LLMOptimizeOptions = {}
    ): Promise<{ buffer: Buffer; metadata: ImageMetadata }> {
        const sharp = await this.loadSharp()

        const maxWidth = options.maxWidth ?? 1024
        const maxHeight = options.maxHeight ?? 1024
        const maxSizeKb = options.maxSizeKb ?? 500
        const format = options.format ?? 'jpeg'

        const data = typeof input === 'string'
            ? readFileSync(input)
            : input

        // Get original metadata
        const originalMeta = await this.getMetadata(data)

        // Calculate resize dimensions
        let width = originalMeta.width
        let height = originalMeta.height

        if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height)
            width = Math.round(width * ratio)
            height = Math.round(height * ratio)
        }

        // Process image
        let image = sharp(data)
            .resize(width, height, { fit: 'inside' })

        // Convert to target format
        let quality = 85
        let result: Buffer

        do {
            switch (format) {
                case 'jpeg':
                    result = await image.clone().jpeg({ quality }).toBuffer()
                    break
                case 'png':
                    result = await image.clone().png().toBuffer()
                    break
                case 'webp':
                    result = await image.clone().webp({ quality }).toBuffer()
                    break
                default:
                    result = await image.clone().jpeg({ quality }).toBuffer()
            }

            // Reduce quality if still too large
            if (result.length > maxSizeKb * 1024 && quality > 20) {
                quality -= 10
            } else {
                break
            }
        } while (result.length > maxSizeKb * 1024)

        const metadata = await this.getMetadata(result)

        console.log(`[ImageProcessor] Optimized: ${originalMeta.width}x${originalMeta.height} -> ${metadata.width}x${metadata.height}, ${(metadata.size / 1024).toFixed(1)}KB`)

        return { buffer: result, metadata }
    }

    /**
     * Convert image to base64 for LLM
     */
    async toBase64(input: string | Buffer, optimize = true): Promise<string> {
        let data: Buffer

        if (optimize) {
            const result = await this.optimizeForLLM(input)
            data = result.buffer
        } else {
            data = typeof input === 'string'
                ? readFileSync(input)
                : input
        }

        return data.toString('base64')
    }

    /**
     * Create thumbnail
     */
    async thumbnail(
        input: string | Buffer,
        size = 150,
        outputPath?: string
    ): Promise<Buffer> {
        return this.resize(input, {
            width: size,
            height: size,
            fit: 'cover',
        }, outputPath)
    }

    /**
     * Rotate image
     */
    async rotate(
        input: string | Buffer,
        angle: number,
        outputPath?: string
    ): Promise<Buffer> {
        const sharp = await this.loadSharp()

        const data = typeof input === 'string'
            ? readFileSync(input)
            : input

        const result = await sharp(data)
            .rotate(angle)
            .toBuffer()

        if (outputPath) {
            writeFileSync(outputPath, result)
        }

        return result
    }

    /**
     * Composite/overlay images
     */
    async composite(
        base: string | Buffer,
        overlay: string | Buffer,
        options: { top?: number; left?: number; opacity?: number } = {},
        outputPath?: string
    ): Promise<Buffer> {
        const sharp = await this.loadSharp()

        const baseData = typeof base === 'string' ? readFileSync(base) : base
        const overlayData = typeof overlay === 'string' ? readFileSync(overlay) : overlay

        const result = await sharp(baseData)
            .composite([{
                input: overlayData,
                top: options.top ?? 0,
                left: options.left ?? 0,
                blend: options.opacity !== undefined ? 'over' : 'over',
            }])
            .toBuffer()

        if (outputPath) {
            writeFileSync(outputPath, result)
        }

        return result
    }
}

// ============================================
// Singleton
// ============================================

let processorInstance: ImageProcessor | null = null

export function getImageProcessor(): ImageProcessor {
    if (!processorInstance) {
        processorInstance = new ImageProcessor()
    }
    return processorInstance
}

export default { ImageProcessor, getImageProcessor }
