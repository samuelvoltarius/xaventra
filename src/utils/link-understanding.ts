/**
 * Nova - Link Understanding
 * 
 * Inspired by OpenClaw's link-understanding/ (7 files)
 * URL detection, metadata extraction, and link preview generation.
 */

// ============================================
// Types
// ============================================

export interface LinkMeta {
    url: string
    title?: string
    description?: string
    image?: string
    siteName?: string
    type?: string
    favicon?: string
    statusCode?: number
    contentType?: string
    fetchedAt: number
}

export interface LinkDetectResult {
    urls: string[]
    hasLinks: boolean
    count: number
}

// ============================================
// URL Detection
// ============================================

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi
const DOMAIN_REGEX = /(?:^|\s)((?:[\w-]+\.)+(?:com|org|net|io|dev|app|co|me|ai|de|at|ch|uk|eu|info|biz)(?:\/[^\s]*)?)/gi

/**
 * Detect URLs in text content.
 * Finds both explicit https:// links and bare domain names.
 */
export function detectLinks(text: string): LinkDetectResult {
    const explicit = Array.from(text.matchAll(URL_REGEX)).map(m => m[0])
    const bare = Array.from(text.matchAll(DOMAIN_REGEX))
        .map(m => m[1].trim())
        .filter(d => !explicit.some(u => u.includes(d)))
        .map(d => d.startsWith('http') ? d : `https://${d}`)

    const urls = [...new Set([...explicit, ...bare])]
        .map(u => cleanUrl(u))

    return {
        urls,
        hasLinks: urls.length > 0,
        count: urls.length,
    }
}

/**
 * Clean a URL by removing trailing punctuation and fragments.
 */
function cleanUrl(url: string): string {
    // Remove trailing punctuation that's likely not part of the URL
    let cleaned = url.replace(/[.,;:!?)]+$/, '')
    // Balance parentheses (common in Wikipedia links)
    const openParens = (cleaned.match(/\(/g) || []).length
    const closeParens = (cleaned.match(/\)/g) || []).length
    if (closeParens > openParens) {
        cleaned = cleaned.replace(/\)+$/, (match) => match.slice(0, match.length - (closeParens - openParens)))
    }
    return cleaned
}

// ============================================
// Metadata Extraction
// ============================================

/**
 * Fetch and extract metadata (Open Graph, meta tags) from a URL.
 * Returns structured link preview data.
 */
export async function extractLinkMeta(url: string, timeoutMs = 5000): Promise<LinkMeta> {
    const meta: LinkMeta = { url, fetchedAt: Date.now() }

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Nova-Bot/1.0 (Link Preview)',
                'Accept': 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        })

        clearTimeout(timeout)
        meta.statusCode = response.status
        meta.contentType = response.headers.get('content-type') || undefined

        // Only parse HTML content
        if (!meta.contentType?.includes('text/html')) {
            return meta
        }

        // Read only the first 32KB for efficiency
        const reader = response.body?.getReader()
        if (!reader) return meta

        let html = ''
        const decoder = new TextDecoder()
        let bytesRead = 0
        const maxBytes = 32 * 1024

        while (bytesRead < maxBytes) {
            const { done, value } = await reader.read()
            if (done) break
            html += decoder.decode(value, { stream: true })
            bytesRead += value?.length || 0
        }

        reader.cancel()

        // Parse meta tags
        meta.title = extractMetaContent(html, 'og:title')
            || extractMetaContent(html, 'twitter:title')
            || extractTag(html, 'title')

        meta.description = extractMetaContent(html, 'og:description')
            || extractMetaContent(html, 'twitter:description')
            || extractMetaContent(html, 'description')

        meta.image = extractMetaContent(html, 'og:image')
            || extractMetaContent(html, 'twitter:image')

        meta.siteName = extractMetaContent(html, 'og:site_name')
        meta.type = extractMetaContent(html, 'og:type')

        // Resolve relative image URLs
        if (meta.image && !meta.image.startsWith('http')) {
            const base = new URL(url)
            meta.image = new URL(meta.image, base.origin).href
        }

        // Extract favicon
        const faviconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)
        if (faviconMatch) {
            meta.favicon = faviconMatch[1].startsWith('http')
                ? faviconMatch[1]
                : new URL(faviconMatch[1], new URL(url).origin).href
        }
    } catch (err) {
        // Non-fatal: return what we have
        if (err instanceof Error && err.name === 'AbortError') {
            meta.statusCode = 408 // Timeout
        }
    }

    return meta
}

/**
 * Extract content from an Open Graph or standard meta tag.
 */
function extractMetaContent(html: string, property: string): string | undefined {
    // OG meta: <meta property="og:title" content="...">
    const ogMatch = html.match(
        new RegExp(`<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i')
    )
    if (ogMatch) return decodeHTMLEntities(ogMatch[1])

    // Reversed order: <meta content="..." property="og:title">
    const revMatch = html.match(
        new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`, 'i')
    )
    if (revMatch) return decodeHTMLEntities(revMatch[1])

    return undefined
}

/**
 * Extract content from an HTML tag.
 */
function extractTag(html: string, tag: string): string | undefined {
    const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    return match ? decodeHTMLEntities(match[1].trim()) : undefined
}

/**
 * Decode basic HTML entities.
 */
function decodeHTMLEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
}

// ============================================
// Link Preview Formatting
// ============================================

/**
 * Format link metadata into a readable preview string.
 */
export function formatLinkPreview(meta: LinkMeta): string {
    const parts: string[] = []

    if (meta.title) {
        parts.push(`📎 *${meta.title}*`)
    }

    if (meta.description) {
        const desc = meta.description.length > 200
            ? meta.description.slice(0, 200) + '...'
            : meta.description
        parts.push(desc)
    }

    if (meta.siteName) {
        parts.push(`_${meta.siteName}_`)
    }

    parts.push(meta.url)

    return parts.join('\n')
}

/**
 * Process a text message: detect links, extract metadata, return previews.
 */
export async function processLinksInMessage(text: string): Promise<{
    links: LinkMeta[]
    previews: string[]
}> {
    const detected = detectLinks(text)
    if (!detected.hasLinks) {
        return { links: [], previews: [] }
    }

    // Limit to first 3 links to avoid excessive fetching
    const urlsToProcess = detected.urls.slice(0, 3)

    const results = await Promise.allSettled(
        urlsToProcess.map(url => extractLinkMeta(url))
    )

    const links: LinkMeta[] = []
    const previews: string[] = []

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.title) {
            links.push(result.value)
            previews.push(formatLinkPreview(result.value))
        }
    }

    return { links, previews }
}
