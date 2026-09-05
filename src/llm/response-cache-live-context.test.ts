import { beforeEach, describe, expect, it } from 'vitest'
import { cacheResponse, clearCache, getCachedResponse } from './response-cache.js'

describe('response cache live context safety', () => {
    beforeEach(() => clearCache())

    it('invalidates an answer when live context later in the prompt changes', () => {
        const prefix = 'x'.repeat(700)
        const messages = [{ role: 'user', content: 'Welche Uhrzeit ist es?' }]
        cacheResponse(`${prefix}\nZeit: 15:17`, messages, 'Es ist 15:17 Uhr und Mailcow läuft.', 'test')
        expect(getCachedResponse(`${prefix}\nZeit: 23:22`, messages)).toBeNull()
    })

    it('does not cache generic connectivity probes', () => {
        const messages = [{ role: 'user', content: 'test' }]
        cacheResponse('live prompt', messages, 'Ich bin da und antworte mit Live-Status.', 'test')
        expect(getCachedResponse('live prompt', messages)).toBeNull()
    })
})
