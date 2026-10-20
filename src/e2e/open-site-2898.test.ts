/**
 * 2.89.8 (U8) over the real Telegram entry: "öffne <domain> und sag mir ..." gets fetch_url and the browser tools,
 * never a script/shell substitute (live: the model wrote a script into /tmp with write_file). Only the model and the
 * page fetch (SSRF-guarded in production) are simulated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const fetched = vi.hoisted(() => ({ urls: [] as string[] }))
vi.mock('../resilience/ssrf-guard.js', async importOriginal => {
    const real = await importOriginal<typeof import('../resilience/ssrf-guard.js')>()
    return {
        ...real,
        fetchWithSsrfGuard: async (url: string) => {
            fetched.urls.push(url)
            return new Response('<html><body><h1>Erste Schlagzeile: Herbstmarkt eröffnet</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
        },
    }
})

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; fetched.urls.length = 0 })
const T = 120_000

describe('2.89.8 U8: "öffne <domain> und sag mir ..." uses the web tools', () => {
    it('offers fetch_url and browser tools, never write_file/run_command, and answers from the fetched page', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('öffne example.com und sag mir die erste Schlagzeile', [
            call => {
                expect(call.tools).toContain('fetch_url')
                expect(call.tools).not.toContain('write_file')
                expect(call.tools).not.toContain('run_command')
                return { tool: 'fetch_url', args: { url: 'https://example.com/' } }
            },
            { text: 'Die erste Schlagzeile lautet: Herbstmarkt eröffnet.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.executedTools).toContain('fetch_url')
        expect(fetched.urls.some(url => url.includes('example.com'))).toBe(true)
        expect(result.executedTools).not.toContain('write_file')
        expect(result.final).toContain('Herbstmarkt')
    }, T)

    it.each(['geh auf example.org und lies mir die Überschrift vor', 'was steht auf example.com/news'])('also offers them for: %s', async text => {
        h = await createE2EHarness()
        const result = await h.telegram(text, [{ text: 'Ich schaue nach.' }])
        expect(result.offeredTools).toContain('fetch_url')
        expect(result.offeredTools).not.toContain('run_command')
    }, T)
})
