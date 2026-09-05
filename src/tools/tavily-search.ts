/**
 * Tavily Search API
 * 
 * Optimized for AI agents - filters SEO spam
 * Free tier: 1000 requests/month
 * Get API key: https://tavily.com/
 */

export interface TavilySearchResult {
    title: string
    url: string
    content: string
    score: number
}

export async function tavilySearch(
    query: string,
    apiKey: string,
    count = 5
): Promise<{ query: string; results: TavilySearchResult[]; answer?: string; error?: string }> {
    try {
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                max_results: Math.min(count, 10),
                search_depth: 'basic',
                include_answer: true,
            }),
            signal: AbortSignal.timeout(20000),
        })

        if (!response.ok) {
            const text = await response.text()
            return { query, results: [], error: `Tavily API Error ${response.status}: ${text}` }
        }

        const data = await response.json() as {
            results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
            answer?: string
        }

        const results = (data.results || []).map(r => ({
            title: r.title || '',
            url: r.url || '',
            content: r.content || '',
            score: r.score || 0,
        }))

        console.log(`[Tavily Search] ${results.length} Ergebnisse für: ${query}`)

        return {
            query,
            results,
            answer: data.answer, // AI-generated answer from Tavily
        }

    } catch (err: any) {
        return { query, results: [], error: err.message }
    }
}

export const tavilySearchTool = {
    name: 'tavily_search',
    description: 'AI-optimierte Suche mit Tavily - filtert SEO-Spam und liefert präzise Ergebnisse (benötigt API Key)',
    category: 'browser' as const,
    parameters: [
        { name: 'query', type: 'string' as const, description: 'Suchanfrage', required: true },
        { name: 'count', type: 'number' as const, description: 'Anzahl Ergebnisse (max 10)', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const { getNovaConfig } = await import('../core/config.js')
        const config = getNovaConfig()
        const apiKey = config.apis?.tavily_key

        if (!apiKey) {
            return {
                action: 'REQUEST_API_KEY',
                message: '🔍 Ich brauche einen Tavily API Key um zu suchen!\n\n' +
                    '**So bekommst du einen (kostenlos):**\n' +
                    '1. Gehe zu https://tavily.com/\n' +
                    '2. Erstelle einen Account\n' +
                    '3. Kopiere deinen API Key\n' +
                    '4. Sag mir: `/apikey tavily DEIN-KEY`\n\n' +
                    '(1000 Suchen/Monat kostenlos!)',
            }
        }

        return tavilySearch(
            params.query as string,
            apiKey,
            (params.count as number) || 5
        )
    },
}

export default { tavilySearch, tavilySearchTool }
