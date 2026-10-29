/**
 * 2.90.3 (Langtest D, VM 130, 2.90.2, 30.10. 00:06:38, desktop): „Öffne auf dem Lab greenchili.at und mach einen
 * Screenshot davon. Sag mir nur, ob es geklappt hat und was auf der Seite oben steht." The router offered browser_*
 * and the local desktop_* tools, but neither mesh_desktop_input nor mesh_screenshot ("Lab" was no node mention).
 * The model called nova_capabilities twice, nova_introspect, then spawn_subagent to xaventra-lab, which the lab
 * refused. The way is direct from Main: one open_url on the lab workstation, one capture of the lab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])
const shot = () => ({ nodeId: 'xaventra-lab', capturedAt: new Date().toISOString(), bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'), base64: png.toString('base64'), mimeType: 'image/png' as const })
const lab = vi.hoisted(() => ({ inputs: [] as Array<{ node: string; payload: any }>, captures: [] as string[], refuse: '' }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    currentCaptureNodes: () => ['xaventra-spark', 'xaventra-lab'],
    requestNodeInput: async (node: string, payload: any) => {
        lab.inputs.push({ node, payload })
        if (lab.refuse) throw new Error(`DesktopActionRefused: Desktop action refused: ${lab.refuse}`)
        return { nodeId: node, input: { requestId: payload.requestId, status: 'completed', replayed: false }, capture: shot() }
    },
    requestNodeCapture: async (node: string) => { lab.captures.push(node); return shot() },
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; lab.inputs = []; lab.captures = []; lab.refuse = '' })

const ASK = 'Öffne auf dem Lab greenchili.at und mach einen Screenshot davon. Sag mir nur, ob es geklappt hat und was auf der Seite oben steht.'

describe('open a page on the lab computer (Langtest D)', () => {
    it('offers the node workstation tools and no hand-over to a subagent', async () => {
        h = await createE2EHarness({})
        const result = await h.desktop(ASK, [{ text: 'Moment.' }])
        expect(result.offeredTools).toEqual(expect.arrayContaining(['mesh_desktop_input', 'mesh_screenshot', 'analyze_image']))
        for (const name of ['spawn_subagent', 'spawn_subagents_parallel', 'mesh_delegate', 'desktop_input', 'desktop_screenshot', 'browser_open'])
            expect(result.offeredTools).not.toContain(name)
    }, 120_000)

    it('one open_url on the lab and one lab capture, then the answer', async () => {
        h = await createE2EHarness({})
        const result = await h.desktop(ASK, [
            { tool: 'mesh_desktop_input', args: { node_id: 'lab', action: '{"action":"open_url","url":"https://greenchili.at/"}', step: 'oeffnen-1' } },
            { tool: 'mesh_screenshot', args: { node_id: 'lab', send: false } },
            { text: 'Ja, hat geklappt. Oben steht „VIDEOGRAF".' },
        ])
        expect(result.error).toBeUndefined()
        expect(lab.inputs).toHaveLength(1)
        expect(lab.inputs[0]).toMatchObject({ node: 'xaventra-lab', payload: { operation: 'input', action: { action: 'open_url', url: 'https://greenchili.at/' } } })
        expect(lab.captures).toEqual(['xaventra-lab'])
        expect(result.executedTools).not.toContain('spawn_subagent')
        expect(result.final).toMatch(/VIDEOGRAF/)
    }, 120_000)

    it('Telegram: never falls back to a local desktop screenshot of the daemon host', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram(ASK, [
            { tool: 'mesh_desktop_input', args: { node_id: 'lab', action: '{"action":"open_url","url":"https://greenchili.at/"}', step: 'oeffnen-1' } },
            { tool: 'mesh_screenshot', args: { node_id: 'lab', send: false } },
            { text: 'Ja, hat geklappt. Oben steht „VIDEOGRAF".' },
        ])
        expect(result.executedTools).not.toContain('desktop_screenshot')
        expect(result.executedTools).not.toContain('screenshot')
        expect(result.final).toMatch(/VIDEOGRAF/)
    }, 120_000)

    it('Gegenprobe: a page outside the allowlist ends as a clear refusal, never as success', async () => {
        lab.refuse = 'nicht auf der Erlaubnisliste: wikipedia.org'
        h = await createE2EHarness({})
        const result = await h.desktop('Öffne auf dem Lab wikipedia.org und mach einen Screenshot davon.', [
            { tool: 'mesh_desktop_input', args: { node_id: 'lab', action: '{"action":"open_url","url":"https://wikipedia.org/"}', step: 'oeffnen-1' } },
            { text: 'Das Lab hat abgelehnt: nicht auf der Erlaubnisliste: wikipedia.org. Es wurde nichts geöffnet.' },
        ])
        expect(result.error).toBeUndefined()
        expect(lab.inputs).toHaveLength(1)
        expect(result.final).toMatch(/nicht auf der Erlaubnisliste: wikipedia\.org/)
        expect(result.final).not.toMatch(/hat geklappt|geöffnet und/i)
    }, 120_000)
})
