/**
 * Nova Web Search Tool
 * 
 * Multi-strategy search:
 * 1. Try Google via Playwright (if available and not CAPTCHA'd)
 * 2. Fallback to Startpage via fetch (no browser needed, no CAPTCHA)
 * 
 * Startpage is a Google proxy that returns real Google results
 * without blocking headless/API requests.
 */

import type { Browser, Page } from 'playwright'

let browser: Browser | null = null
let page: Page | null = null

// ============================================
// Browser Management
// ============================================

async function getPage(): Promise<Page> {
    if (page) return page

    const { chromium } = await import('playwright')

    if (!browser) {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        })
    }

    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })

    // Set realistic user agent
    await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    })

    return page
}

export async function closeBrowser(): Promise<void> {
    if (page) {
        await page.close()
        page = null
    }
    if (browser) {
        await browser.close()
        browser = null
    }
}

// ============================================
// Search Result Type
// ============================================

export interface GoogleSearchResult {
    title: string
    url: string
    snippet: string
}

// ============================================
// Main Search Function (with fallback chain)
// ============================================

export async function googleSearch(
    query: string,
    count = 5
): Promise<{ query: string; results: GoogleSearchResult[]; error?: string }> {
    // Strategy 1: Try Google via Playwright
    const googleResults = await tryGoogleBrowser(query, count)
    if (googleResults.results.length > 0) {
        return googleResults
    }

    // Strategy 2: Startpage via fetch (no browser, no CAPTCHA)
    console.log('[Search] Google blocked/empty, trying Startpage fetch...')
    const startpageResults = await tryStartpageFetch(query, count)
    if (startpageResults.results.length > 0) {
        return startpageResults
    }

    // Strategy 3: DuckDuckGo Lite via fetch
    console.log('[Search] Startpage empty, trying DuckDuckGo Lite...')
    return tryDDGLiteFetch(query, count)
}

// ============================================
// Strategy 1: Google via Playwright
// ============================================

async function tryGoogleBrowser(
    query: string,
    count: number
): Promise<{ query: string; results: GoogleSearchResult[]; error?: string }> {
    try {
        const p = await getPage()

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=de`
        await p.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })

        // Check for CAPTCHA
        const currentUrl = p.url()
        if (currentUrl.includes('/sorry') || currentUrl.includes('recaptcha')) {
            console.log('[Search] Google CAPTCHA detected')
            return { query, results: [] }
        }

        await p.waitForSelector('#search', { timeout: 10000 }).catch(() => null)

        const results = await p.evaluate((maxResults: number): Array<{ title: string; url: string; snippet: string }> => {
            const items: Array<{ title: string; url: string; snippet: string }> = []
            const resultElements = (globalThis as any).document.querySelectorAll('#search .g')

            for (const el of resultElements) {
                if (items.length >= maxResults) break
                const titleEl = el.querySelector('h3')
                const linkEl = el.querySelector('a[href^="http"]')
                const snippetEl = el.querySelector('.VwiC3b, [data-sncf], .IsZvec')
                if (titleEl && linkEl) {
                    items.push({
                        title: titleEl.textContent || '',
                        url: linkEl.href || '',
                        snippet: snippetEl?.textContent || '',
                    })
                }
            }
            return items
        }, count)

        if (results.length > 0) {
            console.log(`[Search] Google: ${results.length} results for: ${query}`)
        }
        return { query, results }

    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.log(`[Search] Google browser failed: ${error}`)
        return { query, results: [] }
    }
}

// ============================================
// Strategy 2: Startpage via fetch (Google proxy)
// ============================================

async function tryStartpageFetch(
    query: string,
    count: number
): Promise<{ query: string; results: GoogleSearchResult[]; error?: string }> {
    try {
        const response = await fetch('https://www.startpage.com/sp/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
            },
            body: `query=${encodeURIComponent(query)}&cat=web&language=deutsch`,
            signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
            return { query, results: [], error: `Startpage HTTP ${response.status}` }
        }

        const html = await response.text()
        const results: GoogleSearchResult[] = []

        // Startpage result blocks contain:
        // - <a class="...result-title..." href="URL">TITLE</a>
        // - <p class="...result-description...">SNIPPET</p>

        // Extract result blocks — each contains a title link + description
        // Pattern: find all result-title links and their nearby descriptions
        const titleRegex = /class="[^"]*result-title[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs
        const descRegex = /class="[^"]*result-description[^"]*"[^>]*>(.*?)<\/p>/gs

        const titles: Array<{ url: string; title: string }> = []
        let m
        while ((m = titleRegex.exec(html)) !== null) {
            const url = m[1]
            const title = m[2].replace(/<[^>]+>/g, '').trim()
            // Skip CSS definitions and non-result entries
            if (title.length > 5 && !title.startsWith('.css-') && url.startsWith('http')) {
                titles.push({ url, title })
            }
        }

        const descriptions: string[] = []
        while ((m = descRegex.exec(html)) !== null) {
            descriptions.push(m[1].replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim())
        }

        for (let i = 0; i < Math.min(titles.length, count); i++) {
            results.push({
                title: titles[i].title,
                url: titles[i].url,
                snippet: descriptions[i] || '',
            })
        }

        console.log(`[Search] Startpage: ${results.length} results for: ${query}`)
        return { query, results }

    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.log(`[Search] Startpage failed: ${error}`)
        return { query, results: [], error }
    }
}

// ============================================
// Strategy 3: DuckDuckGo Lite via fetch
// ============================================

async function tryDDGLiteFetch(
    query: string,
    count: number
): Promise<{ query: string; results: GoogleSearchResult[]; error?: string }> {
    try {
        const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
            return { query, results: [], error: `DDG HTTP ${response.status}` }
        }

        const html = await response.text()

        // DDG Lite: results in <a class="result-link" href="URL">TITLE</a>
        // and <td class="result-snippet">SNIPPET</td>
        const results: GoogleSearchResult[] = []
        const linkRegex = /class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs
        const snippetRegex = /class="result-snippet"[^>]*>(.*?)<\/td>/gs

        const links: Array<{ url: string; title: string }> = []
        let m
        while ((m = linkRegex.exec(html)) !== null) {
            links.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() })
        }

        const snippets: string[] = []
        while ((m = snippetRegex.exec(html)) !== null) {
            snippets.push(m[1].replace(/<[^>]+>/g, '').trim())
        }

        for (let i = 0; i < Math.min(links.length, count); i++) {
            results.push({
                title: links[i].title,
                url: links[i].url,
                snippet: snippets[i] || '',
            })
        }

        console.log(`[Search] DDG Lite: ${results.length} results for: ${query}`)
        return { query, results }

    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.log(`[Search] DDG Lite failed: ${error}`)
        return { query, results: [], error }
    }
}

// ============================================
// Tool Definition for Nova
// ============================================

export const googleSearchTool = {
    name: 'google_search',
    description: 'Suche im Internet — nutzt Google, Startpage oder DuckDuckGo automatisch. Gibt echte Suchergebnisse zurück (Titel, URL, Beschreibung). Braucht keinen API Key.',
    category: 'other' as const,
    parameters: [
        { name: 'query', type: 'string' as const, description: 'Suchanfrage', required: true },
        { name: 'count', type: 'number' as const, description: 'Anzahl Ergebnisse (max 10)', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const query = params.query as string
        const count = Math.min((params.count as number) || 5, 10)
        return googleSearch(query, count)
    },
}

export default {
    googleSearch,
    googleSearchTool,
    closeBrowser,
}
