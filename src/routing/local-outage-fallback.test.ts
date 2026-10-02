/**
 * 2.85 Paket C Punkt 5: lokal zuerst; fällt lokal aus, schaltet der
 * Multi-Router auf ein verbundenes Cloud-Modell um — nur für nicht-private
 * Inhalte, nur für den Owner, nur im Tagesbudget — und meldet das genau
 * einmal je Ausfall.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildModelRegistry, type RegistryInputs } from './model-registry.js'
import { decideMultiRoute, type MultiRouteSettings, type TaskModelDecisionInput } from './task-model-routing.js'

vi.mock('../llm/nova-llm-sdk.js', () => ({ createNovaLLMClient: async (config: any) => ({ modelId: config.model, provider: config.provider }) }))
vi.mock('./cloud-prompt.js', () => ({ createCloudSafeClient: (client: any) => ({ ...client, cloudSafe: true }) }))

import { applyMultiRouteEndpoint } from './model-runtime.js'

const ON: MultiRouteSettings = { enabled: true, cloudDailyBudgetEur: 1, minSamples: 5 }
const GENERAL = 'Erkläre mir bitte ausführlich, wie Gezeitenkräfte entstehen und warum es zwei Flutberge gibt, mit einem anschaulichen Beispiel für Kinder.'
const owner = (content: string, extra: Partial<TaskModelDecisionInput> = {}): TaskModelDecisionInput =>
    ({ permission: 'owner', codexEnabled: false, ...extra, signals: { content, ...(extra.signals || {}) } })

function registry(localOnline: boolean, extra: Partial<RegistryInputs> = {}) {
    return buildModelRegistry({
        knownNodes: ['node-a'],
        vllm: [{ node: 'node-a', baseUrl: 'http://node-a.invalid:8000/v1', models: ['local-a'] }],
        probes: [
            { model: 'local-a', endpoint: 'http://node-a.invalid:8000/v1', online: localOnline, supportsSystemPrompt: true, roles: ['chat', 'code'] },
            { model: 'cloud-a', endpoint: 'https://api.cloud-a.invalid/v1', online: true, supportsSystemPrompt: true, roles: ['chat', 'code'] },
        ],
        cloud: [{ provider: 'anthropic', model: 'cloud-a', keyPresent: true, costEurPerCall: 0.01 }],
        ...extra,
    })
}

describe('lokal zuerst, Cloud nur als Rückfall', () => {
    it('lokal gesund, keine Messdaten → Regeltabelle wie bisher (keine Cloud)', () => {
        const decision = decideMultiRoute(owner(GENERAL), registry(true), ON)
        expect(decision.basis).toBe('regeln')
        expect(decision.target).toBe('local')
    })

    it('alle lokalen Modelle ausgefallen → verbundenes Cloud-Modell als Rückfall, mit Hinweis', () => {
        const decision = decideMultiRoute(owner(GENERAL), registry(false), ON)
        expect(decision).toMatchObject({ target: 'cloud', basis: 'ausfall', rule: 'M2-lokal-ausfall', endpoint: { model: 'cloud-a', privacy: 'cloud' } })
        expect(decision.notice).toMatch(/lokale Modell .*nicht erreichbar/)
    })

    it('Ausfall, aber privat / Bild / Nicht-Owner / Budget 0 → bleibt lokal (nichts aufgeweicht)', () => {
        const priv = decideMultiRoute(owner('Was weißt du aus deinem Gedächtnis über meine Kunden? Bitte mit allen Details, die du kennst, damit ich das planen kann.'), registry(false), ON)
        expect(priv.target).toBe('local')
        const picture = decideMultiRoute(owner('x', { signals: { content: 'Bild', hasImage: true } }), registry(false), ON)
        expect(picture.target).toBe('local')
        const guest = decideMultiRoute({ ...owner(GENERAL), permission: 'user' }, registry(false), ON)
        expect(guest.target).toBe('local')
        const noBudget = decideMultiRoute(owner(GENERAL), registry(false), { ...ON, cloudDailyBudgetEur: 0 })
        expect(noBudget.target).toBe('local')
        for (const decision of [priv, picture, guest, noBudget]) expect(decision.basis).not.toBe('ausfall')
    })

    it('Umschalten wird genau einmal je Ausfall gemeldet; nach Erholung wieder', async () => {
        const down = decideMultiRoute(owner(GENERAL), registry(false), ON)
        const up = decideMultiRoute(owner(GENERAL), registry(true), ON)
        const first = await applyMultiRouteEndpoint(down)
        const second = await applyMultiRouteEndpoint(down)
        expect(first).toMatchObject({ cloud: true, notice: expect.stringMatching(/nicht erreichbar/) })
        expect(first!.client.cloudSafe).toBe(true)
        expect(second).toMatchObject({ cloud: true })
        expect(second!.notice).toBeUndefined()
        expect(await applyMultiRouteEndpoint(up)).toBeNull()
        const again = await applyMultiRouteEndpoint(down)
        expect(again!.notice).toMatch(/nicht erreichbar/)
    })
})
