/**
 * 2.90.2 (VM 130, 2.90.0, 29.10. 18:57:28-37, desktop): „Nutze mesh_screenshot mit node_id "xaventra-lab" und sag
 * mir nur, ob die Aufnahme geklappt hat." The first mesh_screenshot failed (no Telegram image recipient on the
 * desktop channel), the second with send=false returned captured:true, delivered:false. The model said the capture
 * worked; the reply sent was "Das habe ich gerade nicht hinbekommen und nichts verändert": without an action intent
 * an observation tool did not count as evidence for the claim. A successful capture is evidence; captured:false
 * stays a failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

const lab = vi.hoisted(() => ({ captured: true }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    currentCaptureNodes: () => ['xaventra-lab'],
    requestNodeCapture: async () => {
        if (!lab.captured) throw new Error('headless: no enrolled adapter')
        return { bytes: 24, base64: Buffer.alloc(24).toString('base64'), sha256: 'c'.repeat(64), capturedAt: new Date().toISOString() }
    },
}))

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; lab.captured = true })

const ASK = 'Nutze mesh_screenshot mit node_id "xaventra-lab" und sag mir nur, ob die Aufnahme geklappt hat.'
const script = (reply: string) => [
    { tool: 'mesh_screenshot', args: { node_id: 'xaventra-lab' } },
    { tool: 'mesh_screenshot', args: { node_id: 'xaventra-lab', send: false } },
    { text: reply },
]

describe('a node capture that worked is reported as such', () => {
    it('captured:true after an earlier failed call keeps the model answer', async () => {
        h = await createE2EHarness({})
        const result = await h.desktop(ASK, script('Ja, die Aufnahme vom Lab wurde erstellt; zustellen kann ich das Bild über diesen Kanal nicht.'))
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/Aufnahme vom Lab wurde erstellt/)
        expect(result.final).not.toMatch(/nicht hinbekommen|nichts verändert/)
    }, 120_000)

    it('captured:false stays a failure: a claimed capture is not delivered as fact', async () => {
        lab.captured = false
        h = await createE2EHarness({})
        const result = await h.desktop(ASK, script('Ja, die Aufnahme vom Lab wurde erstellt.'))
        expect(result.error).toBeUndefined()
        expect(result.final).not.toMatch(/Aufnahme vom Lab wurde erstellt/)
    }, 120_000)
})
