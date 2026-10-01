import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { execute, autoInstall } = vi.hoisted(() => ({ execute: vi.fn(), autoInstall: vi.fn(async () => false) }))
vi.mock('node:child_process', () => ({ execSync: execute, execFileSync: execute, spawnSync: vi.fn() }))
vi.mock('../core/environment.js', () => ({ detectEnvironment: () => ({
    os: 'linux', hasSSH: true, hasPlink: false, hasSshpass: true, hasSSHKey: true, sshKeyPath: '/fixture/key',
}), autoInstall }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: (id: string) => id === 'owner-1' ? 'owner' : 'guest' }))

import { executeSSH } from './ssh-tool.js'
import { ownerApprovalCode } from '../test-utils/owner-approval.js'

// P9 Gruppe 4: SSH self-healing (tool install / key upload) used to require a context flag
// that nothing ever set. Now: the owner's one-time code, bound to user@host.
const identity = { authorizationUserId: 'owner-1', channel: 'telegram', userId: 'owner-1' }
const refused = () => { throw Object.assign(new Error('Connection refused'), { status: 255 }) }

beforeEach(() => {
    execute.mockReset(); execute.mockImplementation(refused); autoInstall.mockClear()
    mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true }); rmSync(join(process.cwd(), '.nova-data', 'hosts.json'), { force: true })
})
afterEach(() => execute.mockReset())

describe('SSH self-healing needs the owner code for exactly this user@host', () => {
    it('without a code: nothing installed, and the answer names the exact /freigabe command', async () => {
        const result = await executeSSH({ host: '192.0.2.10', command: 'id', user: 'operator', password: 'fixture-only-secret', ...identity })
        expect(autoInstall).not.toHaveBeenCalled()
        expect(result.action).toContain('/freigabe ssh_command selbstheilung:operator@192.0.2.10')
    })
    it('a code for another host does not unlock self-healing', async () => {
        const confirm = ownerApprovalCode('ssh_command', 'selbstheilung:operator@192.0.2.99')
        await executeSSH({ host: '192.0.2.10', command: 'id', user: 'operator', password: 'fixture-only-secret', ...identity, confirm })
        expect(autoInstall).not.toHaveBeenCalled()
    })
    it('the code bound to this user@host unlocks self-healing once', async () => {
        const confirm = ownerApprovalCode('ssh_command', 'selbstheilung:operator@192.0.2.10')
        await executeSSH({ host: '192.0.2.10', command: 'id', user: 'operator', password: 'fixture-only-secret', ...identity, confirm })
        expect(autoInstall).toHaveBeenCalled()
        autoInstall.mockClear()
        await executeSSH({ host: '192.0.2.10', command: 'id', user: 'operator', password: 'fixture-only-secret', ...identity, confirm })
        expect(autoInstall).not.toHaveBeenCalled()
    })
})
