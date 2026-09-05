/**
 * Brave Search API
 * 
 * Free tier: 2000 requests/month
 * Get API key: https://brave.com/search/api/
 */

export interface BraveSearchResult {
    title: string
    url: string
    description: string
}

export async function braveSearch(
    query: string,
    apiKey: string,
    count = 5
): Promise<{ query: string; results: BraveSearchResult[]; error?: string }> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(count, 10)))

    try {
        const response = await fetch(url.toString(), {
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': apiKey,
            },
            signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
            const text = await response.text()
            return { query, results: [], error: `Brave API Error ${response.status}: ${text}` }
        }

        const data = await response.json() as {
            web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
        }

        const results = (data.web?.results || []).map(r => ({
            title: r.title || '',
            url: r.url || '',
            description: r.description || '',
        }))

        console.log(`[Brave Search] ${results.length} Ergebnisse für: ${query}`)
        return { query, results }

    } catch (err: any) {
        return { query, results: [], error: err.message }
    }
}

export const braveSearchTool = {
    name: 'brave_search',
    description: 'Suche im Internet mit Brave Search API (benötigt API Key in Config)',
    category: 'browser' as const,
    parameters: [
        { name: 'query', type: 'string' as const, description: 'Suchanfrage', required: true },
        { name: 'count', type: 'number' as const, description: 'Anzahl Ergebnisse (max 10)', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const { getNovaConfig } = await import('../core/config.js')
        const config = getNovaConfig()
        const apiKey = config.apis?.brave_search_key

        if (!apiKey) {
            return {
                action: 'REQUEST_API_KEY',
                message: '🔍 Ich brauche einen Brave Search API Key um zu suchen!\n\n' +
                    '**So bekommst du einen (kostenlos):**\n' +
                    '1. Gehe zu https://brave.com/search/api/\n' +
                    '2. Erstelle einen Account\n' +
                    '3. Kopiere deinen API Key\n' +
                    '4. Sag mir: `/apikey brave DEIN-KEY`\n\n' +
                    '(2000 Suchen/Monat kostenlos!)',
            }
        }

        return braveSearch(
            params.query as string,
            apiKey,
            (params.count as number) || 5
        )
    },
}

export default { braveSearch, braveSearchTool }
