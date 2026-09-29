import { describe, expect, it, vi } from 'vitest'
import { upstreamUpdateCommand } from './upstream-update-command.js'

// R2 NZ-42 (core-n-z #42): /update check and /update status reach GitHub and
// the update controller; they are not open to every role.

function fakeSource() {
    const status = { state: 'idle', checkedAt: '', originVerified: false } as any
    return {
        status: vi.fn(async () => status),
        check: vi.fn(async () => status),
        prepare: vi.fn(async () => status),
    } as any
}

describe('upstream update command role check (R2 NZ-42)', () => {
    it.each(['guest', 'user'])('denies check and status to %s without touching source or controller', async permission => {
        for (const args of ['check', 'status', 'status some-release-id']) {
            const source = fakeSource()
            const controller = vi.fn(async () => ({}) as any)
            const result = await upstreamUpdateCommand(args, permission, source, controller)
            expect(result, args).toContain('🔒')
            expect(source.check).not.toHaveBeenCalled()
            expect(source.status).not.toHaveBeenCalled()
            expect(controller).not.toHaveBeenCalled()
        }
    })

    it('keeps check available to the owner', async () => {
        const source = fakeSource()
        const result = await upstreamUpdateCommand('check', 'owner', source, vi.fn() as any)
        expect(result).not.toContain('🔒')
        expect(source.check).toHaveBeenCalledOnce()
    })
})
