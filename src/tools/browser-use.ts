/**
 * Nova BrowserUse Tools
 *
 * Full Playwright-based browser control for Nova.
 * One persistent headless Chromium session, auto-closes after 30 min idle.
 *
 * Tools:
 *   browser_open       — open URL (launches browser if needed), returns page text
 *   browser_navigate   — navigate to new URL, reuse existing session
 *   browser_search     — DuckDuckGo search via real browser (no API key)
 *   browser_click      — click element by CSS selector or visible text
 *   browser_type       — type text into input / textarea
 *   browser_scroll     — scroll page up / down
 *   browser_extract    — extract visible text (+ links) from current page
 *   browser_screenshot — screenshot of current page → saved to .nova-screenshots/
 *   browser_get_links  — get all links from current page
 *   browser_status     — show current URL, title, session state
 *   browser_close      — close browser session
 *   searxng_search     — SearXNG metasearch (Google+Bing+DDG+Wikipedia) — no API key
 */

import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { BrowserAdapter } from './browser.js'
import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { getOperatorBrowserManager } from './operator-browser-manager.js'

// Local type alias to avoid circular dep with complete-registry
interface BrowserTool {
    name: string
    description: string
    category: 'browser'
    parameters: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'object'; description: string; required?: boolean }>
    handler: (params: Record<string, unknown>) => Promise<unknown>
}

// ============================================
// Session Management
// ============================================

let _browser: BrowserAdapter | null = null
let _idleTimer: ReturnType<typeof setTimeout> | null = null
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

function resetIdleTimer(): void {
    if (_idleTimer) clearTimeout(_idleTimer)
    _idleTimer = setTimeout(async () => {
        if (_browser?.isRunning()) {
            console.log('[BrowserUse] Idle timeout — closing Chromium')
            await _browser.close().catch(() => {})
        }
        _browser = null
        _idleTimer = null
    }, IDLE_TIMEOUT_MS)
}

async function getSession(): Promise<BrowserAdapter> {
    return getOperatorBrowserManager().getSession(getExecutionPolicyContext().userId || 'system')
}

function getSessionStatus(): { running: boolean; url?: string } {
    const status = getOperatorBrowserManager().status(getExecutionPolicyContext().userId || 'system')
    return { running: status.running }
}

// ============================================
// Screenshot directory
// ============================================

const SCREENSHOT_DIR = join(process.cwd(), '.nova-screenshots')
function ensureScreenshotDir(): void {
    if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true })
}

// ============================================
// DuckDuckGo HTML Search (no Playwright needed — fast + reliable)
// ============================================

interface SearchResult {
    title: string
    url: string
    snippet: string
}

async function duckduckgoSearch(query: string, count: number): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`
    const res = await fetch(url, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/html',
        },
    })
    const html = await res.text()
    const results: SearchResult[] = []

    // DuckDuckGo HTML result blocks: <div class="result results_links ...">
    // Title link:   <a class="result__a" href="...">Title</a>
    // Snippet:      <a class="result__snippet" ...>text</a>
    const blockRe = /<div class="result[^"]*results_links[^"]*"[\s\S]*?<\/div>\s*<\/div>/g
    const blocks = html.match(blockRe) || []

    for (const block of blocks) {
        if (results.length >= count) break
        const titleM = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]+?)<\/a>/i.exec(block)
        const snippetM = /<a[^>]+class="result__snippet"[^>]*>([\s\S]+?)<\/a>/i.exec(block)
        if (!titleM) continue
        const rawUrl = titleM[1]
        // DDG uses redirects like //duckduckgo.com/l/?uddg=... — decode them
        const realUrl = rawUrl.startsWith('//duckduckgo.com/l/')
            ? decodeURIComponent(rawUrl.replace(/^.*[?&]uddg=/, ''))
            : rawUrl
        const title = titleM[2].replace(/<[^>]+>/g, '').trim()
        const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, '').trim() : ''
        if (title && realUrl.startsWith('http')) {
            results.push({ title, url: realUrl, snippet })
        }
    }

    // Fallback: if block regex failed, try simpler link extraction
    if (results.length === 0) {
        const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]+?)<\/a>/gi
        let m: RegExpExecArray | null
        while ((m = linkRe.exec(html)) !== null && results.length < count) {
            const rawUrl = m[1]
            const realUrl = rawUrl.startsWith('//duckduckgo.com/l/')
                ? decodeURIComponent(rawUrl.replace(/^.*[?&]uddg=/, ''))
                : rawUrl
            const title = m[2].replace(/<[^>]+>/g, '').trim()
            if (title && realUrl.startsWith('http')) {
                results.push({ title, url: realUrl, snippet: '' })
            }
        }
    }

    return results.slice(0, count)
}

// ============================================
// Browser Use Tools
// ============================================

export const browserUseTools: BrowserTool[] = [
    // ------------------------------------------
    {
        name: 'browser_open',
        description:
            'Öffnet eine URL im Headless-Chromium (Playwright). Startet den Browser falls nicht aktiv. Gibt Titel, URL und sichtbaren Seitentext zurück. Ideal für Login-Flows, SPAs oder seiten-übergreifende Interaktionen.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'Vollständige URL (inkl. https://)', required: true },
            {
                name: 'wait_for',
                type: 'string',
                description: 'CSS-Selektor — wartet bis Element sichtbar ist (optional)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                const content = await browser.goto(params.url as string)
                if (params.wait_for) {
                    try {
                        await browser.waitFor(params.wait_for as string, 10_000)
                    } catch {
                        // selector not found — ignore, return what we have
                    }
                    const fresh = await browser.getContent()
                    return {
                        url: fresh.url,
                        title: fresh.title,
                        text: fresh.text.slice(0, 8000),
                        linkCount: fresh.links.length,
                    }
                }
                return {
                    url: content.url,
                    title: content.title,
                    text: content.text.slice(0, 8000),
                    linkCount: content.links.length,
                }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_navigate',
        description:
            'Navigiert zu einer URL im laufenden Browser-Session (kein Neustart). Für Link-Navigation, Redirects etc.',
        category: 'browser',
        parameters: [
            { name: 'url', type: 'string', description: 'Ziel-URL', required: true },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                const content = await browser.goto(params.url as string)
                return {
                    url: content.url,
                    title: content.title,
                    text: content.text.slice(0, 8000),
                }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_search',
        description:
            'Sucht im Web über DuckDuckGo mit echtem Browser (kein API-Key nötig). Gibt Titel, URL und Snippet der Top-Ergebnisse zurück. Besser als die DuckDuckGo JSON-API weil echte Ergebnisse.',
        category: 'browser',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchanfrage', required: true },
            {
                name: 'count',
                type: 'number',
                description: 'Anzahl Ergebnisse (Standard: 8, max 20)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const count = Math.min((params.count as number) || 8, 20)
                const results = await duckduckgoSearch(params.query as string, count)
                if (results.length === 0) {
                    return {
                        query: params.query,
                        results: [],
                        note: 'Keine Ergebnisse gefunden. Versuche eine andere Suchanfrage.',
                    }
                }
                return { query: params.query, count: results.length, results }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_click',
        description:
            'Klickt auf ein Element der aktuell geöffneten Seite. Selector kann CSS oder Text-Inhalt sein (z.B. "button:has-text(\'Login\')" oder "#submit").',
        category: 'browser',
        parameters: [
            {
                name: 'selector',
                type: 'string',
                description: 'CSS-Selektor oder Playwright-Locator (z.B. "button#login", "text=Weiter")',
                required: true,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                await browser.click(params.selector as string)
                // Wait briefly for navigation/response
                await browser.wait(1000)
                const content = await browser.getContent()
                return { success: true, currentUrl: content.url, pageTitle: content.title }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_type',
        description:
            'Gibt Text in ein Eingabefeld der aktuellen Seite ein. Löscht vorherigen Inhalt und tippt den neuen Text.',
        category: 'browser',
        parameters: [
            {
                name: 'selector',
                type: 'string',
                description: 'CSS-Selektor des Eingabefelds (z.B. "input[name=q]", "#search")',
                required: true,
            },
            { name: 'text', type: 'string', description: 'Einzugebender Text', required: true },
            {
                name: 'press_enter',
                type: 'boolean',
                description: 'Enter nach dem Tippen drücken (Standard: false)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                await browser.type(params.selector as string, params.text as string)
                if (params.press_enter) {
                    await browser.press('Enter')
                    await browser.wait(2000)
                    const content = await browser.getContent()
                    return { success: true, currentUrl: content.url, pageTitle: content.title }
                }
                return { success: true }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_scroll',
        description: 'Scrollt die aktuelle Seite nach oben oder unten.',
        category: 'browser',
        parameters: [
            {
                name: 'direction',
                type: 'string',
                description: '"down" oder "up" (Standard: "down")',
                required: false,
            },
            {
                name: 'pixels',
                type: 'number',
                description: 'Pixel zum Scrollen (Standard: 600)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                const dir = (params.direction as string) === 'up' ? 'up' : 'down'
                await browser.scroll(dir, (params.pixels as number) || 600)
                return { success: true, direction: dir }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_extract',
        description:
            'Extrahiert sichtbaren Text und Links von der aktuellen Seite (oder einem CSS-Selektor-Bereich). Besser als fetch_url für JavaScript-gerenderte Seiten.',
        category: 'browser',
        parameters: [
            {
                name: 'selector',
                type: 'string',
                description: 'CSS-Selektor für einen Teilbereich (optional, default: ganze Seite)',
                required: false,
            },
            {
                name: 'include_links',
                type: 'boolean',
                description: 'Links mit ausgeben (Standard: true)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                const includeLinks = params.include_links !== false

                if (params.selector) {
                    const text = await browser.getText(params.selector as string)
                    return { text: text.slice(0, 10000), selector: params.selector }
                }

                const content = await browser.getContent()
                const result: Record<string, unknown> = {
                    url: content.url,
                    title: content.title,
                    text: content.text.slice(0, 10000),
                }
                if (includeLinks) {
                    result.links = content.links.slice(0, 30)
                }
                return result
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_screenshot',
        description:
            'Macht einen Screenshot der aktuellen Seite. Speichert in .nova-screenshots/. Gibt den Dateipfad zurück (kann via send_file an Telegram gesendet werden).',
        category: 'browser',
        parameters: [
            {
                name: 'full_page',
                type: 'boolean',
                description: 'Ganze Seite scrollen und erfassen (Standard: false)',
                required: false,
            },
            {
                name: 'name',
                type: 'string',
                description: 'Dateiname ohne Extension (Standard: auto-timestamp)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                ensureScreenshotDir()
                const browser = await getSession()
                const name = params.name ? `${params.name}.png` : undefined
                const result = params.full_page
                    ? await browser.screenshotFullPage(name)
                    : await browser.screenshot(name)
                return { success: true, path: result.path, timestamp: result.timestamp }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_get_links',
        description: 'Gibt alle Links der aktuellen Seite zurück (Text + URL). Nützlich zum Navigieren.',
        category: 'browser',
        parameters: [
            {
                name: 'filter',
                type: 'string',
                description: 'Nur Links die diesen Text/URL-Teil enthalten (optional)',
                required: false,
            },
            {
                name: 'limit',
                type: 'number',
                description: 'Max Anzahl Links (Standard: 50)',
                required: false,
            },
        ],
        handler: async (params: Record<string, unknown>) => {
            try {
                const browser = await getSession()
                const content = await browser.getContent()
                let links = content.links
                if (params.filter) {
                    const f = (params.filter as string).toLowerCase()
                    links = links.filter(
                        l =>
                            l.text.toLowerCase().includes(f) ||
                            l.href.toLowerCase().includes(f),
                    )
                }
                return {
                    url: content.url,
                    count: links.length,
                    links: links.slice(0, (params.limit as number) || 50),
                }
            } catch (err: unknown) {
                return { error: err instanceof Error ? err.message : String(err) }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_status',
        description:
            'Zeigt den Status der Browser-Session: läuft sie, aktuelle URL, Titel. Auch nützlich um zu prüfen ob der Browser noch offen ist.',
        category: 'browser',
        parameters: [],
        handler: async () => {
            const status = getSessionStatus()
            if (!status.running) {
                return { running: false, note: 'Kein Browser aktiv. browser_open aufrufen um zu starten.' }
            }
            try {
                const browser = await getSession()
                const content = await browser.getContent()
                return {
                    running: true,
                    url: content.url,
                    title: content.title,
                    idleTimeoutMin: Math.round(IDLE_TIMEOUT_MS / 60000),
                }
            } catch {
                return { running: true, url: status.url, note: 'Seite nicht mehr zugänglich.' }
            }
        },
    },

    // ------------------------------------------
    {
        name: 'searxng_search',
        description:
            'Sucht im privaten SearXNG-Metasuchmaschinen-Server (aggregiert Google, Bing, DuckDuckGo, Wikipedia u.v.m.). ' +
            'Kein API-Key, kein Rate-Limit, strukturierte JSON-Ergebnisse. BEVORZUGT für Web-Recherche.',
        category: 'browser',
        parameters: [
            { name: 'query', type: 'string', description: 'Suchanfrage', required: true },
            { name: 'count', type: 'number', description: 'Anzahl Ergebnisse (Standard: 8, max: 20)', required: false },
            { name: 'language', type: 'string', description: 'Sprache z.B. "de" oder "en" (Standard: auto)', required: false },
            { name: 'category', type: 'string', description: 'Kategorie: "general", "images", "news", "science", "it" (Standard: general)', required: false },
        ],
        handler: async (params: Record<string, unknown>) => {
            const query = params.query as string
            const count = Math.min(Number(params.count) || 8, 20)
            const lang = (params.language as string) || ''
            const cat = (params.category as string) || 'general'

            try {
                const searchUrl = new URL('http://100.64.0.10:8088/search')
                searchUrl.searchParams.set('q', query)
                searchUrl.searchParams.set('format', 'json')
                searchUrl.searchParams.set('categories', cat)
                if (lang) searchUrl.searchParams.set('language', lang)

                const res = await fetch(searchUrl.toString(), {
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(10_000),
                })

                if (!res.ok) {
                    return { error: `SearXNG HTTP ${res.status}`, query }
                }

                const data = await res.json() as {
                    results?: Array<{
                        title: string
                        url: string
                        content?: string
                        score?: number
                        engine?: string
                        publishedDate?: string
                    }>
                    answers?: string[]
                    infoboxes?: Array<{ infobox: string; content: string }>
                }

                const results = (data.results || []).slice(0, count).map(r => ({
                    title: r.title,
                    url: r.url,
                    snippet: (r.content || '').slice(0, 300),
                    engine: r.engine,
                    date: r.publishedDate,
                }))

                const output: Record<string, unknown> = {
                    query,
                    resultCount: results.length,
                    results,
                }

                if (data.answers?.length) {
                    output.directAnswer = data.answers[0]
                }
                if (data.infoboxes?.length) {
                    output.infobox = { title: data.infoboxes[0].infobox, content: data.infoboxes[0].content.slice(0, 500) }
                }

                return output
            } catch (err: unknown) {
                // Fallback to DuckDuckGo if SearXNG unreachable
                console.warn('[SearXNG] Nicht erreichbar — fallback zu DuckDuckGo')
                try {
                    const ddgResults = await duckduckgoSearch(query, count)
                    return { query, resultCount: ddgResults.length, results: ddgResults, source: 'duckduckgo-fallback' }
                } catch {
                    return { error: err instanceof Error ? err.message : String(err), query }
                }
            }
        },
    },

    {
        name: 'browser_tab_new',
        description: 'Öffnet einen neuen isolierten Browser-Tab für den aktuellen Nova-Benutzer.',
        category: 'browser',
        parameters: [{ name: 'url', type: 'string', description: 'Optionale URL', required: false }],
        handler: async params => (await getSession()).newTab(params.url as string | undefined),
    },
    {
        name: 'browser_tabs',
        description: 'Listet Tabs der aktuellen benutzerspezifischen Browser-Session.',
        category: 'browser',
        parameters: [],
        handler: async () => ({ tabs: await (await getSession()).listTabs() }),
    },
    {
        name: 'browser_tab_switch',
        description: 'Wechselt deterministisch zu einem Browser-Tab.',
        category: 'browser',
        parameters: [{ name: 'index', type: 'number', description: 'Tab-Index', required: true }],
        handler: async params => (await getSession()).switchTab(Number(params.index)),
    },
    {
        name: 'browser_tab_close',
        description: 'Schließt einen Browser-Tab der aktuellen User-Session.',
        category: 'browser',
        parameters: [{ name: 'index', type: 'number', description: 'Tab-Index', required: true }],
        handler: async params => { await (await getSession()).closeTab(Number(params.index)); return { success: true } },
    },
    {
        name: 'browser_upload',
        description: 'Lädt freigegebene lokale Dateien über ein Datei-Eingabefeld hoch.',
        category: 'browser',
        parameters: [
            { name: 'selector', type: 'string', description: 'CSS-Selektor des input[type=file]', required: true },
            { name: 'paths', type: 'object', description: 'Liste absoluter Dateipfade', required: true },
        ],
        handler: async params => { await (await getSession()).upload(String(params.selector), Array.isArray(params.paths) ? params.paths.map(String) : [String(params.paths)]); return { success: true } },
    },
    {
        name: 'browser_download',
        description: 'Klickt ein Element und speichert den bestätigten Download im benutzerspezifischen Download-Verzeichnis.',
        category: 'browser',
        parameters: [{ name: 'selector', type: 'string', description: 'CSS-Selektor des Download-Elements', required: true }],
        handler: async params => (await getSession()).clickAndDownload(String(params.selector)),
    },
    {
        name: 'browser_elements',
        description: 'Liefert eine kompakte, deterministische Liste interaktiver Elemente als DOM/Accessibility-Fallback.',
        category: 'browser',
        parameters: [{ name: 'limit', type: 'number', description: 'Maximale Elemente', required: false }],
        handler: async params => ({ elements: await (await getSession()).getInteractiveElements(Number(params.limit || 100)) }),
    },
    {
        name: 'browser_handoff',
        description: 'Aktiviert oder beendet den Human-Handoff. Im Handoff bleibt die Session offen und Nova führt keine impliziten Folgeaktionen aus.',
        category: 'browser',
        parameters: [{ name: 'enabled', type: 'boolean', description: 'Handoff aktiv', required: true }],
        handler: async params => {
            const userId = getExecutionPolicyContext().userId || 'system'
            await getSession()
            getOperatorBrowserManager().setHandoff(userId, Boolean(params.enabled))
            return { success: true, handoff: Boolean(params.enabled) }
        },
    },
    {
        name: 'browser_replay',
        description: 'Zeigt die redigierte Tool-Evidence der letzten Browseraktionen für den aktuellen Benutzer.',
        category: 'browser',
        parameters: [{ name: 'limit', type: 'number', description: 'Maximale Einträge', required: false }],
        handler: async params => {
            const userId = getExecutionPolicyContext().userId || 'system'
            return { entries: getOperatorBrowserManager().replay(userId, Number(params.limit || 100)) }
        },
    },

    // ------------------------------------------
    {
        name: 'browser_close',
        description: 'Schließt den Browser-Session. Nächstes browser_open startet neu.',
        category: 'browser',
        parameters: [],
        handler: async () => {
            const userId = getExecutionPolicyContext().userId || 'system'
            const running = getOperatorBrowserManager().status(userId).running
            await getOperatorBrowserManager().close(userId)
            return running
                ? { success: true, note: 'Browser geschlossen.' }
                : { success: true, note: 'Kein Browser war aktiv.' }
        },
    },
]
