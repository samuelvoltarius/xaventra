import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor, type ApprovalCard } from './approval-cards.js'
import { createDelegationService, parseDelegationConfig } from './delegation.js'
import { createMissionCardExecutor, createMissionEngine, type Mission, type MissionEngine, type StepExecutor } from './missions.js'
import { createResponsibilityCardExecutor, createResponsibilityManager, type ResponsibilityManager, type ResponsibilitySignals } from './responsibilities.js'

// P9 Punkt 2: Delegation ist angebunden — Missions-Schritte und Aufträge
// übergeben an Claude/Codex/Hermes/Unteragent, „Mission wartet“ erinnert,
// und der Rückkanal fragt nur, solange etwas offen ist.

const OWNER = '111'

describe('P9 Delegation: Vorab-Freigabe statt zweiter Karte', () => {
    const URL_BASE = 'http://agentic.example.com:3301'
    function service(cards: unknown[]) {
        const posts: unknown[] = []
        const fetch = vi.fn(async (url: string, init: any = {}) => {
            if ((init.method || 'GET') === 'POST' && url === `${URL_BASE}/messages`) { posts.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ id: 'm1' }) } }
            return { ok: true, status: 200, json: async () => [] }
        })
        const svc = createDelegationService({
            dataDir: mkdtempSync(join(tmpdir(), 'p9-dlg-')), config: parseDelegationConfig({ delegation: { enabled: true, url: URL_BASE } }),
            fetch: fetch as any, authority: () => true, isWorker: () => false,
            createCard: input => { const card = { id: `k${cards.length + 1}`, ...input }; cards.push(card); return { ok: true, card, created: true } as any },
        })
        return { svc, posts }
    }

    it('ein ändernder Auftrag mit Owner-Freigabe geht ohne zweite Karte raus und trägt die Freigabe', async () => {
        const cards: unknown[] = []
        const { svc, posts } = service(cards)
        const result = await svc.delegate({ to: 'claude', auftrag: 'Behebe den hängenden REST-Dienst', erwartet: { art: 'mission-kriterium', text: 'm-1' }, aendert: true, freigabeVon: `telegram:${OWNER}` })
        expect(result.ok).toBe(true)
        expect(cards).toHaveLength(0)
        expect(posts).toHaveLength(1)
        const record = (result as any).record
        expect(record).toMatchObject({ stufe: 'L2', status: 'gesendet', freigabeVon: `telegram:${OWNER}` })
        expect(JSON.stringify(posts[0])).toContain(`Owner-Freigabe telegram:${OWNER}`)
    })

    it('Gegenprobe: ohne Freigabe entsteht wie bisher eine Karte und nichts wird gesendet', async () => {
        const cards: unknown[] = []
        const { svc, posts } = service(cards)
        const result = await svc.delegate({ to: 'claude', auftrag: 'Behebe den hängenden REST-Dienst', erwartet: { art: 'mission-kriterium', text: 'm-1' }, aendert: true })
        expect(result.ok).toBe(true)
        expect(cards).toHaveLength(1)
        expect(posts).toHaveLength(0)
        // an invalid approval label is ignored: card again, still nothing sent
        expect((await svc.delegate({ to: 'claude', auftrag: 'Behebe den Dienst Y', erwartet: { art: 'beschreibung', text: 'Dienst läuft' }, aendert: true, freigabeVon: 'nicht gültig!' })).ok).toBe(true)
        expect(cards).toHaveLength(2)
        expect(posts).toHaveLength(0)
    })
})

describe('P9 Delegation: Rückkanal fragt nur bei offenen Delegationen', () => {
    let release: (() => void) | null = null
    beforeEach(() => {
        vi.resetModules()
        process.env.NOVA_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'p9-dlg-runtime-'))
        vi.doMock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
        vi.doMock('../agents/subagent-orchestrator.js', () => ({
            spawnSubagent: vi.fn(() => new Promise(resolve => { release = () => resolve({ id: 's', status: 'completed', output: 'Analyse fertig', toolsUsed: [], durationMs: 1, mode: 'local' }) })),
        }))
    })
    afterEach(() => {
        delete process.env.NOVA_RUNTIME_ROOT
        vi.doUnmock('./autonomy-authority.js')
        vi.doUnmock('../agents/subagent-orchestrator.js')
        vi.useRealTimers()
    })

    it('ohne offene Delegation kein Timer; delegate() schaltet ihn ein, der leere Takt wieder aus', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
        const delegation = await import('./delegation.js')
        const started = await delegation.startDelegationRuntime({}, { nodeOnly: false })
        expect(started.started).toBe(true)
        expect(delegation.isDelegationPolling()).toBe(false)

        const result = await delegation.delegate({ to: 'subagent', auftrag: 'Analysiere die Logs von heute', erwartet: { art: 'beschreibung', text: 'Befund' } })
        expect(result.ok).toBe(true)
        expect(delegation.isDelegationPolling()).toBe(true)

        for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setImmediate(resolve))
        expect(release).toBeTypeOf('function')
        release!()
        await delegation.getDelegationService().settledSubagents()
        expect(delegation.getDelegationService().list({ open: true })).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(121_000)
        expect(delegation.isDelegationPolling()).toBe(false)
        delegation.stopDelegationRuntime()
    })

    it('ein Worker startet nichts', async () => {
        const delegation = await import('./delegation.js')
        expect((await delegation.startDelegationRuntime({}, { nodeOnly: true })).started).toBe(false)
        expect(delegation.armDelegationPolling()).toBe(false)
    })
})

describe('P9 Missionen delegieren einen Schritt', () => {
    let clock = Date.parse('2026-10-01T10:00:00Z')
    let dataDir: string
    let serviceUp: boolean
    let delegationAvailable: boolean
    let calls: Record<string, number>
    let waiting: Mission[]

    const signals = (): ResponsibilitySignals => ({
        now: clock,
        localNodeId: 'main-a',
        nodes: [{ nodeId: 'main-a', lastSeen: clock, profile: { version: '2.82.0', role: 'main', selfCheck: { status: 'ok', items: [] } } }],
        nightwatch: { finishedAt: new Date(clock).toISOString(), results: [{ id: 'rest', label: 'REST-API', host: 'main-a', status: serviceUp ? 'ok' : 'fehler', message: serviceUp ? 'ok' : 'hängt', severity: 'critical' }] },
        devices: [], release: null, ownerRequests: [],
        delegation: { available: delegationAvailable },
    } as ResponsibilitySignals)

    const executors = (): StepExecutor[] => [
        { kind: 'diagnose', async run() { calls.diagnose = (calls.diagnose || 0) + 1; return { ok: true, message: `Dienst ${serviceUp ? 'läuft' : 'hängt'}` } } },
        { kind: 'delegieren', async run(_step, _mission, ctx) { calls.delegieren = (calls.delegieren || 0) + 1; if (!ctx.approvedBy) throw new Error('ohne Freigabe'); return { ok: true, message: 'an claude übergeben', delegationId: 'dlg-aaaaaaaaaaaa' } } },
        { kind: 'dienst-neustart', async run() { calls['dienst-neustart'] = (calls['dienst-neustart'] || 0) + 1; return { ok: true, message: 'neu gestartet' } } },
    ]

    function build(): { responsibilities: ResponsibilityManager; engine: MissionEngine } {
        const ports = {
            thoughts: { add: () => undefined },
            cards: {
                create: (input: any) => createApprovalCard(input, { dataDir, now: () => clock, ledger: null }),
                status: (id: string) => listApprovalCards({ dataDir }).find(card => card.id === id)?.status,
            },
        }
        const responsibilities = createResponsibilityManager({ dataDir, now: () => clock, localNodeId: 'main-a', ports })
        const engine = createMissionEngine({
            dataDir, now: () => clock, localNodeId: 'main-a', isMain: () => true, responsibilities, signals, executors: executors(), ports,
            onWaiting: mission => { waiting.push(mission) },
        })
        unregisterCardExecutor('mission-schritt')
        registerCardExecutor(createMissionCardExecutor(() => engine))
        unregisterCardExecutor('verantwortung')
        registerCardExecutor(createResponsibilityCardExecutor(() => responsibilities))
        return { responsibilities, engine }
    }
    const press = (card: ApprovalCard, answer: 'ja' | 'nein') =>
        answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId: OWNER, ownerIds: [OWNER] }, { dataDir, now: () => clock, ledger: null })
    const cardOf = (kind: string) => listApprovalCards({ dataDir }).filter(card => card.aktion.kind === kind && card.status === 'offen').pop()!

    beforeEach(() => {
        clock = Date.parse('2026-10-01T10:00:00Z')
        dataDir = mkdtempSync(join(tmpdir(), 'p9-missions-'))
        serviceUp = true
        delegationAvailable = true
        calls = {}
        waiting = []
    })

    async function waitingForDelegation() {
        const built = build()
        built.responsibilities.sync(signals())
        await press(cardOf('verantwortung'), 'ja')
        expect(built.responsibilities.get('dienst-laeuft:rest@main-a')!.aktionen).toContain('delegieren')
        serviceUp = false
        built.engine.startForViolations(built.responsibilities.check(signals()))
        await built.engine.tick()
        const mission = built.engine.list()[0]
        expect(mission.status).toBe('wartet-auf-alfred')
        expect(mission.steps.find(step => step.id === mission.waitingStepId)!.kind).toBe('delegieren')
        // Auto-Erinnerung „Mission wartet“ bekommt die wartende Mission
        expect(waiting.map(item => item.id)).toEqual([mission.id])
        await press(cardOf('mission-schritt'), 'ja')
        const handed = built.engine.get(mission.id)!
        expect(handed.status).toBe('wartet-auf-delegation')
        expect(handed.steps.find(step => step.kind === 'delegieren')).toMatchObject({ status: 'wartet', delegationId: 'dlg-aaaaaaaaaaaa' })
        await built.engine.tick()
        expect(built.engine.get(mission.id)!.status).toBe('wartet-auf-delegation')
        expect(calls['dienst-neustart']).toBeUndefined()
        return { ...built, mission: handed }
    }

    it('nach Ja wartet die Mission auf die Delegation; ein verifiziertes Ergebnis schließt sie ab', async () => {
        const { engine, mission } = await waitingForDelegation()
        serviceUp = true
        const done = await engine.settleDelegation({ id: 'dlg-aaaaaaaaaaaa', missionId: mission.id, status: 'fertig', pruefung: { ergebnis: 'verifiziert', detail: 'Nachtwache ok' } }, { verified: true })
        expect(done!.status).toBe('abgeschlossen')
        expect(done!.steps.find(step => step.kind === 'delegieren')).toMatchObject({ status: 'erledigt' })
        expect(calls['dienst-neustart']).toBeUndefined()
    })

    it('Gegenprobe: ein nicht verifiziertes Ergebnis ist ein gescheiterter Versuch; fremde Delegationen ändern nichts', async () => {
        const { engine, mission } = await waitingForDelegation()
        expect((await engine.settleDelegation({ id: 'dlg-bbbbbbbbbbbb', missionId: mission.id, status: 'fertig' }, { verified: true }))!.status).toBe('wartet-auf-delegation')
        const failed = await engine.settleDelegation({ id: 'dlg-aaaaaaaaaaaa', missionId: mission.id, status: 'fertig', pruefung: { ergebnis: 'nicht-erfuellt', detail: 'hängt weiter' } }, { verified: false })
        expect(failed!.status).toBe('in-arbeit')
        expect(failed!.versuche).toBe(1)
    })

    it('ohne erreichbaren Agenten bleibt der alte Weg (kein Delegations-Schritt)', async () => {
        delegationAvailable = false
        const { responsibilities } = build()
        responsibilities.sync(signals())
        await press(cardOf('verantwortung'), 'ja')
        expect(responsibilities.get('dienst-laeuft:rest@main-a')!.aktionen).not.toContain('delegieren')
    })
})
