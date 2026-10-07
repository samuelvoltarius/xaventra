import { afterEach, describe, expect, it, vi } from 'vitest'

// 2.89 Paket C: ONE internet question. mesh-registry.ts used to ping 8.8.8.8 on its own
// (second place) and said "kein Internet" under NoNewPrivileges although HTTPS worked.

const runs: string[] = []
let pingBlocked = true
let httpsWorks = true

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        execSync: (command: string) => {
            runs.push(command)
            if (command.startsWith('ping')) { if (pingBlocked) throw new Error('Operation not permitted'); return '' }
            if (command.includes('connect(443')) { if (httpsWorks) return ''; throw new Error('offline') }
            return ''
        },
    }
})
vi.mock('child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('child_process')>()
    return {
        ...actual,
        execSync: (command: string) => {
            runs.push(command)
            if (command.startsWith('ping')) { if (pingBlocked) throw new Error('Operation not permitted'); return '' }
            if (command.includes('connect(443')) { if (httpsWorks) return ''; throw new Error('offline') }
            throw new Error('not here')
        },
    }
})

afterEach(async () => {
    runs.length = 0
    const { resetInternetProbe } = await import('./environment.js')
    resetInternetProbe()
})

describe('one internet question', () => {
    it('mesh registration says internet when ping is blocked but TCP 443 works', async () => {
        pingBlocked = true; httpsWorks = true
        const { scanNodeCapabilities } = await import('../mesh/mesh-registry.js')
        const { caps } = scanNodeCapabilities()
        expect(caps).toContain('internet')
        expect(runs.some(command => command.includes('connect(443'))).toBe(true)
    })

    it('Gegenprobe: ping and 443 both blocked -> no internet capability', async () => {
        pingBlocked = true; httpsWorks = false
        const { scanNodeCapabilities } = await import('../mesh/mesh-registry.js')
        expect(scanNodeCapabilities().caps).not.toContain('internet')
    })

    it('environment prompt and mesh registration share one answer (one probe)', async () => {
        pingBlocked = true; httpsWorks = true
        const { hasInternet } = await import('./environment.js')
        const { scanNodeCapabilities } = await import('../mesh/mesh-registry.js')
        expect(hasInternet()).toBe(true)
        const before = runs.filter(command => command.startsWith('ping')).length
        expect(scanNodeCapabilities().caps).toContain('internet')
        expect(runs.filter(command => command.startsWith('ping')).length).toBe(before)
    })

    it('the fallback "ready" mode is no internet statement any more', async () => {
        const { FallbackManager } = await import('../resilience/fallback.js')
        const manager = new FallbackManager()
        manager.setLLMConnected(true); manager.addChannel('telegram')
        expect(manager.getMode()).toBe('ready')
        expect(manager.isReady()).toBe(true)
        expect((manager as unknown as Record<string, unknown>).isOnline).toBeUndefined()
    })
})

describe('2.89 integration: the „Hast du Internet?“ answer comes from hasInternet()', () => {
    it('yes and no from the same probe, for every role (no owner lock)', async () => {
        const { handleCommand } = await import('./slash-commands.js')
        const state: any = { tools: { getAll: () => [] }, config: {} }
        pingBlocked = true; httpsWorks = true
        expect(await handleCommand('internet', '', 'u1', state, [], { permission: 'user', channel: 'desktop', principalId: 'u1' } as any)).toMatch(/^Ja/)
        const { resetInternetProbe } = await import('./environment.js')
        resetInternetProbe()
        httpsWorks = false
        expect(await handleCommand('internet', '', 'g1', state, [], { permission: 'guest', channel: 'desktop', principalId: 'g1' } as any)).toMatch(/^Nein/)
        httpsWorks = true
    })
})
