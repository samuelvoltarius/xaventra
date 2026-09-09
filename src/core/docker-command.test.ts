import { expect, it, vi } from 'vitest'
import { detectDeterministicCommand } from './deterministic-query.js'
import { dockerInventoryCommand } from './docker-command.js'
const principal = { rawUserId: 'fixture', principalId: 'fixture', channel: 'cli', permission: 'owner' } as const
it('routes the exact reported local Docker question without inference', () => {
    expect(detectDeterministicCommand('Sag mir welche docker container local laufen')).toMatchObject({ command: 'docker', risk: 'read-only' })
    expect(detectDeterministicCommand('Liste Docker Container auf ns1 und stoppe sie')).toBeNull()
})
it('rejects missing or insufficient principal before registry execution', async () => {
    const tools = { execute: vi.fn() }
    expect(await dockerInventoryCommand('list', tools)).toContain('Owner/Admin')
    expect(await dockerInventoryCommand('list', tools, { ...principal, permission: 'user' })).toContain('Owner/Admin')
    expect(tools.execute).not.toHaveBeenCalled()
})
it('uses only docker_ps and preserves concrete missing-host error', async () => {
    const tools = { execute: vi.fn(async () => ({ success: false, error: 'Host agent not configured' })) }
    expect(await dockerInventoryCommand('list', tools, principal)).toContain('Host agent not configured')
    expect(tools.execute).toHaveBeenCalledExactlyOnceWith('docker_ps', { all: false })
})
it('requires exact host inventory evidence and does not accept unrelated tool output', async () => {
    expect(await dockerInventoryCommand('list', { execute: async () => ({ success: true, time: 'now' }) }, principal)).toContain('nicht verfügbar')
})
it('formats verified inventory without spending model tokens', async () => {
    const result = { success: true, operation: 'docker.list', nodeId: 'fixture', verifiedAt: new Date().toISOString(), evidenceHash: 'b'.repeat(64), count: 1, containers: [{ id: 'a'.repeat(64), names: ['/fixture'], state: 'running', image: 'fixture:1' }] }
    expect(await dockerInventoryCommand('list', { execute: async () => result }, principal)).toContain('Docker auf fixture: 1 Container')
})
