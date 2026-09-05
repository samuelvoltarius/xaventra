/**
 * Nova Media Understanding Module
 *
 * Process and analyze media content:
 * - Image analysis (via Vision API)
 * - Audio transcription (via Whisper)
 * - URL content extraction
 * - File type detection
 *
 * Inspired by OpenClaw's media-understanding/ (23 files) and link-understanding/ (7 files)
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

// ============================================
// Types
// ============================================

export interface MediaInfo {
    path: string
    type: 'image' | 'audio' | 'video' | 'document' | 'unknown'
    mime: string
    size: number
    details?: Record<string, unknown>
}

export interface UrlContent {
    url: string
    title?: string
    text: string
    links: string[]
    images: string[]
    fetchedAt: number
    statusCode?: number
    error?: string
}

// ============================================
// MIME Type Detection (like OpenClaw's mime.ts — 5KB)
// ============================================

const MIME_MAP: Record<string, { mime: string; type: MediaInfo['type'] }> = {
    // Images
    '.jpg': { mime: 'image/jpeg', type: 'image' },
    '.jpeg': { mime: 'image/jpeg', type: 'image' },
    '.png': { mime: 'image/png', type: 'image' },
    '.gif': { mime: 'image/gif', type: 'image' },
    '.webp': { mime: 'image/webp', type: 'image' },
    '.svg': { mime: 'image/svg+xml', type: 'image' },
    '.bmp': { mime: 'image/bmp', type: 'image' },
    '.ico': { mime: 'image/x-icon', type: 'image' },
    '.avif': { mime: 'image/avif', type: 'image' },

    // Audio
    '.mp3': { mime: 'audio/mpeg', type: 'audio' },
    '.wav': { mime: 'audio/wav', type: 'audio' },
    '.ogg': { mime: 'audio/ogg', type: 'audio' },
    '.m4a': { mime: 'audio/mp4', type: 'audio' },
    '.flac': { mime: 'audio/flac', type: 'audio' },
    '.aac': { mime: 'audio/aac', type: 'audio' },
    '.opus': { mime: 'audio/opus', type: 'audio' },
    '.webm': { mime: 'audio/webm', type: 'audio' },
    '.wma': { mime: 'audio/x-ms-wma', type: 'audio' },

    // Video
    '.mp4': { mime: 'video/mp4', type: 'video' },
    '.avi': { mime: 'video/x-msvideo', type: 'video' },
    '.mov': { mime: 'video/quicktime', type: 'video' },
    '.mkv': { mime: 'video/x-matroska', type: 'video' },
    '.wmv': { mime: 'video/x-ms-wmv', type: 'video' },

    // Documents
    '.pdf': { mime: 'application/pdf', type: 'document' },
    '.doc': { mime: 'application/msword', type: 'document' },
    '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', type: 'document' },
    '.txt': { mime: 'text/plain', type: 'document' },
    '.md': { mime: 'text/markdown', type: 'document' },
    '.csv': { mime: 'text/csv', type: 'document' },
    '.json': { mime: 'application/json', type: 'document' },
    '.xml': { mime: 'application/xml', type: 'document' },
    '.html': { mime: 'text/html', type: 'document' },
    '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', type: 'document' },
}

/**
 * Detect media type and MIME from file path
 */
export function detectMediaType(filePath: string): MediaInfo {
    const ext = extname(filePath).toLowerCase()
    const mapped = MIME_MAP[ext]

    const info: MediaInfo = {
        path: filePath,
        type: mapped?.type || 'unknown',
        mime: mapped?.mime || 'application/octet-stream',
        size: 0,
    }

    if (existsSync(filePath)) {
        try {
            info.size = statSync(filePath).size
        } catch { /* */ }
    }

    return info
}

/**
 * Sniff MIME type from base64 data header (like OpenClaw's sniff-mime-from-base64.ts)
 */
export function sniffMimeFromBase64(data: string): string | null {
    const prefix = data.slice(0, 20)

    if (prefix.startsWith('/9j/')) return 'image/jpeg'
    if (prefix.startsWith('iVBOR')) return 'image/png'
    if (prefix.startsWith('R0lGO')) return 'image/gif'
    if (prefix.startsWith('UklGR')) return 'image/webp'
    if (prefix.startsWith('AAAA')) return 'video/mp4'
    if (prefix.startsWith('SUQz') || prefix.startsWith('//uw')) return 'audio/mpeg'
    if (prefix.startsWith('UklGR')) return 'audio/wav'
    if (prefix.startsWith('T2dnU')) return 'audio/ogg'
    if (prefix.startsWith('JVBERi')) return 'application/pdf'

    return null
}

// ============================================
// URL Content Extraction (like OpenClaw's link-understanding/)
// ============================================

/**
 * Fetch and extract text content from a URL
 */
export async function fetchUrlContent(url: string): Promise<UrlContent> {
    const result: UrlContent = {
        url,
        text: '',
        links: [],
        images: [],
        fetchedAt: Date.now(),
    }

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Nova/1.0 (Media Understanding)',
                'Accept': 'text/html,application/json,text/plain',
            },
            signal: controller.signal,
        })

        clearTimeout(timeout)
        result.statusCode = response.status

        if (!response.ok) {
            result.error = `HTTP ${response.status}`
            return result
        }

        const contentType = response.headers.get('content-type') || ''
        const body = await response.text()

        if (contentType.includes('json')) {
            // JSON response
            try {
                const json = JSON.parse(body)
                result.text = JSON.stringify(json, null, 2).slice(0, 10000)
            } catch {
                result.text = body.slice(0, 10000)
            }
        } else if (contentType.includes('html')) {
            // HTML — extract text and links
            result.title = extractTitle(body)
            result.text = stripHtml(body).slice(0, 10000)
            result.links = extractLinks(body, url)
            result.images = extractImages(body, url)
        } else {
            // Plain text
            result.text = body.slice(0, 10000)
        }

    } catch (err: any) {
        result.error = err.message
    }

    return result
}

// ============================================
// HTML Helpers
// ============================================

function extractTitle(html: string): string | undefined {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return match ? match[1].trim() : undefined
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
}

function extractLinks(html: string, baseUrl: string): string[] {
    const links: string[] = []
    const regex = /href=["']([^"']+)["']/gi
    let match

    while ((match = regex.exec(html)) !== null) {
        try {
            const href = new URL(match[1], baseUrl).href
            if (href.startsWith('http') && !links.includes(href)) {
                links.push(href)
            }
        } catch { /* invalid URL */ }
    }

    return links.slice(0, 50) // Max 50 links
}

function extractImages(html: string, baseUrl: string): string[] {
    const images: string[] = []
    const regex = /src=["']([^"']+\.(jpg|jpeg|png|gif|webp|svg|avif))["']/gi
    let match

    while ((match = regex.exec(html)) !== null) {
        try {
            const src = new URL(match[1], baseUrl).href
            if (!images.includes(src)) images.push(src)
        } catch { /* invalid URL */ }
    }

    return images.slice(0, 20)
}

// ============================================
// File to Base64 (like OpenClaw's base64.ts)
// ============================================

/**
 * Read a file and return its base64 content
 */
export function fileToBase64(filePath: string): { base64: string; mime: string } | null {
    if (!existsSync(filePath)) return null

    try {
        const buffer = readFileSync(filePath)
        const info = detectMediaType(filePath)
        return {
            base64: buffer.toString('base64'),
            mime: info.mime,
        }
    } catch {
        return null
    }
}

export default {
    detectMediaType,
    sniffMimeFromBase64,
    fetchUrlContent,
    fileToBase64,
}
