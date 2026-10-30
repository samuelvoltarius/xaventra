/**
 * 2.90.4 (VM 130 2.90.3, Telegram "test" 23:23:37): with the previous acceptance topic in the hot history the model
 * continued it: get_current_time → load_skill_pack("mesh-network") → mesh_nodes → mesh_delegate ×3 → standard failure
 * text after 28.7 s. A short message without its own topic loads no tool pack: no load_skill_pack, no on-demand tools.
 * Continuation words ("weiter") keep their way.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { toolExpansionPolicy } from '../tools/tool-router.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('"test" does not pick up a tool pack from the history', () => {
    it('offers no load_skill_pack and loads no mesh tools for "test"', async () => {
        h = await createE2EHarness({})
        await h.telegram('Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist.', [{ text: 'Ich habe es an ns1 übergeben.' }])
        const result = await h.telegram('test', [
            { tool: 'get_current_time' },
            { tool: 'load_skill_pack', args: { pack_name: 'mesh-network' } },
            { tool: 'mesh_nodes' },
            { tool: 'mesh_delegate', args: { node_id: 'xaventra-ns1', task: 'uptime', wait_seconds: 0 } },
            { text: 'Test angekommen.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.offeredTools).not.toContain('load_skill_pack')
        expect(result.executedTools).not.toContain('load_skill_pack')
        expect(result.executedTools).not.toContain('mesh_delegate')
        expect(result.executedTools).not.toContain('mesh_nodes')
    }, 120_000)

    it('a topicless short message is sealed; continuation and real requests are not', () => {
        expect(toolExpansionPolicy('test').sealed).toBe(true)
        expect(toolExpansionPolicy('hallo?').sealed).toBe(true)
        expect(toolExpansionPolicy('weiter').sealed).toBe(false)
        expect(toolExpansionPolicy('ja, mach').sealed).toBe(false)
        expect(toolExpansionPolicy('Wie spät ist es auf ns1?').sealed).toBe(false)
        expect(toolExpansionPolicy('status').sealed).toBe(false)
        expect(toolExpansionPolicy('Test der Heizung').sealed).toBe(false)
    })
})
