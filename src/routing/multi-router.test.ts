import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildModelRegistry, type RegistryInputs } from './model-registry.js'
import {
    decideMultiRoute,
    decideTaskModel,
    readMultiRouteSettings,
    type MultiRouteSettings,
    type TaskModelDecisionInput,
} from './task-model-routing.js'

// Phase 6d Multi-Router: stage A hard filters (never loosened by a model),
// stage B measured success > latency > cost, R1–R8 as fallback without data.

const NODE_A = 'node-a'
const NODE_B = 'node-b'
const ON: MultiRouteSettings = { enabled: true, cloudDailyBudgetEur: 0, minSamples: 5 }

const measure = (model: string, node: string | undefined, taskClass: string, successes: number, samples: number, ms: number) =>
    Array.from({ length: samples }, (_, index) => ({
        runId: `${model}-${taskClass}-${index}`, status: index < successes ? 'completed' : 'failed', model, node,
        startedAt: '2026-10-01T10:00:00.000Z', updatedAt: new Date(Date.parse('2026-10-01T10:00:00.000Z') + ms).toISOString(),
        validation: index < successes ? { success: true, validator: 'nova-execution-kernel' } : undefined,
        events: [{ type: 'route.selected', payload: { modelClass: taskClass } }],
    }))

function registry(extra: Partial<RegistryInputs> = {}) {
    return buildModelRegistry({
        knownNodes: [NODE_A, NODE_B],
        vllm: [{ node: NODE_A, baseUrl: 'http://node-a.invalid:8000/v1', models: ['local-a'] }],
        ollama: [{ node: NODE_B, baseUrl: 'http://node-b.invalid:11434', models: [{ name: 'local-b' }, { name: 'local-vision' }] }],
        probes: [
            { model: 'local-a', endpoint: 'http://node-a.invalid:8000/v1', online: true, supportsTools: true, supportsSystemPrompt: true, supportsVision: false, roles: ['chat', 'code', 'tools'] },
            { model: 'local-b', endpoint: 'http://node-b.invalid:11434', online: true, supportsTools: true, supportsSystemPrompt: true, supportsVision: false, roles: ['chat', 'code'] },
            { model: 'local-vision', endpoint: 'http://node-b.invalid:11434', online: true, supportsTools: false, supportsSystemPrompt: true, supportsVision: true, roles: ['chat', 'vision'] },
            { model: 'cloud-a', endpoint: 'https://api.cloud-a.invalid/v1', online: true, supportsTools: true, supportsSystemPrompt: true, supportsVision: true, roles: ['chat', 'code', 'vision', 'tools'] },
        ],
        codex: { enabled: true, model: 'codex-test', available: true },
        cloud: [{ provider: 'anthropic', model: 'cloud-a', keyPresent: true, costEurPerCall: 0.01 }],
        ...extra,
    })
}

// Cloud measured as clearly the best everywhere: every filter test must still keep it out.
const cloudBest = [
    ...measure('cloud-a', undefined, 'vision', 10, 10, 200), ...measure('cloud-a', undefined, 'general', 10, 10, 200),
    ...measure('cloud-a', undefined, 'code', 10, 10, 200), ...measure('cloud-a', undefined, 'short', 10, 10, 200),
    ...measure('local-vision', NODE_B, 'vision', 6, 10, 3000), ...measure('local-a', NODE_A, 'general', 6, 10, 3000),
    ...measure('local-a', NODE_A, 'code', 6, 10, 3000), ...measure('local-a', NODE_A, 'short', 6, 10, 3000),
]

const owner = (content: string, extra: Partial<TaskModelDecisionInput> = {}): TaskModelDecisionInput =>
    ({ permission: 'owner', codexEnabled: false, ...extra, signals: { content, ...(extra.signals || {}) } })

describe('multi-router stage A: hard filters', () => {
    it('never sends a picture to the cloud, even with budget and better cloud measurements', () => {
        const decision = decideMultiRoute(owner('Was ist auf dem Bild?', { signals: { content: 'x', hasImage: true } }), registry({ ledgerRuns: cloudBest as any }), { ...ON, cloudDailyBudgetEur: 100 })
        expect(decision.target).toBe('local')
        expect(decision.endpoint?.model).toBe('local-vision')
        expect(decision.candidates.find(item => item.model === 'cloud-a')?.excluded).toMatch(/Bild/)
    })

    it('never sends private content (memory, customer data) to the cloud', () => {
        const decision = decideMultiRoute(owner('Was weißt du aus deinem Gedächtnis über meine Kunden? Bitte ausführlich, mit allen Details und Zusammenhängen, die du kennst, damit ich das planen kann.'),
            registry({ ledgerRuns: cloudBest as any }), { ...ON, cloudDailyBudgetEur: 100 })
        expect(decision.private).toBe(true)
        expect(decision.target).toBe('local')
        expect(decision.candidates.find(item => item.model === 'cloud-a')?.excluded).toMatch(/Privat/)
    })

    it('budget 0 € keeps every non-Codex cloud model out (default)', () => {
        const general = 'Erkläre mir bitte ausführlich, wie Gezeitenkräfte entstehen und warum es zwei Flutberge gibt, mit einem anschaulichen Beispiel für Kinder.'
        const decision = decideMultiRoute(owner(general), registry({ ledgerRuns: cloudBest as any }), ON)
        expect(decision.target).toBe('local')
        expect(decision.candidates.find(item => item.model === 'cloud-a')?.excluded).toMatch(/Tagesbudget 0/)
        // Gegenprobe: with budget the same request may go to the measured-better cloud model.
        const paid = decideMultiRoute(owner(general), registry({ ledgerRuns: cloudBest as any }), { ...ON, cloudDailyBudgetEur: 1 })
        expect(paid.target).toBe('cloud')
        expect(paid.endpoint?.model).toBe('cloud-a')
        // Spent budget closes it again.
        const spent = decideMultiRoute(owner(general), registry({ ledgerRuns: cloudBest as any }), { ...ON, cloudDailyBudgetEur: 1, cloudSpentTodayEur: 0.995 })
        expect(spent.target).toBe('local')
        expect(spent.candidates.find(item => item.model === 'cloud-a')?.excluded).toMatch(/erschöpft/)
    })

    it('treats unknown cloud cost as expensive', () => {
        const general = 'Erkläre mir bitte ausführlich, wie Gezeitenkräfte entstehen und warum es zwei Flutberge gibt, mit einem anschaulichen Beispiel für Kinder.'
        const reg = registry({ ledgerRuns: cloudBest as any, cloud: [{ provider: 'anthropic', model: 'cloud-a', keyPresent: true }] })
        const decision = decideMultiRoute(owner(general), reg, { ...ON, cloudDailyBudgetEur: 100 })
        expect(decision.target).toBe('local')
        expect(decision.candidates.find(item => item.model === 'cloud-a')?.excluded).toMatch(/Kosten unbekannt/)
    })

    it('gives non-owners only local models', () => {
        const general = 'Erkläre mir bitte ausführlich, wie Gezeitenkräfte entstehen und warum es zwei Flutberge gibt, mit einem anschaulichen Beispiel für Kinder.'
        for (const permission of ['admin', 'user', 'guest', undefined]) {
            const decision = decideMultiRoute({ ...owner(general), permission }, registry({ ledgerRuns: cloudBest as any }), { ...ON, cloudDailyBudgetEur: 100 })
            expect(decision.target).toBe('local')
            expect(decision.candidates.find(item => item.model === 'cloud-a')?.excluded).toMatch(/Nicht-Owner/)
        }
    })

    it('requires proven capability: a vision task never picks a model without vision evidence', () => {
        // local-b: probe found no vision and no vision run succeeded on it.
        const decision = decideMultiRoute(owner('x', { signals: { content: 'Bild', hasImage: true } }), registry(), ON)
        expect(decision.candidates.find(item => item.model === 'local-b')?.excluded).toMatch(/Fähigkeit vision nicht belegt/)
        expect(decision.candidates.find(item => item.model === 'local-vision')?.excluded).toBeUndefined()
        // Even a measured-fast model is skipped for vision unless vision is proven.
        const measured = decideMultiRoute(owner('x', { signals: { content: 'Bild', hasImage: true } }),
            registry({ ledgerRuns: [...measure('local-b', NODE_B, 'general', 10, 10, 10)] as any }), ON)
        expect(measured.endpoint?.model).not.toBe('local-b')
    })

    it('Codex stays governed by R1–R8: no Codex for smalltalk or when codex is off', () => {
        const smalltalk = decideMultiRoute(owner('Hallo, wie geht es dir?', { codexEnabled: true }), registry({ ledgerRuns: [...measure('codex-test', undefined, 'smalltalk', 10, 10, 10)] as any }), ON)
        expect(smalltalk.target).toBe('local')
        expect(smalltalk.candidates.find(item => item.model === 'codex-test')?.excluded).toMatch(/Regeltabelle/)
    })
})

describe('multi-router stage B: measurement wins, else R1–R8', () => {
    const general = 'Erkläre mir bitte ausführlich, wie Gezeitenkräfte entstehen und warum es zwei Flutberge gibt, mit einem anschaulichen Beispiel für Kinder.'

    it('with measurements the better model wins (success rate > latency > cost)', () => {
        const runs = [...measure('local-a', NODE_A, 'general', 7, 10, 500), ...measure('local-b', NODE_B, 'general', 9, 10, 4000)]
        const decision = decideMultiRoute(owner(general), registry({ ledgerRuns: runs as any }), ON)
        expect(decision.basis).toBe('messung')
        expect(decision.endpoint?.model).toBe('local-b')
        expect(decision.reason).toMatch(/90 %/)
        // Equal success rate: lower latency decides.
        const tie = [...measure('local-a', NODE_A, 'general', 9, 10, 500), ...measure('local-b', NODE_B, 'general', 9, 10, 4000)]
        expect(decideMultiRoute(owner(general), registry({ ledgerRuns: tie as any }), ON).endpoint?.model).toBe('local-a')
    })

    it('ignores cells below the minimum sample count', () => {
        const runs = [...measure('local-b', NODE_B, 'general', 3, 3, 100)]
        const decision = decideMultiRoute(owner(general), registry({ ledgerRuns: runs as any }), ON)
        expect(decision.basis).toBe('regeln')
    })

    it('without measurements falls back to R1–R8 exactly', () => {
        const inputs: Array<[string, Partial<TaskModelDecisionInput>]> = [
            ['Hallo, wie geht es dir heute?', { codexEnabled: true, codexAvailable: true }],
            ['Schreib mir eine TypeScript-Funktion mit Unit-Tests.', { codexEnabled: true, codexAvailable: true }],
            ['Schreib mir eine TypeScript-Funktion mit Unit-Tests.', { codexEnabled: false }],
            ['Schreib ein Python-Skript, das die Kundendaten exportiert.', { codexEnabled: true }],
            ['Finde die Ursache für den Stacktrace im Build.', { codexEnabled: true, codexAvailable: false }],
            ['Schreib mir eine TypeScript-Funktion mit Unit-Tests.', { codexEnabled: true, permission: 'user' }],
        ]
        for (const [content, extra] of inputs) {
            const input = owner(content, extra)
            const base = decideTaskModel(input)
            const multi = decideMultiRoute(input, registry(), ON)
            expect(multi.basis).toBe('regeln')
            expect(multi.target).toBe(base.target)
            expect(multi.rule).toBe(base.rule)
        }
    })

    it('default off: decision identical to R1–R8, no candidates evaluated', () => {
        const input = owner('Schreib mir eine TypeScript-Funktion mit Unit-Tests.', { codexEnabled: true, codexAvailable: true })
        const runs = [...measure('local-a', NODE_A, 'code', 10, 10, 10)]
        const off = decideMultiRoute(input, registry({ ledgerRuns: runs as any }), readMultiRouteSettings({}))
        expect(off.basis).toBe('aus')
        expect(off.multi).toBe(false)
        expect(off.target).toBe('codex')
        expect(off.rule).toBe(decideTaskModel(input).rule)
        expect(off.candidates).toEqual([])
    })
})

describe('settings', () => {
    it('defaults to off with budget 0 € and only turns on with literal true', () => {
        expect(readMultiRouteSettings(undefined)).toMatchObject({ enabled: false, cloudDailyBudgetEur: 0 })
        expect(readMultiRouteSettings({ routing: { multi: { enabled: 'true' } } }).enabled).toBe(false)
        expect(readMultiRouteSettings({ routing: { multi: { enabled: true, cloudDailyBudgetEur: -5 } } })).toMatchObject({ enabled: true, cloudDailyBudgetEur: 0 })
        expect(readMultiRouteSettings({ routing: { multi: { enabled: true, cloudDailyBudgetEur: 2.5 } } }).cloudDailyBudgetEur).toBe(2.5)
    })
})

describe('nova-runner wiring', () => {
    const source = readFileSync(new URL('../agents/nova-runner.ts', import.meta.url), 'utf8')

    it('consults the multi-router only when routing.multi.enabled, and records candidates', () => {
        expect(source).toMatch(/readMultiRouteSettings\(/)
        expect(source).toMatch(/if \(multiSettings\.enabled && !modelOverride\?\.model\)/)
        expect(source).toMatch(/candidates: multiRoute\.candidates/)
    })

    it('wraps every cloud client in the cleaned-prompt guard', () => {
        expect(source).toMatch(/createCloudSafeClient\(/)
    })
})
