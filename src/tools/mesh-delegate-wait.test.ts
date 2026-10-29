import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setKnownNodeNamesForTests } from '../mesh/known-node-names.js'

// Telegram 28.10. (2.89.11, Langtest B) "Führe auf ns2 die Befehle uptime und df -h / aus und sag mir die
// Ergebnisse": mesh_delegate answered "An Knoten übergeben … Status: pending" and the run went on locally
// (uptime of the Main, not ns2). The tool must wait for the node's result and return it.
const mesh = vi.hoisted(() => ({ delegateTask: vi.fn(), getTaskResult: vi.fn() }))
vi.mock('../mesh/mesh-registry.js', async importOriginal => ({ ...(await importOriginal<object>()), ...mesh }))

import { ALL_TOOLS } from './complete-registry.js'

// The handler imports the mesh registry lazily; load it once on real time.
beforeAll(async () => { await import('../mesh/mesh-registry.js'); await import('../mesh/peer-refusal.js'); setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns2' }]) }, 60_000)
afterAll(() => setKnownNodeNamesForTests(null))
const delegate = () => ALL_TOOLS.find(tool => tool.name === 'mesh_delegate')!
afterEach(() => { vi.useRealTimers(); mesh.delegateTask.mockReset(); mesh.getTaskResult.mockReset() })
/** Advance fake time in steps until the handler settles (its first await is a real module import). */
async function settle(pending: Promise<unknown>, maxSeconds: number): Promise<unknown> {
    let done = false
    pending.finally(() => { done = true }).catch(() => undefined)
    for (let second = 0; second < maxSeconds && !done; second++) await vi.advanceTimersByTimeAsync(1_000)
    return pending
}

describe('mesh_delegate waits for the node', () => {
    it('returns the result the node reports', async () => {
        vi.useFakeTimers()
        mesh.delegateTask.mockResolvedValue({ id: 'req-1', to_node: 'xaventra-ns2', status: 'pending', transport: 'direct' })
        mesh.getTaskResult.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'req-1', status: 'pending' })
            .mockResolvedValue({ id: 'req-1', status: 'done', result: ' 21:19:02 up 12 days,  3:04\n/dev/sda1  98G  41G  53G  44% /' })
        const pending = delegate().handler({ node_id: 'xaventra-ns2', task: 'uptime und df -h /' })
        const text = String(await settle(pending, 30))
        expect(text).toContain('up 12 days')
        expect(text).toContain('44% /')
        expect(text).toContain('xaventra-ns2')
    })

    it('says honestly when no result came in time', async () => {
        vi.useFakeTimers()
        mesh.delegateTask.mockResolvedValue({ id: 'req-2', to_node: 'xaventra-ns2', status: 'pending', transport: 'direct' })
        mesh.getTaskResult.mockResolvedValue(null)
        const pending = delegate().handler({ node_id: 'xaventra-ns2', task: 'uptime', wait_seconds: 20 })
        const text = String(await settle(pending, 40))
        expect(text).toMatch(/kein Ergebnis/)
        expect(text).toContain('req-2')
    })

    it('reports a failure of the node as failure', async () => {
        vi.useFakeTimers()
        mesh.delegateTask.mockResolvedValue({ id: 'req-3', to_node: 'xaventra-ns2', status: 'pending', transport: 'direct' })
        mesh.getTaskResult.mockResolvedValue({ id: 'req-3', status: 'failed', result: 'command blocked' })
        const pending = delegate().handler({ node_id: 'xaventra-ns2', task: 'uptime' })
        const result: any = await settle(pending, 30)
        expect(JSON.stringify(result)).toContain('command blocked')
        expect(result.success).toBe(false)
    })
})
