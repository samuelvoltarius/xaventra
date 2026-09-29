import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', () => perms)
const child = vi.hoisted(() => ({
    execSync: vi.fn(() => { throw new Error('not available in tests') }),
    spawn: vi.fn(() => ({ unref: vi.fn() })),
}))
vi.mock('node:child_process', async (original) => ({ ...(await original() as object), execSync: child.execSync, spawn: child.spawn }))

import { restartNova, selfManagementTools } from './self-management.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const restartTool = selfManagementTools.find(tool => tool.name === 'nova_restart')!
let exitSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
    child.spawn.mockClear()
    vi.useFakeTimers()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    vi.stubEnv('PM2_HOME', '')
    vi.stubEnv('pm_id', undefined as any)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); exitSpy.mockRestore() })

describe('R2 T13: nova_restart', () => {
    it('refuses without owner approval', async () => {
        for (const params of [{ authorizationUserId: 'owner-1', channel: 'telegram' }, { authorizationUserId: 'admin-1', channel: 'telegram', confirm: 'x' }]) {
            const result = await restartTool.handler(params) as any
            expect(result.success).toBe(false)
        }
        expect(child.spawn).not.toHaveBeenCalled()
        vi.runAllTimers()
        expect(exitSpy).not.toHaveBeenCalled()
    })
    it('does not kill itself under a foreign systemd unit and reports it honestly', async () => {
        vi.stubEnv('INVOCATION_ID', 'abc123')
        const result = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram', approvalGranted: true },
            () => restartTool.handler({})) as any
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/systemd/)
        expect(child.spawn).not.toHaveBeenCalled()
        vi.runAllTimers()
        expect(exitSpy).not.toHaveBeenCalled()
    })
    it('direct restart logic is unchanged outside systemd', async () => {
        vi.stubEnv('INVOCATION_ID', '')
        const result = await restartNova()
        expect(result.method).toBe('direct')
        expect(child.spawn).toHaveBeenCalledTimes(1)
    })
})
