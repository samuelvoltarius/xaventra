import { beforeEach, describe, expect, it, vi } from 'vitest'

// resolve_capability is classified as governed read-only and is allowed for
// mesh callers. It must therefore only check where a capability exists and
// never install anything: installs go through the Stufe-2 install catalog
// (src/install/*) with owner approval, never pip/apt/curl|sh or ssh from here.

const child = vi.hoisted(() => ({
    execSync: vi.fn((): Buffer => { throw new Error('not available') }),
    execFileSync: vi.fn((): Buffer => Buffer.from('')),
}))
const mesh = vi.hoisted(() => ({ nodes: [] as any[] }))

vi.mock('node:child_process', () => ({ execSync: child.execSync, execFileSync: child.execFileSync }))
vi.mock('../mesh/mesh-registry.js', () => ({ discoverNodes: async () => mesh.nodes }))

import { CAPABILITIES, resolveCapability } from './capability-router.js'

const INSTALL = /pip3? install|apt-get|brew install|choco install|install\.sh|\|\s*sh/

function commandTexts(): string[] {
    return [...child.execSync.mock.calls, ...child.execFileSync.mock.calls].map(call => JSON.stringify(call))
}

beforeEach(() => {
    child.execSync.mockClear()
    child.execFileSync.mockReset()
    child.execFileSync.mockImplementation(() => Buffer.from(''))
})

describe('capability router is check-only', () => {
    it.each(Object.keys(CAPABILITIES))('never installs %s locally or on a mesh node', async key => {
        mesh.nodes = [{ node_id: 'spark', hostname: 'spark', status: 'online', platform: 'linux', hardware: { ram_gb: 64 }, ip: '100.86.70.71' }]

        const resolution = await resolveCapability((CAPABILITIES as any)[key]())

        expect(commandTexts().filter(text => INSTALL.test(text))).toEqual([])
        expect(resolution.installed).toBe(false)
        expect(resolution.error).toBeTruthy()
    })

    it('still routes to a node that already has the capability', async () => {
        mesh.nodes = [{ node_id: 'spark', hostname: 'spark', status: 'online', platform: 'linux', hardware: { ram_gb: 64 }, ip: '100.86.70.71' }]
        child.execFileSync.mockImplementation(() => Buffer.from('ok'))

        const resolution = await resolveCapability(CAPABILITIES.whisper())

        expect(resolution.runRemotely).toBe(true)
        expect(resolution.installed).toBe(false)
        expect(commandTexts().filter(text => INSTALL.test(text))).toEqual([])
    })
})
