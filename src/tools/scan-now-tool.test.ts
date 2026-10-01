import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Scan mal das Netz" must work without a slash command: a read-only,
// owner-only tool that refreshes the node profile, the AI/service scan and
// (Main only) the device discovery right now.
const profile = vi.fn(async () => ({ role: 'main', cpu: { cores: 20 }, ramGB: 121 }))
const aiScan = vi.fn(async () => ({ services: [{ name: 'vllm' }], lastScan: new Date().toISOString() }))
const discovery = vi.fn(async () => 'Suche fertig: 2 Geräte gefunden')
const context = { authUserId: 'telegram:1000001', channel: 'telegram' }
let permission = 'owner'

vi.mock('../core/node-profile.js', () => ({ collectNodeProfile: (...a: unknown[]) => profile(...a) }))
vi.mock('../mesh/ai-scanner.js', () => ({ scanAllAIServices: (...a: unknown[]) => aiScan(...a) }))
vi.mock('../sensing/runtime.js', () => ({ runDiscoveryNow: (...a: unknown[]) => discovery(...a) }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => context }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => permission }))

const tool = async () => (await import('./scan-now-tool.js')).scanNowTool

describe('scan_now', () => {
    beforeEach(() => { profile.mockClear(); aiScan.mockClear(); discovery.mockClear(); permission = 'owner'; delete process.env.NOVA_NODE_ONLY })

    it('Owner: Hardware, Dienste und Geräte werden frisch gescannt', async () => {
        const result: any = await (await tool()).handler({})
        expect(profile).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
        expect(aiScan).toHaveBeenCalledWith(expect.objectContaining({ forceFresh: true }))
        expect(discovery).toHaveBeenCalled()
        expect(result.success).toBe(true)
        expect(String(result.formatted)).toContain('2 Geräte')
    })

    it('Nicht-Owner: nichts wird gescannt', async () => {
        permission = 'user'
        const result: any = await (await tool()).handler({})
        expect(result.success).toBe(false)
        expect(profile).not.toHaveBeenCalled(); expect(aiScan).not.toHaveBeenCalled(); expect(discovery).not.toHaveBeenCalled()
    })

    it('Worker: keine Geräte-Suche im Netz, nur eigener Knoten', async () => {
        process.env.NOVA_NODE_ONLY = 'true'
        await (await tool()).handler({})
        expect(discovery).not.toHaveBeenCalled()
        expect(profile).toHaveBeenCalled()
    })

    it('nur Geräte: kein Hardware-Scan', async () => {
        await (await tool()).handler({ was: 'geraete' })
        expect(discovery).toHaveBeenCalled(); expect(profile).not.toHaveBeenCalled()
    })
})
