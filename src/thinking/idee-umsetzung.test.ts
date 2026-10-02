/**
 * 2.86 Punkt 1: Ein Ja auf eine Idee startet einen echten Umsetzungsauftrag
 * mit eigenem Prüfer, der das Ziel nachmisst — nicht nur eine Untersuchung.
 *
 * - Mit Agentic-OS-URL: genau eine Delegation an Claude, `erwartet.art =
 *   'idee-ziel'`, `aendert: true`, das Ja ist die Freigabe (keine zweite Karte).
 * - Claude meldet fertig: verifiziert nur, wenn dieselbe Kennzahl das Ziel
 *   erreicht; sonst „wartet auf Messung“ (keine Warnung), Nachmessung 7 Tage
 *   nach der Umsetzung.
 * - Vertrauensleiter `idee-umsetzung`: 3 Ja mit gemessen erreichtem Ziel →
 *   Umsetzung ohne Karte; Nein bzw. verfehlt stufen zurück.
 * - Ohne URL: nur Untersuchung, ehrlich benannt, Ergebnis als Idee.
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const g = globalThis as any
g.__ideeInputs = null

vi.mock('./thinking-runtime.js', () => ({
    getThinkingSettings: () => ({ enabled: true, learning: { enabled: false } }),
    ensureIdeaImplementationWiring: async () => {
        const { wireIdeaImplementation } = await import('./idea-run.js')
        await wireIdeaImplementation({ inputs: () => (globalThis as any).__ideeInputs })
    },
}))

const { listThoughts } = await import('../planner/index.js')
const { configureDelegation, getDelegationService, stopDelegationRuntime } = await import('../core/delegation.js')
const { createThinkingThoughtSink, dispatchThoughtAnswer, _setThoughtActionPortsForTest } = await import('../core/thought-hub.js')
const ideaRun = await import('./idea-run.js')
const { listAcceptedIdeas, runIdeaRun } = ideaRun
const { parseThinkingSettings } = await import('./ports.js')
const { evaluateActionWithTrust } = await import('../core/action-policy.js')

const NIGHT = new Date(2026, 9, 2, 2, 30)
const IDLE = { measured: true, gpuUtilPercent: 2, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }
const dataDir = mkdtempSync(join(process.cwd(), 'idee-umsetzung-'))
const posts: any[] = []
let inbox: any[] = []
const delegationThoughts: any[] = []

function insights(tools: any[]) {
    return {
        generatedAt: NIGHT.getTime(), tracesAnalyzed: 400, periodDays: 7,
        overall: { avgTotalLatencyMs: 1000, avgLlmLatencyMs: 500, avgToolLatencyMs: 200, successRate: 0.95, avgToolCallsPerRequest: 1, avgSelfHealingRetries: 0 },
        tools: tools.map(item => ({ callCount: 20, avgLatencyMs: 300, p95LatencyMs: 600, errorRate: 0, avgResultSize: 100, cacheCandidates: 0, ...item })),
        models: [], slowestTools: [], mostFailingTools: [], cacheCandidates: [], recommendations: [],
    } as any
}

async function proposeIdea(tool: string) {
    const statePath = join(mkdtempSync(join(process.cwd(), 'idee-umsetzung-state-')), 's.json')
    const result = await runIdeaRun({
        settings: parseThinkingSettings({ enabled: true, ideas: { enabled: true } }),
        load: { async sample() { return IDLE } }, sink: createThinkingThoughtSink(),
        inputs: async () => ({ insights: insights([{ name: tool, errorRate: 0.4 }]) }), now: NIGHT, statePath,
    })
    expect(result.ideas.length).toBe(1)
    return listThoughts({ limit: 500 }).find(item => item.title === `Werkzeug ${tool} scheitert oft`)
}

function configure(url: string | null, spawn?: any) {
    configureDelegation({ delegation: { enabled: true, ...(url ? { url } : {}) } }, {
        dataDir, authority: () => true, isWorker: () => false,
        addThought: input => { delegationThoughts.push(input) },
        ...(spawn ? { spawnSubagent: spawn } : {}),
        fetch: async (target: string, init?: Record<string, unknown>) => {
            if (init?.method === 'POST') posts.push({ url: target, body: JSON.parse(String(init.body || '{}')) })
            return { ok: true, status: 200, json: async () => (init?.method === 'GET' ? { messages: inbox } : {}) }
        },
    })
}

/** Claude answers in the delegation thread (data only; Xaventra checks itself). */
async function claudeSaysDone(record: { id: string; threadId: string }) {
    inbox = [{ id: `m-${record.id}`, from_agent: 'CLAUDE', to_agent: 'NOVA', thread_id: record.threadId, content: 'umgesetzt', metadata: { status: 'fertig', beleg: 'v2.86.0' } }]
    await getDelegationService().poll()
    inbox = []
    return getDelegationService().get(record.id)!
}

async function measureLater(tool: string, errorRate: number) {
    const later = new Date(Date.now() + 30 * 24 * 60 * 60_000)
    later.setHours(14, 0, 0, 0)
    return runIdeaRun({
        settings: parseThinkingSettings({ enabled: true, ideas: { enabled: true } }),
        load: { async sample() { return IDLE } }, sink: { emit: async () => undefined } as any,
        inputs: async () => ({ insights: insights([{ name: tool, errorRate }]) }), now: later,
        recordMeasurement: () => undefined,
    })
}

configure('https://agentic.example.com')
afterAll(() => { stopDelegationRuntime(); _setThoughtActionPortsForTest(null) })

describe('Punkt 1: Ja auf eine Idee → Umsetzungsauftrag mit eigenem Prüfer', () => {
    it('Ja on „werkzeug-fehler:web_search" delegates exactly one implementation task (idee-ziel, aendert) — the Ja is the approval', async () => {
        const thought = (await proposeIdea('web_search'))!
        const before = getDelegationService().list({ limit: 100 }).length
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const records = getDelegationService().list({ limit: 100 })
        expect(records.length).toBe(before + 1)
        const record = records.find(item => result.message.includes(item.id))!
        expect(record.erwartet).toMatchObject({ art: 'idee-ziel', text: 'werkzeug-fehler:web_search' })
        expect(record.stufe).toBe('L2')
        expect(record.freigabeVon).toBe('owner:1001')
        expect(record.status).toBe('gesendet')
        expect(record.karteId).toBeUndefined()
        expect(posts.filter(item => item.body?.metadata?.delegationId === record.id)).toHaveLength(1)
        expect(listAcceptedIdeas()['werkzeug-fehler:web_search']).toMatchObject({ delegationId: record.id, freigabe: 'owner', wartetAufUmsetzung: true })
        expect(result.message).toMatch(/Umsetzungsauftrag an Claude/)
    })

    it('Claude „fertig“ + target reached by the same metric → verifiziert, no warning thought', async () => {
        const thought = (await proposeIdea('mail_read'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const record = getDelegationService().list({ limit: 100 }).find(item => result.message.includes(item.id))!
        g.__ideeInputs = { insights: insights([{ name: 'mail_read', errorRate: 0.05 }]) }
        const done = await claudeSaysDone(record)
        expect(done.status).toBe('fertig')
        expect(done.pruefung?.ergebnis).toBe('verifiziert')
        const mine = delegationThoughts.filter(item => String(item.signature || '').startsWith(`delegation:${record.id}`))
        expect(mine.some(item => item.severity === 'warning')).toBe(false)
        expect(mine.some(item => /erledigt \(geprüft\)/.test(item.title))).toBe(true)
    })

    it('Claude „fertig“ but not reached yet → unverifiziert „wartet auf Messung“ (info, no warning); the clock restarts at the delivery', async () => {
        const thought = (await proposeIdea('kalender_lesen'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const record = getDelegationService().list({ limit: 100 }).find(item => result.message.includes(item.id))!
        g.__ideeInputs = { insights: insights([{ name: 'kalender_lesen', errorRate: 0.4 }]) }
        const done = await claudeSaysDone(record)
        expect(done.pruefung?.ergebnis).toBe('unverifiziert')
        expect(done.pruefung?.detail).toMatch(/wartet auf Messung/)
        const mine = delegationThoughts.filter(item => String(item.signature || '').startsWith(`delegation:${record.id}`))
        expect(mine.some(item => item.severity === 'warning')).toBe(false)
        expect(mine.some(item => /wartet auf Messung/.test(item.title))).toBe(true)
        const entry = listAcceptedIdeas()['werkzeug-fehler:kalender_lesen']
        expect(entry.wartetAufUmsetzung).toBe(false)
        expect(Date.parse(entry.faelligAm) - Date.parse(entry.umgesetztAm!)).toBe(7 * 24 * 60 * 60_000)
    })

    it('while Claude has not finished, the 7-day re-measurement waits instead of measuring an unchanged state', async () => {
        const thought = (await proposeIdea('notiz_lesen'))!
        await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const later = new Date(Date.now() + 8 * 24 * 60 * 60_000)
        later.setHours(14, 0, 0, 0)
        const run = await runIdeaRun({
            settings: parseThinkingSettings({ enabled: true, ideas: { enabled: true } }),
            load: { async sample() { return IDLE } }, sink: { emit: async () => undefined } as any,
            inputs: async () => ({ insights: insights([{ name: 'notiz_lesen', errorRate: 0.4 }]) }), now: later, recordMeasurement: () => undefined,
        })
        expect((run.measured || []).some(item => item.key === 'werkzeug-fehler:notiz_lesen')).toBe(false)
        expect(listAcceptedIdeas()['werkzeug-fehler:notiz_lesen']).toBeTruthy()
    })
})

describe('Punkt 1: Vertrauensleiter idee-umsetzung', () => {
    it('3 owner Ja whose target was then measured reached → the next idea is implemented without a card; Nein resets', async () => {
        for (const tool of ['wetter_lesen', 'route_lesen', 'datei_lesen']) {
            const thought = (await proposeIdea(tool))!
            const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
            const record = getDelegationService().list({ limit: 100 }).find(item => result.message.includes(item.id))!
            g.__ideeInputs = { insights: insights([{ name: tool, errorRate: 0.05 }]) }
            expect((await claudeSaysDone(record)).pruefung?.ergebnis).toBe('verifiziert')
            const run = await measureLater(tool, 0.05)
            expect(run.measured?.find(item => item.key === `werkzeug-fehler:${tool}`)?.ergebnis).toBe('erreicht')
        }
        const verdict = evaluateActionWithTrust({ kind: 'idee-umsetzung', origin: 'code' })
        expect(verdict.trusted).toBe(true)

        const before = getDelegationService().list({ limit: 100 }).length
        await proposeIdea('suche_lokal')
        const thoughts = listThoughts({ limit: 500 })
        expect(thoughts.find(item => item.title === 'Werkzeug suche_lokal scheitert oft')).toBeUndefined()
        const auto = thoughts.find(item => item.title === 'Setze ich selbst um: Werkzeug suche_lokal scheitert oft')!
        expect(auto.permission).toBe('selbst')
        const records = getDelegationService().list({ limit: 100 })
        expect(records.length).toBe(before + 1)
        expect(records[0]).toMatchObject({ erwartet: { art: 'idee-ziel', text: 'werkzeug-fehler:suche_lokal' }, freigabeVon: 'vertrauensleiter:idee-umsetzung', status: 'gesendet' })

        // Nein on an idea resets the ladder.
        _setThoughtActionPortsForTest({ delegationUrl: () => null })
        const plain = (await proposeIdea('bild_lesen'))!
        expect(plain.permission).toBe('fragen')
        _setThoughtActionPortsForTest(null)
        await dispatchThoughtAnswer(plain.id, 'nein', { userId: '1001' })
        expect(evaluateActionWithTrust({ kind: 'idee-umsetzung', origin: 'code' }).trusted).toBeFalsy()
    })

    it('a measured „verfehlt“ after an implementation resets the ladder', async () => {
        const { recordActionOutcome } = await import('../core/action-policy.js')
        for (let i = 0; i < 3; i++) recordActionOutcome('idee-umsetzung', { ok: true, approvedByOwner: true })
        expect(evaluateActionWithTrust({ kind: 'idee-umsetzung', origin: 'code' }).trusted).toBe(true)
        _setThoughtActionPortsForTest({ delegationUrl: () => null })
        const thought = (await proposeIdea('karte_lesen'))!
        _setThoughtActionPortsForTest(null)
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
        const record = getDelegationService().list({ limit: 100 }).find(item => result.message.includes(item.id))!
        g.__ideeInputs = { insights: insights([{ name: 'karte_lesen', errorRate: 0.4 }]) }
        await claudeSaysDone(record)
        const run = await measureLater('karte_lesen', 0.4)
        expect(run.measured?.find(item => item.key === 'werkzeug-fehler:karte_lesen')?.ergebnis).toBe('verfehlt')
        expect(evaluateActionWithTrust({ kind: 'idee-umsetzung', origin: 'code' }).trusted).toBeFalsy()
    })
})

describe('Punkt 1: ohne Agentic-OS-URL nur Untersuchung, ehrlich benannt', () => {
    it('a local subagent investigates; the result is an idea in the report, not a warning', async () => {
        const spawn = vi.fn(async () => ({ status: 'completed', output: 'Ursache: Zeitlimit zu knapp' }))
        configure(null, spawn)
        try {
            const thought = (await proposeIdea('pdf_lesen'))!
            const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1001' })
            expect(result.message).toMatch(/keine Umsetzung/)
            const record = getDelegationService().list({ limit: 100 }).find(item => result.message.includes(item.id))!
            expect(record.to).toBe('subagent')
            expect(record.stufe).toBe('L1')
            await getDelegationService().settledSubagents()
            const mine = delegationThoughts.filter(item => String(item.signature || '').startsWith(`delegation:${record.id}`))
            expect(mine.some(item => item.severity === 'warning')).toBe(false)
            expect(mine.find(item => item.kind === 'idee')).toBeTruthy()
        } finally {
            configure('https://agentic.example.com')
        }
    })
})
