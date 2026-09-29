import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : id === 'admin-1' ? 'admin' : 'user') }))
vi.mock('../users/multi-user-middleware.js', async (original) => ({ ...(await original() as object), getUserPermission: perms.getUserPermission }))
const guard = vi.hoisted(() => ({ fail: false }))
vi.mock('../layers/L8-prisma-guards.js', () => ({
    checkDatabaseSafety: () => { if (guard.fail) throw new Error('guard missing'); return { safe: true } },
    formatBlockMessage: () => 'blocked',
}))
const child = vi.hoisted(() => ({ execSync: vi.fn(() => 'ran\n') }))
vi.mock('node:child_process', async (original) => ({ ...(await original() as object), execSync: child.execSync }))

import { callerIsElevated, createToolRegistry, registerBuiltinTools } from './registry.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const registry = createToolRegistry()
registerBuiltinTools(registry)
const runCommand = (command: string) => registry.get('run_command')!.handler({ command })
beforeEach(() => { child.execSync.mockClear(); guard.fail = false })

describe('R2 UEB-28: legacy run_command uses the real caller role for elevation', () => {
    it('owner/admin are elevated; user, missing identity and errors are not', async () => {
        expect(await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram' }, callerIsElevated)).toBe(true)
        expect(await withExecutionPolicyContext({ authUserId: 'admin-1', channel: 'telegram' }, callerIsElevated)).toBe(true)
        expect(await withExecutionPolicyContext({ authUserId: 'user-1', channel: 'telegram' }, callerIsElevated)).toBe(false)
        expect(await callerIsElevated()).toBe(false)
    })
    it('an elevated-only command is refused without an elevated caller', async () => {
        await expect(runCommand('sudo apt install cowsay')).rejects.toThrow()
        await expect(withExecutionPolicyContext({ authUserId: 'user-1', channel: 'telegram' }, () => runCommand('sudo apt install cowsay'))).rejects.toThrow()
        expect(child.execSync).not.toHaveBeenCalled()
        await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram' }, () => runCommand('sudo apt install cowsay'))
        expect(child.execSync).toHaveBeenCalledTimes(1)
    })
    it('does not run anything when the database guard cannot be loaded', async () => {
        guard.fail = true
        const result = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram' }, () => runCommand('echo hi')) as any
        expect(result.success).toBe(false)
        expect(child.execSync).not.toHaveBeenCalled()
    })
})
