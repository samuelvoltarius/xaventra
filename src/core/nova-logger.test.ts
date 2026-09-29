import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #20 and #30: the console logger must not throw on circular
// objects/BigInt, must keep Error message and stack, and an unknown or
// upper-case LOG_LEVEL must not silence errors.

let dir = ''

async function loadLogger(level: string | undefined) {
    dir = mkdtempSync(join(tmpdir(), 'nova-logger-'))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    if (level === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = level
    vi.resetModules()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const mod = await import('./nova-logger.js')
    return { logger: mod.logger, error, log }
}

afterEach(() => {
    delete process.env.LOG_LEVEL
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
})

describe('nova logger (R2 NZ-20, NZ-30)', () => {
    it.each(['INFO', 'Warn', 'verbose'])('still logs errors with LOG_LEVEL=%s', async level => {
        const { logger, error } = await loadLogger(level)
        logger.error('boom')
        expect(error).toHaveBeenCalledOnce()
        expect(String(error.mock.calls[0][0])).toContain('boom')
    })

    it('does not throw on circular objects or BigInt and keeps Error details', async () => {
        const { logger, error } = await loadLogger(undefined)
        const circular: any = { a: 1 }
        circular.self = circular
        expect(() => logger.error('x', circular, 10n)).not.toThrow()
        logger.error('caught', new Error('socket hang up'))
        const line = String(error.mock.calls.at(-1)?.[0])
        expect(line).toContain('socket hang up')
    })
})
