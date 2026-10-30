/**
 * 2.90.5 (VM 130 2.90.4, Desktop-API 03:44:52): „Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist und welche
 * Version ns1 hat." → spawn_subagent → ns1 ✅ (58 s) → then locally get_current_time, mesh_status, version_info,
 * environment_inventory, nova_capabilities, update_history, mesh_strengths, nova_capabilities, get_current_time →
 * after 101 s „Ich habe mehrmals nur nachgesehen, was ich kann … Die genaue Uhrzeit auf ns1 wurde nicht abgefragt".
 * ns1 had delivered. (1) A whole task handed to a node ends with the node's proven result - no further model step.
 * (2) Every stop/summary text keeps proven hand-over results. Counter-test: a refused hand-over stays an honest no.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const NS1_RESULT = 'Auf xaventra-ns1 ist es 03:45 Uhr, Version 2.90.4.'
const net = vi.hoisted(() => ({ sends: 0, reject: false }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async () => {
        net.sends++
        return net.reject
            ? { requestId: `req-${net.sends}`, ack: { status: 'rejected', transport: 'direct', reason: 'Error: agent_tool_not_globally_allowed' } }
            : { requestId: `req-${net.sends}`, ack: { status: 'delivered', transport: 'direct' } }
    },
    waitForMeshRunResult: async () => ({ success: true, result: 'Auf xaventra-ns1 ist es 03:45 Uhr, Version 2.90.4.', evidence: [] }),
    cancelMeshRun: async () => undefined,
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; net.sends = 0; net.reject = false })

const seedNodes = async (root: string) => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'mesh.json'), JSON.stringify({ nodes: [{ node_id: 'xaventra-ns1', hostname: 'ns1' }], tasks: [] }))
}
const HANDOVER = { tool: 'spawn_subagent', args: { task: 'Sag mir, wie spät es dort ist und welche Version ns1 hat.', mesh_node: 'xaventra-ns1', timeout_seconds: 60 } }
const WANDER = [
    { tool: 'get_current_time' }, { tool: 'mesh_status' }, { tool: 'environment_inventory' },
    { tool: 'nova_capabilities' }, { tool: 'nova_capabilities' }, { tool: 'nova_introspect' }, { tool: 'nova_capabilities' },
    { text: 'Die genaue Uhrzeit auf ns1 wurde nicht abgefragt.' },
]

describe('a proven hand-over result is the answer', () => {
    it('(1) "Gib diese Aufgabe an ns1: …" ends with the ns1 result, nothing runs after it', async () => {
        h = await createE2EHarness({ seed: seedNodes })
        const result = await h.desktop('Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist und welche Version ns1 hat.', [HANDOVER, ...WANDER])
        expect(result.error).toBeUndefined()
        expect(result.executedTools).toEqual(['spawn_subagent'])
        expect(result.final).toContain(NS1_RESULT)
        expect(result.final).not.toMatch(/nicht abgefragt|nachgesehen, was ich kann/)
    }, 120_000)

    it('(2) a self-description stop after a successful hand-over keeps the ns1 result', async () => {
        h = await createE2EHarness({ seed: seedNodes })
        const result = await h.desktop('Finde heraus, wie spät es auf ns1 ist und welche Version dort läuft.', [HANDOVER, ...WANDER])
        expect(result.error).toBeUndefined()
        expect(result.executedTools[0]).toBe('spawn_subagent')
        expect(result.final).toContain(NS1_RESULT)
    }, 120_000)

    it('counter-test: a refused hand-over stays an honest "abgelehnt"', async () => {
        net.reject = true
        h = await createE2EHarness({ seed: seedNodes })
        const result = await h.desktop('Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist.', [HANDOVER, ...WANDER])
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/abgelehnt/)
        expect(result.final).not.toContain(NS1_RESULT)
    }, 120_000)
})
