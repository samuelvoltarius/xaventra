/**
 * 2.83.0 Punkt 3: „Ja" auf einen Denk-Vorschlag löst echte Arbeit aus — über
 * die vorhandenen Wege (Delegation, Werkzeug-Schmiede, vllm-wechsel-Karte).
 * Keine Antwort verspricht etwas, das nicht passiert.
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../thinking/thinking-runtime.js', () => ({ getThinkingSettings: () => ({ enabled: true, learning: { enabled: false } }) }))

const { listThoughts } = await import('../planner/index.js')
const { configureDelegation, getDelegationService, stopDelegationRuntime } = await import('./delegation.js')
const { createThinkingThoughtSink, dispatchThoughtAnswer, _setThoughtActionPortsForTest } = await import('./thought-hub.js')
const { listAcceptedIdeas, runIdeaRun } = await import('../thinking/idea-run.js')
const { parseThinkingSettings } = await import('../thinking/ports.js')

const NIGHT = new Date(2026, 9, 2, 2, 30)
const IDLE = { measured: true, gpuUtilPercent: 2, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }
const posts: Array<{ url: string; body: any }> = []
const dataDir = mkdtempSync(join(process.cwd(), 'idee-ja-'))

function insights(tools: any[]) {
    return {
        generatedAt: NIGHT.getTime(), tracesAnalyzed: 400, periodDays: 7,
        overall: { avgTotalLatencyMs: 1000, avgLlmLatencyMs: 500, avgToolLatencyMs: 200, successRate: 0.95, avgToolCallsPerRequest: 1, avgSelfHealingRetries: 0 },
        tools: tools.map(item => ({ callCount: 20, avgLatencyMs: 300, p95LatencyMs: 600, errorRate: 0, avgResultSize: 100, cacheCandidates: 0, ...item })),
        models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
    } as any
}

async function ideaThought(tool: Record<string, unknown>, title: string) {
    const statePath = join(mkdtempSync(join(process.cwd(), 'idee-ja-state-')), 's.json')
    const result = await runIdeaRun({
        settings: parseThinkingSettings({ enabled: true, ideas: { enabled: true } }),
        load: { async sample() { return IDLE } }, sink: createThinkingThoughtSink(),
        inputs: async () => ({ insights: insights([tool]) }), now: NIGHT, statePath,
    })
    expect(result.ideas.length).toBe(1)
    return listThoughts({ limit: 500 }).find(item => item.title.includes(title))!
}

configureDelegation({ delegation: { enabled: true, url: 'https://agentic.example.com' } }, {
    dataDir, authority: () => true, isWorker: () => false,
    fetch: async (url: string, init?: Record<string, unknown>) => { posts.push({ url, body: JSON.parse(String(init?.body || '{}')) }); return { ok: true, status: 200, json: async () => ({}) } },
})
afterAll(() => { stopDelegationRuntime(); _setThoughtActionPortsForTest(null) })

describe('Punkt 3: Ja auf eine Idee übergibt die Untersuchung (Delegation, L1)', () => {
    it('Ja on „werkzeug-fehler:web_search" delegates exactly once, read-only (L1), and names the delegation id', async () => {
        const thought = await ideaThought({ name: 'web_search', errorRate: 0.4 }, 'web_search scheitert')
        const before = getDelegationService().list({ limit: 50 }).length
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const records = getDelegationService().list({ limit: 50 })
        expect(records.length).toBe(before + 1)
        const record = records.find(item => result.message.includes(item.id))!
        expect(record).toBeTruthy()
        expect(record.stufe).toBe('L1')
        expect(record.to).toBe('claude')
        expect(record.erwartet.art).toBe('beschreibung')
        expect(record.kontext).toContain('web_search')
        expect(posts.filter(item => item.body?.metadata?.delegationId === record.id)).toHaveLength(1)
        expect(result.ok).toBe(true)
        expect(result.message).not.toMatch(/setze die Idee als Vorschlag um/)
    })

    it('Ja also notes the idea as accepted with numbers and a due date for the re-measurement (ideas-state.json)', async () => {
        const thought = await ideaThought({ name: 'web_fetch', avgLatencyMs: 8000, p95LatencyMs: 9000 }, 'web_fetch ist langsam')
        await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const entry = listAcceptedIdeas()['werkzeug-langsam:web_fetch']
        expect(entry).toMatchObject({ regel: 'werkzeug-langsam', subjekt: 'web_fetch', vorher: 8000, ziel: 4000 })
        expect(Date.parse(entry.faelligAm) - Date.parse(entry.angenommenAm)).toBe(7 * 24 * 60 * 60_000)
    })

    it('Nein delegates nothing', async () => {
        const thought = await ideaThought({ name: 'mail_read', errorRate: 0.5 }, 'mail_read scheitert')
        const before = getDelegationService().list({ limit: 50 }).length
        const result = await dispatchThoughtAnswer(thought.id, 'nein', { userId: '1001' })
        expect(getDelegationService().list({ limit: 50 }).length).toBe(before)
        expect(result.message).toMatch(/Verworfen/)
    })

    it('a forge tool as subject builds a new version through the forge (reviseTool), no delegation', async () => {
        const revise = vi.fn(async () => ({ proposal: null, message: 'neue Version v2' }))
        _setThoughtActionPortsForTest({ forge: { find: (ref: string) => ref === 'forge_wetter' ? { id: 'sp-1', name: 'wetter' } : null, canBuild: () => true, revise } })
        const thought = await ideaThought({ name: 'forge_wetter', errorRate: 0.5 }, 'forge_wetter scheitert')
        const before = getDelegationService().list({ limit: 50 }).length
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        expect(revise).toHaveBeenCalledTimes(1)
        expect((revise.mock.calls[0] as unknown[])[0]).toBe('sp-1')
        expect(String((revise.mock.calls[0] as unknown[])[1])).toContain('errorRate')
        expect(getDelegationService().list({ limit: 50 }).length).toBe(before)
        expect(result.message).toMatch(/forge_wetter/)
        _setThoughtActionPortsForTest(null)
    })

    it('without a forge model the forge subject falls back to the investigation (delegation), never a silent promise', async () => {
        const revise = vi.fn(async () => ({ proposal: null, message: 'x' }))
        _setThoughtActionPortsForTest({ forge: { find: () => ({ id: 'sp-2', name: 'kalender' }), canBuild: () => false, revise } })
        const thought = await ideaThought({ name: 'forge_kalender', errorRate: 0.5 }, 'forge_kalender scheitert')
        const before = getDelegationService().list({ limit: 50 }).length
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        expect(revise).not.toHaveBeenCalled()
        expect(getDelegationService().list({ limit: 50 }).length).toBe(before + 1)
        expect(result.message).toMatch(/kein lokales Lern-Modell/)
        _setThoughtActionPortsForTest(null)
    })

    it('2.84.0: over the shared daily build limit the answer says „morgen“ and the active version stays', async () => {
        const revise = vi.fn(async () => ({ proposal: null, message: 'Tageslimit' }))
        _setThoughtActionPortsForTest({ forge: { find: () => ({ id: 'sp-3', name: 'notiz' }), canBuild: () => true, revise, buildsLeftToday: () => 0 } })
        const thought = await ideaThought({ name: 'forge_notiz', errorRate: 0.5 }, 'forge_notiz scheitert')
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        expect(revise).toHaveBeenCalledTimes(1)
        expect(result.message).toMatch(/Tageslimit.*morgen.*aktive Version bleibt/)
        _setThoughtActionPortsForTest(null)
    })
})

describe('Punkt 3: Ja auf den Modell-Scout erzeugt die vorhandene vllm-wechsel-Karte (eigenes Ja)', () => {
    it('Ja creates a vllm-wechsel plan + card through the existing path; the switch itself does not run', async () => {
        const { planVllmSwitch, readVllmPlans } = await import('../routing/local-model-control.js')
        const { listApprovalCards } = await import('./approval-cards.js')
        const cardsDir = mkdtempSync(join(process.cwd(), 'idee-ja-cards-'))
        const propose = vi.fn(async (input: { targetModel: string; grund: string }) => planVllmSwitch({ node: 'spark', taskClass: 'general', currentModel: 'flash', targetModel: input.targetModel, evidence: input.grund }, { dataDir: cardsDir }))
        _setThoughtActionPortsForTest({ proposeModelSwitch: propose as any })
        await createThinkingThoughtSink().emit({
            id: 'scout-1', createdAt: NIGHT.toISOString(), source: 'modell-scout', kind: 'modell-wechsel', title: 'Neues Modell coder war 20 % besser',
            text: 'coder war 20 % besser als flash', evidence: [{ metric: 'Trefferquote coder', value: 90, unit: '%', source: 'Scout-Prüfsatz' }],
            importance: 0.7, proposal: { action: 'modell-wechsel', params: { modell: 'coder', von: 'flash' }, autoExecute: false },
            stufe: 'fragen', status: 'neu', dedupeKey: 'modell-wechsel:coder',
        } as any)
        const thought = listThoughts({ limit: 500 }).find(item => item.title.includes('Neues Modell coder'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        expect(propose).toHaveBeenCalledTimes(1)
        const plans = readVllmPlans({ dataDir: cardsDir })
        expect(plans).toHaveLength(1)
        expect(plans[0]).toMatchObject({ targetModel: 'coder', status: 'geplant' })
        const card = listApprovalCards({ status: 'offen', dataDir: cardsDir }).find(item => item.aktion.ref === plans[0].id)!
        expect(card.aktion.kind).toBe('vllm-wechsel')
        expect(result.ok).toBe(true)
        expect(result.message).toContain(plans[0].id)
        expect(result.message).toMatch(/Wechselkarte/)
        _setThoughtActionPortsForTest(null)
    })

    it('a refused plan is reported honestly (nothing promised)', async () => {
        _setThoughtActionPortsForTest({ proposeModelSwitch: async () => ({ ok: false, reason: 'Host-Agent nicht eingerichtet' }) as any })
        await createThinkingThoughtSink().emit({
            id: 'scout-2', createdAt: NIGHT.toISOString(), source: 'modell-scout', kind: 'modell-wechsel', title: 'Neues Modell flash2 war 30 % besser',
            text: 'x', evidence: [], importance: 0.7, proposal: { action: 'modell-wechsel', params: { modell: 'flash2', von: 'flash' }, autoExecute: false },
            stufe: 'fragen', status: 'neu', dedupeKey: 'modell-wechsel:flash2',
        } as any)
        const thought = listThoughts({ limit: 500 }).find(item => item.title.includes('flash2'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/Kein Wechselplan.*Host-Agent/)
        _setThoughtActionPortsForTest(null)
    })
})
