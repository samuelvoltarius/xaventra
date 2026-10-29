/**
 * 2.90.2 (Abnahme 2.90.1, Langtest B, 29.10. 18:27:16): spawn_subagent to xaventra-ns1 was refused by the node
 * ("Mesh request rejected: Error: agent_tool_not_globally_allowed"). The tool called that "nicht erreichbar", the
 * model handed over twice more and asked mesh_nodes/nova_capabilities/mesh_status, and after 47.5 s the owner got
 * "noch nicht ganz fertig … Sag 'weiter'". A refused hand-over is ONE failed task, named "abgelehnt", and the
 * run ends with that sentence - no second hand-over, no wandering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const net = vi.hoisted(() => ({ sends: 0 }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async () => {
        net.sends++
        return { requestId: `req-${net.sends}`, ack: { status: 'rejected', transport: 'direct', reason: 'Error: agent_tool_not_globally_allowed' } }
    },
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; net.sends = 0 })

const HANDOVER = { tool: 'spawn_subagent', args: { task: 'Sag mir, wie spät es dort ist.', mesh_node: 'xaventra-ns1', timeout_seconds: 60 } }

describe('a refused hand-over to a node', () => {
    it('is one failed task named "abgelehnt"; the run ends without a second hand-over', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram('Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist.', [
            HANDOVER, HANDOVER, { tool: 'mesh_nodes' }, { text: 'Der Knoten ist nicht erreichbar.' },
        ])
        expect(result.error).toBeUndefined()
        expect(net.sends).toBe(1)
        expect(result.executedTools.filter(name => name === 'spawn_subagent')).toHaveLength(1)
        expect(result.executedTools).not.toContain('mesh_nodes')
        expect(result.final).toMatch(/abgelehnt/)
        expect(result.final).toMatch(/xaventra-ns1/)
        expect(result.final).not.toMatch(/nicht erreichbar|Sag „weiter“/)
    }, 120_000)
})
