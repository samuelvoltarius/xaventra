/**
 * 2.92.2 (Modellstufen, Alfreds Ja aus der Server-Sicherung): der Hauptzug bleibt beim schnellen MiniMax-M3.1-Flash;
 * nach einem Werkzeugfehler oder einem Ergebnis über 6000 Zeichen rechnet genau der nächste Schritt mit MiniMax-M3.
 * Kein neuer Anbieter, private Regeln R1/R2 davor, ein Ausfall von M3 fällt auf Flash zurück.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { decideRunnerTaskModel, pickStepModel, stepTierClient, STEP_TIER_RESULT_CHARS } from '../routing/task-model-routing.js'

const strong = vi.hoisted(() => ({ calls: [] as string[], configs: [] as any[], fail: false, reply: 'Laut Auswertung fertig.' }))
vi.mock('../llm/nova-llm-sdk.js', async importOriginal => {
    const original: any = await importOriginal()
    return {
        ...original,
        createNovaLLMClient: async (config: any) => {
            if (config?.model !== 'MiniMax-M3') return original.createNovaLLMClient(config)
            strong.configs.push(config)
            return {
                modelId: 'MiniMax-M3', providerId: 'minimax',
                complete: async () => {
                    strong.calls.push('M3')
                    if (strong.fail) throw new Error('MiniMax API error (500)')
                    return { content: strong.reply, model: 'MiniMax-M3', tokensUsed: 5 }
                },
            }
        },
    }
})

const flash = (content: string, hasImage = false, permission = 'owner') => decideRunnerTaskModel({
    content, hasImage, permission, codexConfig: null, primaryModel: 'MiniMax-M3.1-Flash', primaryProvider: 'minimax',
})

describe('the step tier hangs on the rule table', () => {
    it('a normal Flash run gets the tier, the strong model is the documented MiniMax-M3', () => {
        expect(flash('Wie spät ist es in Tokio?').stepTier).toEqual({ provider: 'minimax', fast: 'MiniMax-M3.1-Flash', strong: 'MiniMax-M3' })
    })
    it('the private rules R1/R2 come first', () => {
        expect(flash('Beschreibe dieses Bild', true).rule).toBe('R1-vision-local')
        expect(flash('Beschreibe dieses Bild', true).stepTier).toBeUndefined()
        const secret = flash('Was steht in meinem Memory über Kundendaten?', false)
        expect(secret.private).toBe(true)
        expect(secret.stepTier).toBeUndefined()
    })
    it('no tier on another model or another provider', () => {
        const other = decideRunnerTaskModel({ content: 'Hallo Welt, was gibt es Neues', hasImage: false, permission: 'owner', primaryModel: 'MiniMax-M3', primaryProvider: 'minimax' })
        expect(other.stepTier).toBeUndefined()
        expect(decideRunnerTaskModel({ content: 'Hallo Welt, was gibt es Neues', hasImage: false, permission: 'owner', primaryModel: 'MiniMax-M3.1-Flash', primaryProvider: 'local' }).stepTier).toBeUndefined()
    })
    it('picks by the tool results of the last step only', () => {
        expect(pickStepModel([])).toBe('fast')
        expect(pickStepModel([{ success: true, result: 'x'.repeat(STEP_TIER_RESULT_CHARS) }])).toBe('fast')
        expect(pickStepModel([{ success: true, result: 'x'.repeat(STEP_TIER_RESULT_CHARS + 1) }])).toBe('strong')
        expect(pickStepModel([{ success: true, result: 'ok' }, { success: false, result: 'kaputt' }])).toBe('strong')
    })
    it('the next step after the strong one is fast again', async () => {
        const executions: any[] = [{ success: false, result: 'kaputt' }]
        const used: string[] = []
        const client = stepTierClient({ modelId: 'f', complete: async () => { used.push('f'); return { content: 'a' } } } as any, () => executions,
            async () => ({ modelId: 's', complete: async () => { used.push('s'); return { content: 'b' } } }) as any)
        await client.complete([], [], {})
        expect(client.modelId).toBe('s')
        await client.complete([], [], {})
        expect(used).toEqual(['s', 'f'])
        expect(client.modelId).toBe('f')
    })
})

describe('over the real entry', () => {
    let h: E2EHarness | undefined
    beforeEach(() => { strong.calls.length = 0; strong.configs.length = 0; strong.fail = false })
    afterEach(async () => { await h?.close(); h = undefined })

    it('a failed tool sends the next step to M3, on the same provider', async () => {
        h = await createE2EHarness({})
        h.model.modelId = 'MiniMax-M3.1-Flash'; h.model.providerId = 'minimax'
        const result = await h.telegram(`Lies bitte die Datei ${join(h.root, 'fehlt.txt')}`, [{ tool: 'read_file', args: { path: join(h.root, 'fehlt.txt') } }, { text: 'Flash-Antwort.' }])
        expect(result.error).toBeUndefined()
        expect(strong.calls).toEqual(['M3'])
        expect(strong.configs[0]).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3', isolated: true })
    }, 120_000)
    it('a small successful result stays on Flash (counter-test)', async () => {
        h = await createE2EHarness({})
        h.model.modelId = 'MiniMax-M3.1-Flash'; h.model.providerId = 'minimax'
        writeFileSync(join(h.root, 'tier-notiz.txt'), 'kurz')
        await h.telegram(`Lies bitte die Datei ${join(h.root, 'tier-notiz.txt')}`, [{ tool: 'read_file', args: { path: join(h.root, 'tier-notiz.txt') } }, { text: 'Alles gut.' }])
        expect(strong.calls).toEqual([])
    }, 120_000)
    it('M3 down: the step still ends on Flash', async () => {
        strong.fail = true
        h = await createE2EHarness({})
        h.model.modelId = 'MiniMax-M3.1-Flash'; h.model.providerId = 'minimax'
        const result = await h.telegram(`Lies bitte die Datei ${join(h.root, 'fehlt.txt')}`, [{ tool: 'read_file', args: { path: join(h.root, 'fehlt.txt') } }, { text: 'Flash-Antwort nach Ausfall.' }])
        expect(strong.calls).toEqual(['M3'])
        expect(result.error).toBeUndefined()
        expect(h.model.remaining).toBe(0)
    }, 120_000)
})
