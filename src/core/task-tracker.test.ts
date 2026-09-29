import { afterAll, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #20: the /log ring-buffer console interceptor must not turn a
// handled error into a thrown one (circular objects, BigInt) and must keep
// Error messages instead of logging {}.

const original = { log: console.log, warn: console.warn, error: console.error }
afterAll(() => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
})

describe('log interceptor (R2 NZ-20)', () => {
    it('captures circular objects, BigInt and Error details without throwing', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const { installLogInterceptor, getLogLines } = await import('./task-tracker.js')
        installLogInterceptor()
        const circular: any = { name: 'axios' }
        circular.self = circular
        expect(() => console.error('request failed', circular)).not.toThrow()
        expect(() => console.log('count', 5n)).not.toThrow()
        console.error('caught', new Error('ECONNRESET upstream'))
        const lines = getLogLines(10).join('\n')
        expect(lines).toContain('request failed')
        expect(lines).toContain('ECONNRESET upstream')
    })
})
