import { it, expect, vi } from 'vitest'
import { createDockerRepairStateCloner } from './docker-repair-state.js'

it('requires a pinned helper rather than an image tag', () => {
    expect(() => createDockerRepairStateCloner({ engine: { call: vi.fn() }, helperImageId: 'node:latest', quiescent: async () => true })).toThrow('Pinned')
})
it.each(['running', 'no-quiescence', 'shared-volume', 'different-user', 'bind-write'])('refuses %s before launching a copy helper', async reason => {
    const old = { Id: 'a'.repeat(64), Config: { User: '1000:1000' }, State: { Running: reason === 'running' }, Mounts: [{ Type: reason === 'bind-write' ? 'bind' : 'volume', Name: 'source', Destination: '/data', RW: true }] }
    const next = { ...structuredClone(old), Id: 'b'.repeat(64), Config: { User: reason === 'different-user' ? '1001:1001' : '1000:1000' },
        Mounts: [{ Type: 'volume', Name: reason === 'shared-volume' ? 'source' : 'destination', Destination: '/data', RW: true }] }
    const engine = { call: vi.fn(async (_method: string, path: string) => path.includes(old.Id) ? old : next) }
    const clone = createDockerRepairStateCloner({ engine, helperImageId: `sha256:${'c'.repeat(64)}`, quiescent: async () => reason !== 'no-quiescence' })
    expect(await clone(old.Id, next.Id, {} as any)).toBe(false)
    expect(engine.call.mock.calls.every(([method]) => method === 'GET')).toBe(true)
})
