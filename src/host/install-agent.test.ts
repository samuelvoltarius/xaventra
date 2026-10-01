import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDockerHostAgent } from './docker-agent.js'
import { createHostInstaller, type InstallExecOptions, type InstallProbe } from './install-agent.js'
import { getInstallCatalog } from '../install/install-catalog.js'
import { installTicketBytes, issueInstallTicket, type InstallTicket } from '../install/install-ticket.js'

// Stufe 2 (S2.2/S2.3/S2.5): host-side catalog executor with a mocked
// execFile executor. No real package manager is touched in any test.

const keys = generateKeyPairSync('ed25519'), receiptKeys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
const pem = (k: any, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString()
const catalog = getInstallCatalog()
const BASE = ['adduser', 'apt', 'bash', 'coreutils']

interface Call { file: string; args: string[]; options: InstallExecOptions }
let calls: Call[], installed: Set<string>, behaviour: { installFails?: boolean; verifyFailsAfter?: boolean; simulateRemove?: boolean }
let probe: InstallProbe & { free: number | null; gpu: number | null | undefined }

const executor = {
    async run(file: string, args: string[], options: InstallExecOptions) {
        calls.push({ file, args, options })
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
        if (file === '/usr/bin/dpkg-query') return ok([...installed].sort().map(name => `ii |${name}`).concat('rc |old-config-only').join('\n'))
        if (file === '/usr/bin/apt-get' && args[1] === '-s') return ok(behaviour.simulateRemove ? 'Inst ffmpeg\nRemv something-important' : 'Inst ffmpeg\nInst libavcodec60')
        if (file === '/usr/bin/apt-get' && args[0] === 'update') return ok()
        if (file === '/usr/bin/apt-get' && args[0] === 'install') {
            if (behaviour.installFails) { installed.add('libavcodec60'); return { code: 100, stdout: '', stderr: 'E: broken' } }
            installed.add('ffmpeg'); installed.add('libavcodec60'); return ok()
        }
        if (file === '/usr/bin/apt-get' && args[0] === 'remove') { for (const name of args.slice(3)) installed.delete(name); return ok() }
        if (file === '/usr/bin/ffmpeg') return { code: installed.has('ffmpeg') && !behaviour.verifyFailsAfter ? 0 : 1, stdout: '', stderr: '' }
        if (file === '/usr/local/bin/ollama' && args[0] === 'show') return { code: installed.has('model:nomic') ? 0 : 1, stdout: '', stderr: '' }
        if (file === '/usr/local/bin/ollama' && args[0] === 'pull') { installed.add('model:nomic'); return ok() }
        if (file === '/usr/local/bin/ollama' && args[0] === 'rm') { installed.delete('model:nomic'); return ok() }
        return { code: 127, stdout: '', stderr: `unexpected ${file}` }
    },
}

let stateDir: string
const installer = (overrides: Record<string, unknown> = {}) => createHostInstaller({
    nodeId: 'spark', clientId: 'xaventra-main', stateDir, ticketPublicKey: pem(keys.publicKey, 'spki'), receiptPrivateKey: pem(receiptKeys.privateKey, 'pkcs8'),
    catalog, platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia', serviceUser: { uid: 1001, gid: 1001, home: '/var/lib/xaventra' }, ...overrides,
} as any, executor, probe)
const ticket = (catalogId = 'ffmpeg', overrides: Record<string, unknown> = {}) => issueInstallTicket({ nodeId: 'spark', clientId: 'xaventra-main', catalogId, approval: 'fragen', approvedBy: 'owner:alfred', ...overrides } as any, pem(keys.privateKey, 'pkcs8'), catalog)
const resign = (payload: InstallTicket) => ({ payload, signature: sign(null, installTicketBytes(payload), keys.privateKey).toString('base64') })

beforeEach(() => {
    calls = []; installed = new Set(BASE); behaviour = {}
    stateDir = mkdtempSync(join(tmpdir(), 'install-agent-'))
    probe = { free: 200 * 1024 ** 3, gpu: 3, freeBytes() { return this.free }, async gpuUtilization() { return this.gpu } } as any
    process.env.SUPER_SECRET_TOKEN = 'must-not-reach-children'
})
afterEach(() => { delete process.env.SUPER_SECRET_TOKEN })

describe('host installer: valid catalog ticket', () => {
    it('runs the exact argument arrays via the executor, records before/after, rollback and a signed receipt', async () => {
        const inst = installer()
        const admission = await inst.admit(ticket())
        const receipt = await admission.done
        expect(calls.map(call => [call.file, ...call.args])).toEqual([
            ['/usr/bin/ffmpeg', '-version'],
            ['/usr/bin/dpkg-query', '-W', '-f=${db:Status-Abbrev}|${binary:Package}\\n'],
            ['/usr/bin/apt-get', 'install', '-s', '--no-install-recommends', 'ffmpeg'],
            ['/usr/bin/apt-get', 'update'],
            ['/usr/bin/apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg'],
            ['/usr/bin/ffmpeg', '-version'],
            ['/usr/bin/dpkg-query', '-W', '-f=${db:Status-Abbrev}|${binary:Package}\\n'],
        ])
        for (const call of calls) {
            expect(Object.keys(call.options.env).every(key => ['PATH', 'LANG', 'HOME', 'DEBIAN_FRONTEND'].includes(key))).toBe(true)
            expect(JSON.stringify(call.options)).not.toContain('must-not-reach-children')
        }
        expect(receipt).toMatchObject({ success: true, operation: 'install', catalogId: 'ffmpeg', approvedBy: 'owner:alfred', newPackages: ['ffmpeg', 'libavcodec60'],
            rollback: { argv: ['/usr/bin/apt-get', 'remove', '-y', '--', 'ffmpeg', 'libavcodec60'] }, before: { count: 4 }, after: { count: 6 } })
        expect(verify(null, Buffer.from(`xaventra-install-receipt:${receipt.evidenceHash}`), pem(receiptKeys.publicKey, 'spki'), Buffer.from(receipt.signature!, 'base64'))).toBe(true)
        expect(inst.status(admission.ticketId)).toMatchObject({ phase: 'completed', receipt: { success: true } })
    })

    it('rollback removes only the newly installed packages (no autoremove) and proves the package list is back', async () => {
        const inst = installer()
        const install = ticket()
        await (await inst.admit(install)).done
        calls = []
        const back = ticket('ffmpeg', { operation: 'rollback', installTicketId: install.payload.id })
        const receipt = await (await inst.admit(back)).done
        expect(calls[0]).toMatchObject({ file: '/usr/bin/apt-get', args: ['remove', '-y', '--', 'ffmpeg', 'libavcodec60'] })
        expect(calls.some(call => call.args.includes('autoremove'))).toBe(false)
        expect(receipt).toMatchObject({ success: true, operation: 'rollback', rolledBack: true, restored: true })
        expect([...installed].sort()).toEqual(BASE)
        await expect(inst.admit(ticket('ffmpeg', { operation: 'rollback', installTicketId: install.payload.id }))).rejects.toThrow(/bereits/)
    })

    it('rolls back by itself when the after-probe fails', async () => {
        behaviour.verifyFailsAfter = true
        installed.delete('ffmpeg')
        const receipt = await (await installer().admit(ticket())).done
        expect(receipt).toMatchObject({ success: false, rolledBack: true, restored: true })
        expect(calls.some(call => call.args[0] === 'remove')).toBe(true)
        expect([...installed].sort()).toEqual(BASE)
    })

    it('refuses an install that apt would solve by removing packages', async () => {
        behaviour.simulateRemove = true
        const receipt = await (await installer().admit(ticket())).done
        expect(receipt.success).toBe(false)
        expect(calls.some(call => call.args[0] === 'install' && call.args[1] === '-y')).toBe(false)
    })

    it('is a no-op with receipt when the probe already passes', async () => {
        installed.add('ffmpeg')
        const receipt = await (await installer().admit(ticket())).done
        expect(receipt).toMatchObject({ success: true, alreadyInstalled: true, rollback: null })
        expect(calls).toHaveLength(1)
    })

    it('runs model entries as the unprivileged service user, never root', async () => {
        const receipt = await (await installer().admit(ticket('ollama-model:nomic-embed-text'))).done
        expect(receipt.success).toBe(true)
        expect(calls.find(call => call.args[0] === 'pull')).toMatchObject({ file: '/usr/local/bin/ollama', args: ['pull', 'nomic-embed-text'], options: { uid: 1001, gid: 1001 } })
        expect(receipt.rollback).toEqual({ argv: ['/usr/local/bin/ollama', 'rm', 'nomic-embed-text'] })
    })

    it('replays the receipt of a completed ticket without running anything again', async () => {
        const inst = installer(), signed = ticket()
        const first = await (await inst.admit(signed)).done
        const count = calls.length
        const again = await inst.admit(signed)
        expect(again.replayed).toBe(true)
        expect(await again.done).toEqual(first)
        expect(calls).toHaveLength(count)
        await expect(inst.admit(resign({ ...signed.payload, catalogId: 'xfce-workstation', entryHash: ticket('xfce-workstation').payload.entryHash }))).rejects.toThrow(/wiederverwendet/)
    })
})

describe('host installer: refusals before any execution', () => {
    it('rejects missing, expired, foreign and forged tickets and model-made approvals', async () => {
        const inst = installer()
        const good = ticket()
        const forged = { payload: good.payload, signature: sign(null, installTicketBytes(good.payload), other.privateKey).toString('base64') }
        for (const value of [undefined, {}, forged, ticket('ffmpeg', { nodeId: 'xaventra-ns1' }), resign({ ...good.payload, expiresAt: Date.now() - 1 }),
            resign({ ...good.payload, approvedBy: 'model:qwen' }), resign({ ...good.payload, catalogId: 'htop' }), resign({ ...good.payload, id: 'chosen-by-model-0001' })]) {
            await expect(inst.admit(value)).rejects.toThrow()
        }
        expect(calls).toEqual([])
    })

    it('enforces the resource guard: 10 GB + 2x size, no install under GPU load, unknown load blocks', async () => {
        probe.free = 10 * 1024 ** 3 + 2 * 300 * 1024 ** 2 - 1
        await expect(installer().admit(ticket())).rejects.toThrow(/Platz/)
        probe.free = 200 * 1024 ** 3; probe.gpu = 85
        await expect(installer().admit(ticket())).rejects.toThrow(/GPU unter Last/)
        probe.gpu = null
        await expect(installer().admit(ticket())).rejects.toThrow(/unbekannt/)
        probe.gpu = undefined
        await expect(installer({ modelOnly: true }).admit(ticket())).rejects.toThrow(/nur Modelle/)
        expect(calls).toEqual([])
    })

    it('refuses Spark-only entries elsewhere and entries whose placeholders are not configured', async () => {
        await expect(installer({ arch: 'x64' }).admit(ticket('node-llama-cpp-cuda'))).rejects.toThrow(/arm64/)
        await expect(installer().admit(ticket('playwright-chromium'))).rejects.toThrow(/Platzhalter/)
        expect(calls).toEqual([])
    })
})

describe('host agent HTTP routes for installs', () => {
    const token = 'synthetic-test-token-'.repeat(3)
    let server: ReturnType<typeof createDockerHostAgent>, base: string
    const engine = { call: async () => { throw Error('docker must not be touched') } }
    async function start(withInstaller: boolean) {
        server = createDockerHostAgent({ nodeId: 'spark', clientId: 'xaventra-main', token, stateDir }, engine, withInstaller ? installer() : undefined)
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as any).port}`
    }
    afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const post = async (path: string, body: unknown, auth = token) => {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return { status: res.status, body: await res.json() as any }
    }

    it('accepts only signed catalog tickets; free commands, packages and wrong auth are refused', async () => {
        await start(true)
        expect((await post('/v1/install/execute', { ticket: ticket() }, 'wrong')).status).toBe(401)
        expect((await post('/v1/install/execute', { command: 'apt-get install -y htop' })).body.error).toContain('Unknown host parameter')
        expect((await post('/v1/install/execute', { ticket: ticket(), packages: ['htop'] })).body.success).toBe(false)
        expect((await post('/v1/install/rollback', { ticket: ticket() })).body.success).toBe(false)
        expect(calls).toEqual([])
        const signed = ticket()
        const accepted = await post('/v1/install/execute', { ticket: signed })
        expect(accepted).toMatchObject({ status: 202, body: { success: true, accepted: true, ticketId: signed.payload.id } })
        let state: any
        for (let i = 0; i < 50 && state?.phase !== 'completed'; i++) { state = (await post('/v1/install/status', { ticketId: signed.payload.id })).body; await new Promise(r => setTimeout(r, 10)) }
        expect(state).toMatchObject({ success: true, phase: 'completed', receipt: { success: true, catalogId: 'ffmpeg' } })
    })

    it('keeps install routes closed when no installer is configured', async () => {
        await start(false)
        expect((await post('/v1/install/execute', { ticket: ticket() })).status).toBe(404)
    })
})
