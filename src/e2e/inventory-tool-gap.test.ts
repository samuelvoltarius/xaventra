/**
 * 2.89.4 Fix 3 over the real entry (createDaemonMessageEntry → message-pipeline →
 * runNovaAgent, Telegram input, real tool registry/router, scripted model):
 * "Mach eine Inventur, sag mir was wo läuft und was wir wo noch installieren können"
 * is a mesh-wide inventory — no target clarification, inventory tools offered or
 * executed, no false tool-gap, no internal escalation texts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

const ASK = 'Mach eine Inventur, sag mir was wo läuft und was wir wo noch installieren können'

describe('2.89.4 Inventur mesh-wide (real entry)', () => {
    it('no target clarification, inventory tools used, no false tool-gap, no internal texts', async () => {
        h = await createE2EHarness()
        const result = await h.telegram(ASK, [
            {
                tools: [
                    { name: 'environment_inventory', arguments: {} },
                    { name: 'mesh_status', arguments: {} },
                    { name: 'mesh_strengths', arguments: {} },
                ],
            },
            { text: 'Inventur: Hier läuft, und was wo noch installierbar wäre.' },
        ])
        expect(result.error).toBeUndefined()
        const text = [result.final, ...result.replies].join('\n')
        // (a) no target clarification for a mesh-wide question
        expect(text).not.toMatch(/Auf welchem Node, Dienst oder Ziel/i)
        expect(text).not.toMatch(/Worauf genau bezieht sich das/i)
        // (b) no false tool-gap
        expect(text).not.toMatch(/kein (?:eigenes|passendes) Werkzeug/i)
        expect(text).not.toMatch(/Soll ich es lernen\?/)
        expect(result.trace).not.toContain('capability:compound-gap')
        expect(result.trace).not.toContain('capability:limit-gap')
        expect(result.trace).not.toContain('capability:honest-no')
        // (c) no internal escalation texts
        expect(text).not.toMatch(/verifiziert fehlgeschlagen/i)
        expect(text).not.toMatch(/Doctor-Diagnose/i)
        // inventory tools reached the model (or ran in the bounded plan)
        const used = [...result.offeredTools, ...result.executedTools]
        expect(used).toEqual(expect.arrayContaining(['environment_inventory', 'mesh_status']))
    }, T)
})
