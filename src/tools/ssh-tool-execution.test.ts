import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { executeSSH } from './ssh-tool.js'
import { saveHosts } from './ssh-tool-hosts.js'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(() => 'fixture-host\n') }))
vi.mock('node:child_process', () => ({ execSync: execute, spawnSync: vi.fn() }))
vi.mock('../core/environment.js', () => ({ detectEnvironment: () => ({
    os: 'linux', hasSSH: true, hasPlink: false, hasSshpass: true, hasSSHKey: true, sshKeyPath: '/fixture/key',
}), autoInstall: vi.fn(() => false) }))
const file = join(process.cwd(), '.nova-data', 'hosts.json')
beforeEach(() => { execute.mockClear(); mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true }); rmSync(file, { force: true }) })
afterEach(() => vi.unstubAllEnvs())

describe('SSH authentication and metadata persistence (mocked process, no SSH)', () => {
    it('does not turn a successful password connection into plaintext credential storage', async () => {
        const result = await executeSSH({ host: '192.0.2.10', command: 'hostname', user: 'operator', password: 'fixture-only-secret' })
        expect(result.success).toBe(true)
        expect(execute).toHaveBeenCalledTimes(1)
        const saved = readFileSync(file, 'utf8')
        expect(saved).toContain('fixture-host')
        expect(saved).not.toContain('fixture-only-secret')
        expect(JSON.parse(saved).hosts[0].password).toBeUndefined()
    })
    it('fails explicitly for a missing reference but permits explicit key authentication', async () => {
        vi.stubEnv('XAVENTRA_SSH_MISSING', '')
        saveHosts({ hosts: [{ name: 'worker', alias: [], ip: '192.0.2.10', user: 'operator', passwordEnv: 'XAVENTRA_SSH_MISSING', description: '', lastSeen: null }] })
        const denied = await executeSSH({ host: 'worker', command: 'hostname' })
        expect(denied.success).toBe(false)
        expect(execute).not.toHaveBeenCalled()
        const key = await executeSSH({ host: 'worker', command: 'hostname', password: 'ssh-key' })
        expect(key.success).toBe(true)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(execute.mock.calls[0][0]).not.toContain('sshpass')
    })
})
