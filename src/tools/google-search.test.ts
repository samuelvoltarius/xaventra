import { describe, expect, it, vi } from 'vitest'

// A fake shared page: goto() stores the query, evaluate() answers after a
// delay with whatever query the page shows at that moment.
const pw = vi.hoisted(() => {
    const state = { current: '', launches: 0 }
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const page = {
        setViewportSize: async () => {},
        setExtraHTTPHeaders: async () => {},
        goto: async (url: string) => { await sleep(5); state.current = new URL(url).searchParams.get('q') || '' },
        url: () => `https://www.google.com/search?q=${state.current}`,
        waitForSelector: async () => { await sleep(20) },
        evaluate: async () => [{ title: `result for ${state.current}`, url: `https://example.com/${state.current}`, snippet: '' }],
        close: async () => {},
    }
    const chromium = { launch: async () => { state.launches++; await sleep(10); return { newPage: async () => page, close: async () => {} } } }
    return { state, chromium }
})
vi.mock('playwright', () => ({ chromium: pw.chromium }))

import { googleSearch } from './google-search.js'

describe('R2 T20: concurrent searches do not share results or launch twice', () => {
    it('each caller gets the results of its own query', async () => {
        const [guest, owner] = await Promise.all([googleSearch('gast frage', 1), googleSearch('owner geheim', 1)])
        expect(guest.results[0].title).toBe('result for gast frage')
        expect(owner.results[0].title).toBe('result for owner geheim')
        expect(pw.state.launches).toBe(1)
    })
})
