/**
 * 2.85 Paket C (Alfred 02.10.): eine im eigenen Netz/auf eigenen Knoten
 * gefundene SearXNG-Instanz nutzt die Suchkette automatisch (lokal, kein Key,
 * keine Frage) und vor Cloud-Suchen. Eine gesetzte NOVA_SEARXNG_URL bleibt Vorrang.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const discovered = vi.hoisted(() => ({ url: null as string | null }))
vi.mock('../mesh/ai-scanner.js', () => ({ getDiscoveredSearxngUrl: () => discovered.url }))

import { getSearXNGUrl } from './searxng-search.js'
import { createGovernedWebSearch } from '../install/software-freshness.js'

afterEach(() => { vi.unstubAllEnvs(); discovered.url = null })

describe('SearXNG: gefundene Instanz wird ohne Frage genutzt', () => {
    it('ohne gesetzte URL → gefundene Instanz; gesetzte NOVA_SEARXNG_URL bleibt Vorrang', () => {
        vi.stubEnv('NOVA_SEARXNG_URL', '')
        discovered.url = 'http://192.168.50.30:8888'
        expect(getSearXNGUrl()).toBe('http://192.168.50.30:8888')
        vi.stubEnv('NOVA_SEARXNG_URL', 'http://search.example.com')
        expect(getSearXNGUrl()).toBe('http://search.example.com')
    })

    it('nichts gesetzt, nichts gefunden → null wie bisher', () => {
        vi.stubEnv('NOVA_SEARXNG_URL', '')
        expect(getSearXNGUrl()).toBeNull()
    })
})

describe('Suchkette: SearXNG vor Cloud-Suchen', () => {
    const registry = () => ({
        get: vi.fn(() => ({})),
        execute: vi.fn(async () => ({ results: [{ url: 'https://example.com/cloud', title: 'Cloud' }] })),
    })

    it('mit SearXNG: Treffer kommen aus SearXNG, die Cloud-Suchen werden nicht gefragt', async () => {
        const reg = registry()
        const search = vi.fn(async (query: string) => ({ query, results: [{ title: 'Lokal', url: 'https://example.com/a', content: 'Snippet', engine: 'wikipedia' }] }))
        const port = createGovernedWebSearch({ registry: reg, searxng: { url: () => 'http://192.168.50.30:8888', search } })
        const result = await port.search('xaventra')
        expect(result.tool).toBe('searxng_search')
        expect(result.hits[0]).toMatchObject({ url: 'https://example.com/a', title: 'Lokal', snippet: 'Snippet' })
        expect(search).toHaveBeenCalledWith('xaventra', 'http://192.168.50.30:8888')
        expect(reg.execute).not.toHaveBeenCalled()
    })

    it('SearXNG leer oder Fehler → bisherige Kette', async () => {
        const reg = registry()
        const port = createGovernedWebSearch({ registry: reg, searxng: { url: () => 'http://192.168.50.30:8888', search: async (query: string) => ({ query, results: [], error: 'down' }) } })
        const result = await port.search('xaventra')
        expect(result.tool).toBe('browser_search')
        expect(reg.execute).toHaveBeenCalled()
    })
})
