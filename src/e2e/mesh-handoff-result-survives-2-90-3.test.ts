/**
 * 2.90.3 (VM 130 2.90.2, ns1 2.90.2, Desktop-API probe 00:06): „Gib diese Aufgabe an ns1: Sag mir, wie spät es dort
 * ist und welche Version ns1 hat.“ → spawn_subagent → ns1 ✅ (the hand-over works) → get_current_time,
 * environment_inventory, mesh_status → a SECOND spawn_subagent to ns1 with explicit tools → ns1 rejected it → the
 * R2 stop ended the run with only "⛔ Übergabe an xaventra-ns1 abgelehnt …" (83 chars): the proven result of the first
 * hand-over was lost. Proven results survive a later rejection (the stop sentence is appended, never replaces them),
 * and a successful hand-over tells the model not to hand the same node the task again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const net = vi.hoisted(() => ({ sends: 0 }))
const NS1_RESULT = 'Auf xaventra-ns1 ist es 00:06 Uhr, Version 2.90.2.'
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async () => {
        net.sends++
        return net.sends === 1
            ? { requestId: 'req-1', ack: { status: 'delivered', transport: 'direct' } }
            : { requestId: `req-${net.sends}`, ack: { status: 'rejected', transport: 'direct', reason: 'Error: agent_tool_not_globally_allowed' } }
    },
    waitForMeshRunResult: async () => ({ success: true, result: NS1_RESULT, evidence: [] }),
    cancelMeshRun: async () => undefined,
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; net.sends = 0 })

describe('a proven hand-over result survives a later rejection', () => {
    it('the answer keeps the ns1 result and appends the rejection', async () => {
        h = await createE2EHarness({})
        let firstResult = ''
        const result = await h.telegram('Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist und welche Version ns1 hat.', [
            { tool: 'spawn_subagent', args: { task: 'Sag mir, wie spät es dort ist und welche Version ns1 hat.', mesh_node: 'xaventra-ns1', timeout_seconds: 60 } },
            call => {
                firstResult = JSON.stringify(call.messages.at(-1)?.content ?? '')
                return { tool: 'get_current_time' }
            },
            { tool: 'spawn_subagent', args: { task: 'Rufe zuerst das Werkzeug get_current_time auf und rufe danach das Werkzeug version auf.', mesh_node: 'xaventra-ns1', tools: 'get_current_time,version', timeout_seconds: 60 } },
            { text: 'Fertig.' },
        ])
        expect(result.error).toBeUndefined()
        expect(net.sends).toBe(2)
        expect(result.final).toContain(NS1_RESULT)
        expect(result.final).toMatch(/abgelehnt/)
        expect(result.final.indexOf(NS1_RESULT)).toBeLessThan(result.final.indexOf('abgelehnt'))
        // The model was told after the first success not to hand the same node the task again.
        expect(firstResult).toMatch(/nicht erneut/)
    }, 120_000)
})
