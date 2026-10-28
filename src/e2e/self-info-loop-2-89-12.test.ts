/**
 * 2.89.12 (Telegram 28.10.2026, 2.89.11): every multi-step task circled in self-description until the
 * budget ran out - screenshot: desktop_screenshot, browser_status, nova_capabilities ×5 → "Provider exceeded
 * the admitted inference budget"; Kube/mesh tasks up to 6× nova_capabilities, environment_inventory, mesh_*.
 * The loop detector only catches identical arguments; each call asked another topic.
 * Over the real Telegram entry; only the model is scripted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

const capabilities = (topic: string) => ({ tool: 'nova_capabilities', args: { topic } })

describe('2.89.12 self-description loop', () => {
    it('stops asking about itself after three calls and answers honestly', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Mach einen Screenshot und sag mir, was du siehst', [
            capabilities('screenshot'), capabilities('desktop'), capabilities('browser'),
            capabilities('mesh'), capabilities('capture'), capabilities('display'),
            { text: 'Ich kann hier keinen Screenshot machen, weil dieser Rechner keine Anzeige hat.' },
        ])
        const asked = result.executedTools.filter((name: string) => name === 'nova_capabilities').length
        expect(asked).toBeLessThanOrEqual(3)
        // The model gets one note to act or to say honestly what is missing; then the run ends.
        expect(result.rounds.length).toBeLessThanOrEqual(6)
        expect(result.final).not.toMatch(/Werkzeugaufrufe .* aufgebraucht|inference budget/i)
        expect(result.final.length).toBeGreaterThan(10)
    }, T)

    it('two self-description calls followed by the real tool are untouched (control)', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Lies die Datei notizen.txt und fasse sie zusammen', [
            capabilities('datei'), capabilities('lesen'), { tool: 'read_file', args: { path: 'notizen.txt' } }, { text: 'Die Datei notizen.txt gibt es nicht.' },
        ])
        expect(result.executedTools.filter((name: string) => name === 'nova_capabilities').length).toBe(2)
        expect(result.executedTools).toContain('read_file')
    }, T)
})
