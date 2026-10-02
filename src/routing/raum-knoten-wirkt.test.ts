import { describe, expect, it } from 'vitest'
import { buildModelRegistry, type RegistryInputs } from './model-registry.js'
import { decideRunnerMultiRoute, type MultiRouteSettings } from './task-model-routing.js'

// Punkt 10 (2.86): Desktop-Räume und Bot-Profile speichern bevorzugte Knoten.
// Seit 2.84 (Schatten-Router entfernt) las sie niemand mehr. Jetzt wirken sie
// über den einen Messrouter: Kandidaten auf die bevorzugten Knoten
// eingeschränkt, solange dort ein gesunder, passender LOKALER Endpunkt
// existiert — auch wenn routing.multi aus ist (dann nur Knotenwahl, ohne
// Messbasis). Sonst Rückfall wie bisher plus Hinweis.

const OFF: MultiRouteSettings = { enabled: false, cloudDailyBudgetEur: 0 }
const ON: MultiRouteSettings = { enabled: true, cloudDailyBudgetEur: 0, minSamples: 5 }

const probe = (model: string, endpoint: string, online = true) => ({
    model, endpoint, online, supportsTools: true, supportsSystemPrompt: true, supportsVision: false, roles: ['chat', 'code', 'tools'],
})

function registry(pcOnline = true, extra: Partial<RegistryInputs> = {}) {
    return buildModelRegistry({
        knownNodes: ['spark', 'pc'],
        vllm: [{ node: 'spark', baseUrl: 'http://spark.example.com:8000/v1', models: ['spark-model'] }],
        ollama: [{ node: 'pc', baseUrl: 'http://pc.example.com:11434', models: [{ name: 'pc-model' }] }],
        probes: [probe('spark-model', 'http://spark.example.com:8000/v1'), probe('pc-model', 'http://pc.example.com:11434', pcOnline)],
        cloud: [{ provider: 'anthropic', model: 'cloud-a', keyPresent: true, costEurPerCall: 0.01 }],
        ...extra,
    })
}

const ask = (reg: ReturnType<typeof registry>, settings: MultiRouteSettings, preferredNodeIds: string[], content = 'Fasse mir den Plan für morgen zusammen.') =>
    decideRunnerMultiRoute({ content, hasImage: false, permission: 'owner', codexConfig: { enabled: false }, registry: reg, settings, preferredNodeIds })

describe('Raum bevorzugt Knoten', () => {
    it('Router aus: bevorzugter Knoten pc wird gewählt (Knotenwahl, keine Messbasis)', () => {
        const decision = ask(registry(), OFF, ['pc'])
        expect(decision.basis).toBe('raum')
        expect(decision.endpoint).toMatchObject({ node: 'pc', model: 'pc-model', privacy: 'lokal' })
        expect(decision.target).toBe('local')
        expect(decision.reason).toContain('Raum bevorzugt Knoten pc')
    })

    it('Router an, ohne Messdaten: ebenfalls pc statt Regeltabelle', () => {
        const decision = ask(registry(), ON, ['pc'])
        expect(decision.basis).toBe('raum')
        expect(decision.endpoint?.node).toBe('pc')
    })

    it('Reihenfolge der Vorgabe zählt: [spark, pc] -> spark', () => {
        expect(ask(registry(), OFF, ['spark', 'pc']).endpoint?.node).toBe('spark')
    })

    it('Gegenprobe: bevorzugter Knoten down -> Rückfall wie bisher, mit Hinweis', () => {
        const decision = ask(registry(false), OFF, ['pc'])
        expect(decision.basis).toBe('aus')
        expect(decision.endpoint).toBeUndefined()
        expect(decision.roomNotice).toMatch(/pc/)
    })

    it('ohne Vorgabe: unverändert (Router aus = reine Regeltabelle)', () => {
        const decision = ask(registry(), OFF, [])
        expect(decision.basis).toBe('aus')
        expect(decision.endpoint).toBeUndefined()
        expect(decision.roomNotice).toBeUndefined()
    })

    it('Privates und Bilder bleiben lokal; ein Cloud-Knoten-Name macht nichts zur Cloud', () => {
        const decision = ask(registry(), ON, ['cloud', 'pc'], 'Was weißt du noch über meine Familie?')
        expect(decision.endpoint?.privacy).toBe('lokal')
        expect(decision.endpoint?.node).toBe('pc')
    })
})

describe('Anwendung über den vorhandenen Weg (applyMultiRouteEndpoint)', () => {
    it('eine Raum-Entscheidung wird angewendet, eine Regel-Entscheidung nicht', async () => {
        const { applyMultiRouteEndpoint } = await import('./model-runtime.js')
        const rules = ask(registry(), OFF, [])
        expect(await applyMultiRouteEndpoint(rules)).toBeNull()
        const room = ask(registry(), OFF, ['spark'])
        // vLLM-Endpunkt: kein Ollama-Laden nötig, Client entsteht ohne Netz.
        const applied = await applyMultiRouteEndpoint(room)
        expect(applied).not.toBeNull()
        expect(applied?.cloud).toBe(false)
        expect((applied?.client as any)?.nodeId).toBe('spark')
    })
})
