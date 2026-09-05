/**
 * SearXNG Search — Self-Hosted Privacy-Friendly Search
 *
 * SearXNG = open-source meta-search engine, self-hosted.
 * No API key needed — just the URL of your SearXNG instance.
 *
 * Setup:
 *   /apikey searxng http://your-searxng.local
 *   or set NOVA_SEARXNG_URL in environment
 *
 * JSON API: GET /search?q=<query>&format=json&categories=general
 */

export interface SearXNGResult {
    title: string
    url: string
    content: string
    engine: string
    score?: number
}

export interface SearXNGResponse {
    query: string
    results: SearXNGResult[]
    suggestions?: string[]
    answers?: string[]
    infoboxes?: Array<{ infobox: string; content: string }>
    error?: string
}

export async function searxngSearch(
    query: string,
    baseUrl: string,
    options: {
        count?: number
        categories?: string    // 'general', 'news', 'images', 'science', 'it', 'social media'
        language?: string      // 'de-DE', 'en-US', 'auto'
        timeRange?: 'day' | 'week' | 'month' | 'year'
        safeSearch?: 0 | 1 | 2  // 0=off, 1=moderate, 2=strict
    } = {}
): Promise<SearXNGResponse> {
    const {
        count = 8,
        categories = 'general',
        language = 'auto',
        timeRange,
        safeSearch = 0,
    } = options

    // Normalize base URL
    const base = baseUrl.replace(/\/$/, '')

    const params = new URLSearchParams({
        q: query,
        format: 'json',
        categories,
        language,
        safesearch: String(safeSearch),
    })
    if (timeRange) params.set('time_range', timeRange)

    const url = `${base}/search?${params.toString()}`

    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Nova-AI/2.0 (self-hosted agent)',
            },
            signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
            // Try to give helpful error
            if (response.status === 403) {
                return { query, results: [], error: `SearXNG: Zugriff verweigert (403). Prüfe SearXNG-Config: search.formats muss "json" enthalten.` }
            }
            return { query, results: [], error: `SearXNG HTTP ${response.status}: ${response.statusText}` }
        }

        const data = await response.json() as {
            results?: Array<{
                title?: string
                url?: string
                content?: string
                engine?: string
                engines?: string[]
                score?: number
            }>
            suggestions?: string[]
            answers?: string[]
            infoboxes?: Array<{ infobox?: string; content?: string }>
        }

        const results: SearXNGResult[] = (data.results || [])
            .slice(0, count)
            .map(r => ({
                title: r.title || '',
                url: r.url || '',
                content: r.content || '',
                engine: Array.isArray(r.engines) ? r.engines.join(', ') : (r.engine || 'unknown'),
                score: r.score,
            }))
            .filter(r => r.url)  // Remove entries without URL

        const infoboxes = (data.infoboxes || []).map(ib => ({
            infobox: ib.infobox || '',
            content: ib.content || '',
        }))

        console.log(`[SearXNG] ${results.length} Ergebnisse für: "${query}" (${base})`)
        return {
            query,
            results,
            suggestions: data.suggestions,
            answers: data.answers,
            infoboxes: infoboxes.length > 0 ? infoboxes : undefined,
        }

    } catch (err: any) {
        // Timeout or connection refused
        const msg = err?.code === 'ECONNREFUSED'
            ? `SearXNG nicht erreichbar (${base}). Läuft die Instanz?`
            : err?.name === 'TimeoutError'
                ? `SearXNG Timeout (15s). Instance zu langsam: ${base}`
                : `SearXNG Fehler: ${err.message}`

        console.warn(`[SearXNG] ⚠️ ${msg}`)
        return { query, results: [], error: msg }
    }
}

/**
 * Get SearXNG base URL from config / env
 */
export function getSearXNGUrl(): string | null {
    // 1. Environment variable
    if (process.env.NOVA_SEARXNG_URL) return process.env.NOVA_SEARXNG_URL.trim()

    // 2. nova.config.json
    try {
        const { existsSync, readFileSync } = require('node:fs')
        const { join } = require('node:path')
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.apis?.searxng_url) return config.apis.searxng_url.trim()
        }
    } catch { /* ignore */ }

    return null
}

// ============================================
// Tool Definition
// ============================================

export const searxngSearchTool = {
    name: 'searxng_search',
    description: 'Durchsucht das Web mit SearXNG (selbst-gehostete, private Suchmaschine). Kein API-Key nötig, nur die URL der Instanz.',
    category: 'browser' as const,
    parameters: [
        { name: 'query', type: 'string' as const, description: 'Suchanfrage', required: true },
        { name: 'count', type: 'number' as const, description: 'Anzahl Ergebnisse (Standard: 8)', required: false },
        { name: 'categories', type: 'string' as const, description: 'Kategorien: general, news, science, it, social media (Standard: general)', required: false },
        { name: 'language', type: 'string' as const, description: 'Sprache: de-DE, en-US, auto (Standard: auto)', required: false },
        { name: 'time_range', type: 'string' as const, description: 'Zeitraum: day, week, month, year', required: false },
    ],
    async handler(params: Record<string, unknown>): Promise<string> {
        const query = String(params.query || '')
        if (!query) return '❌ Keine Suchanfrage angegeben.'

        const baseUrl = getSearXNGUrl()
        if (!baseUrl) {
            return `❌ SearXNG nicht konfiguriert.

Setze die URL deiner SearXNG-Instanz:
  \`/apikey searxng http://dein-searxng.local\`

Oder als Umgebungsvariable:
  \`NOVA_SEARXNG_URL=http://searxng.local\`

SearXNG einrichten (Docker):
\`\`\`
docker run -d -p 8080:8080 \\
  -e SEARXNG_SETTINGS_SEARCH_FORMATS=["html","json"] \\
  searxng/searxng
\`\`\``
        }

        const result = await searxngSearch(query, baseUrl, {
            count: Number(params.count) || 8,
            categories: String(params.categories || 'general'),
            language: String(params.language || 'auto'),
            timeRange: params.time_range as 'day' | 'week' | 'month' | 'year' | undefined,
        })

        if (result.error) return `❌ SearXNG Fehler: ${result.error}`
        if (result.results.length === 0) return `🔍 Keine Ergebnisse für: "${query}"`

        let output = `🔍 **SearXNG: ${query}** (${result.results.length} Ergebnisse)\n\n`

        // Instant answer if available
        if (result.answers && result.answers.length > 0) {
            output += `💡 **Antwort:** ${result.answers[0]}\n\n`
        }

        // Infobox
        if (result.infoboxes && result.infoboxes.length > 0) {
            output += `📋 **${result.infoboxes[0].infobox}:** ${result.infoboxes[0].content.slice(0, 200)}...\n\n`
        }

        // Results
        for (const r of result.results) {
            output += `**${r.title}**\n`
            output += `${r.url}\n`
            if (r.content) output += `${r.content.slice(0, 200)}\n`
            output += '\n'
        }

        if (result.suggestions && result.suggestions.length > 0) {
            output += `_Ähnliche Suchen: ${result.suggestions.slice(0, 3).join(', ')}_`
        }

        return output.trim()
    },
}

export default searxngSearchTool
