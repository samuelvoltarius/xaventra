import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserTools } from './complete-registry.js'

// 2.87.1 (live 07.10.2026): web_search only asked DuckDuckGo's instant-answer API
// (empty for almost every question) although a local SearXNG had been found.
// She then told the owner "ich habe kein Internet".

const calls: string[] = []
beforeEach(() => {
    calls.length = 0
    process.env.NOVA_SEARXNG_URL = 'http://192.0.2.20:8088'
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
        calls.push(String(url))
        if (String(url).startsWith('http://192.0.2.20:8088/search')) {
            return new Response(JSON.stringify({ results: [{ title: 'Treffer', url: 'https://example.org/t', content: 'Inhalt' }] }), { status: 200 })
        }
        return new Response(JSON.stringify({ AbstractText: '', RelatedTopics: [] }), { status: 200 })
    }))
})
afterEach(() => { delete process.env.NOVA_SEARXNG_URL; vi.unstubAllGlobals() })

describe('web_search uses the own SearXNG first', () => {
    it('returns SearXNG results and does not ask DuckDuckGo', async () => {
        const tool = browserTools.find(t => t.name === 'web_search')!
        const result: any = await tool.handler({ query: 'Wetter Wien' })
        expect(JSON.stringify(result)).toContain('https://example.org/t')
        expect(calls.some(u => u.includes('duckduckgo'))).toBe(false)
    })

    it('falls back to DuckDuckGo when no SearXNG answers (Gegenprobe)', async () => {
        delete process.env.NOVA_SEARXNG_URL
        process.env.NOVA_SEARXNG_URL = 'http://192.0.2.21:8088'
        const tool = browserTools.find(t => t.name === 'web_search')!
        await tool.handler({ query: 'Wetter Wien' })
        expect(calls.some(u => u.includes('duckduckgo'))).toBe(true)
    })
})
