/**
 * 2.90.4 (VM 130 2.90.3, Telegram "test" 23:23:37-23:24:05): mesh_delegate failed three times with the same error
 * (23:23:51, :56, 24:01) between mesh_status/mesh_transport_status, and the run ended after 8 tools with the standard
 * failure text. The same tool with the same failure is not run a third time in one run - for every tool.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const net = vi.hoisted(() => ({ sends: 0 }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async () => { net.sends++; return { requestId: `req-${net.sends}`, ack: { status: 'unreachable', transport: 'direct', reason: 'no route to xaventra-ns1' } } },
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; net.sends = 0 })
// The model words the task differently each time (live), so only the failure repeats, not the arguments.
const delegate = (task: string) => ({ tool: 'mesh_delegate', args: { node_id: 'xaventra-ns1', task, wait_seconds: 0 } })

describe('the same failure is not repeated a third time in one run', () => {
    it('after two identical mesh_delegate failures the third call is not run', async () => {
        h = await createE2EHarness({ seed: async root => {
            const { mkdirSync, writeFileSync } = await import('node:fs')
            const { join } = await import('node:path')
            mkdirSync(join(root, '.nova-data'), { recursive: true })
            writeFileSync(join(root, '.nova-data', 'mesh.json'), JSON.stringify({ nodes: [{ node_id: 'xaventra-ns1', hostname: 'ns1' }], tasks: [] }))
        } })
        let third = ''
        const result = await h.telegram('Gib die Aufgabe uptime an ns1.', [
            delegate('uptime'), delegate('Führe uptime aus'),
            () => delegate('Bitte uptime auf ns1 ausführen'),
            call => { third = JSON.stringify(call.messages.at(-1)?.content ?? ''); return { text: 'ns1 ist gerade nicht erreichbar.' } },
        ])
        expect(result.error).toBeUndefined()
        expect(net.sends).toBe(2)
        expect(third).toMatch(/nicht erneut/)
        expect(result.final).toContain('nicht erreichbar')
    }, 120_000)
})
