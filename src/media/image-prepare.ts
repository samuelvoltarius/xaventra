/**
 * Pictures that go to a vision model are shrunk first (2.89.3).
 *
 * Live 08.10.2026: a Telegram picture reached the vision model unchanged; a
 * camera original (several MB, 4000+ px) makes a local vision server slow
 * enough that the tool ran into its 90 s limit. One rule for every vision
 * call (main model call and analyze_image): long edge at most 1536 px, JPEG.
 * Small pictures pass untouched. If `sharp` is unavailable or fails, the
 * original is used - shrinking never blocks an answer.
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

export const VISION_MAX_EDGE = 1536
/** Below this size and edge a picture is sent as it is (no needless re-encoding). */
export const VISION_PASSTHROUGH_BYTES = 700 * 1024
export const VISION_JPEG_QUALITY = 80

export interface VisionImage { data: string; mimeType: string }
export interface PreparedVisionImage extends VisionImage { resized: boolean; originalBytes: number; bytes: number }

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
}

export function mimeFromPath(path: string): string {
    return MIME_BY_EXT[extname(path).toLowerCase().replace('.', '')] || 'image/jpeg'
}

export async function prepareVisionImage(image: VisionImage, maxEdge = VISION_MAX_EDGE): Promise<PreparedVisionImage> {
    const original = Buffer.from(String(image.data || ''), 'base64')
    const same = (): PreparedVisionImage => ({ data: image.data, mimeType: image.mimeType, resized: false, originalBytes: original.length, bytes: original.length })
    if (original.length === 0) return same()
    try {
        const sharp = (await import('sharp')).default
        const meta = await sharp(original, { failOn: 'none' }).metadata()
        const edge = Math.max(meta.width || 0, meta.height || 0)
        if (edge > 0 && edge <= maxEdge && original.length <= VISION_PASSTHROUGH_BYTES) return same()
        const out = await sharp(original, { failOn: 'none' })
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: VISION_JPEG_QUALITY })
            .toBuffer()
        if (out.length === 0 || (out.length >= original.length && edge <= maxEdge)) return same()
        return { data: out.toString('base64'), mimeType: 'image/jpeg', resized: true, originalBytes: original.length, bytes: out.length }
    } catch (error) {
        console.warn(`[Bild] Verkleinern übersprungen, Original wird verwendet: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`)
        return same()
    }
}

export async function prepareVisionImageFile(filePath: string, maxEdge = VISION_MAX_EDGE): Promise<PreparedVisionImage> {
    const bytes = readFileSync(filePath)
    return prepareVisionImage({ data: bytes.toString('base64'), mimeType: mimeFromPath(filePath) }, maxEdge)
}
