import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, listApprovalCards, maintainApprovalCards, registerCardExecutor, unregisterCardExecutor, type ApprovalCard } from './approval-cards.js'
import { createMissionCardExecutor, createMissionEngine, type MissionEngine, type StepExecutor } from './missions.js'
import { createResponsibilityCardExecutor, createResponsibilityManager, type ResponsibilityManager, type ResponsibilitySignals } from './responsibilities.js'

// Phase 6b: missions run inside the action policy and continue exactly where
// they waited after Alfred's "Ja". Gegenproben: see branch report.

const OWNER = '111'
let clock = Date.parse('2026-10-01T10:00:00Z')
let dataDir: string
let thoughts: Array<Record<string, any>>
let state: { disk: 'ok' | 'crit'; serviceUp: boolean; healWorks: boolean }
let calls: Record<string, number>
let isMain: boolean

function signals(): ResponsibilitySignals {
    return {
        now: clock,
        localNodeId: 'main-a',
        nodes: [{ nodeId: 'main-a', lastSeen: clock, profile: { version: '2.81.0', role: 'main', selfCheck: { status: state.disk, items: state.disk === 'crit' ? [{ id: 'disk', label: 'Platte', status: 'crit', detail: '97 %' }] : [] } } }],
        nightwatch: { finishedAt: new Date(clock).toISOString(), results: [{ id: 'rest', label: 'REST-API', host: 'main-a', status: state.serviceUp ? 'ok' : 'fehler', message: state.serviceUp ? 'ok' : 'hängt', severity: 'critical' }] },
        devices: [], release: null, ownerRequests: [],
    }
}

const count = (kind: string) => { calls[kind] = (calls[kind] || 0) + 1 }
function executors(): StepExecutor[] {
    return [
        { kind: 'diagnose', async run() { count('diagnose'); return { ok: true, message: `Platte ${state.disk}, Dienst ${state.serviceUp ? 'läuft' : 'hängt'}` } } },
        { kind: 'self-heal-zyklus', async run() { count('self-heal-zyklus'); if (state.healWorks) state.disk = 'ok'; return { ok: state.healWorks, message: state.healWorks ? 'Caches geleert' : 'nichts geholfen' } } },
        { kind: 'dienst-neustart', async run(_step, _mission, ctx) { count('dienst-neustart'); if (!ctx.approvedBy) throw new Error('ohne Freigabe'); state.serviceUp = true; return { ok: true, message: 'neu gestartet' } } },
    ]
}

function build(stepExecutors: StepExecutor[] = executors()): { responsibilities: ResponsibilityManager; engine: MissionEngine } {
    const ports = {
        thoughts: { add: (input: any) => { thoughts.push(input) } },
        cards: {
            create: (input: any) => createApprovalCard(input, { dataDir, now: () => clock, ledger: null }),
            status: (id: string) => listApprovalCards({ dataDir }).find(card => card.id === id)?.status,
        },
    }
    const responsibilities = createResponsibilityManager({ dataDir, now: () => clock, localNodeId: 'main-a', ports })
    const engine = createMissionEngine({
        dataDir, now: () => clock, localNodeId: 'main-a', isMain: () => isMain, responsibilities, signals, executors: stepExecutors, ports,
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
    dataDir = mkdtempSync(join(tmpdir(), 'missions-'))
    thoughts = []
    calls = {}
    isMain = true
    state = { disk: 'ok', serviceUp: true, healWorks: true }
})

async function activateService(responsibilities: ResponsibilityManager) {
    responsibilities.sync(signals())
    await press(cardOf('verantwortung'), 'ja')
    expect(responsibilities.get('dienst-laeuft:rest@main-a')!.status).toBe('aktiv')
}

describe('missions from violated responsibilities', () => {
    it('a violated criterion creates a mission with a contract', async () => {
        const { responsibilities, engine } = build()
        responsibilities.sync(signals())
        state.disk = 'crit'
        const created = engine.startForViolations(responsibilities.check(signals()))
        expect(created).toHaveLength(1)
        const mission = created[0]
        expect(mission).toMatchObject({ responsibilityId: 'knoten-gesund:main-a', status: 'geplant', versuche: 0, maxVersuche: 3 })
        expect(mission.vertrag.doneWhen.length).toBeGreaterThan(0)
        expect(mission.vertrag.darf).toContain('L1')
        expect(mission.vertrag.fragenBei).toContain('L2')
        expect(mission.vertrag.nie).toContain('L3')
        expect(mission.budget.maxKosten).toBe(0)
        expect(mission.steps.map(step => step.kind)).toEqual(['diagnose', 'self-heal-zyklus'])
        // one open mission per responsibility
        expect(engine.startForViolations(responsibilities.check(signals()))).toHaveLength(0)
    })

    it('an L1 step runs automatically and the mission completes when the criterion is met', async () => {
        const { responsibilities, engine } = build()
        responsibilities.sync(signals())
        state.disk = 'crit'
        engine.startForViolations(responsibilities.check(signals()))
        await engine.tick()
        expect(calls['self-heal-zyklus']).toBe(1)
        const mission = engine.list()[0]
        expect(mission.status).toBe('abgeschlossen')
        expect(listApprovalCards({ dataDir }).filter(card => card.aktion.kind === 'mission-schritt')).toHaveLength(0)
        expect(thoughts.some(item => String(item.title).includes('Erledigt'))).toBe(true)
    })

    it('an L2 step creates a card and waits; nothing runs before Ja', async () => {
        const { responsibilities, engine } = build()
        await activateService(responsibilities)
        state.serviceUp = false
        engine.startForViolations(responsibilities.check(signals()))
        await engine.tick()
        const mission = engine.list()[0]
        expect(mission.status).toBe('wartet-auf-alfred')
        expect(calls['dienst-neustart']).toBeUndefined()
        const card = cardOf('mission-schritt')
        expect(card).toMatchObject({ art: 'mission-schritt', aktion: { ref: `${mission.id}:${mission.waitingStepId}` } })
        expect(card.buttons.map(button => button.answer)).not.toContain('immer')
        await engine.tick()
        expect(calls['dienst-neustart']).toBeUndefined()
        expect(listApprovalCards({ dataDir }).filter(item => item.aktion.kind === 'mission-schritt')).toHaveLength(1)
    })

    it('after Ja exactly this step runs and the mission continues — also across a restart', async () => {
        const first = build()
        await activateService(first.responsibilities)
        state.serviceUp = false
        first.engine.startForViolations(first.responsibilities.check(signals()))
        await first.engine.tick()
        expect(calls['diagnose']).toBe(1)
        const waiting = first.engine.list()[0]

        // restart: new manager + engine on the same data dir
        const second = build()
        expect(second.engine.get(waiting.id)!.status).toBe('wartet-auf-alfred')
        const result = await press(cardOf('mission-schritt'), 'ja')
        expect(result.ok).toBe(true)
        expect(calls['dienst-neustart']).toBe(1)
        expect(calls['diagnose']).toBe(1) // earlier step not repeated
        const done = second.engine.get(waiting.id)!
        expect(done.status).toBe('abgeschlossen')
        expect(done.steps.find(step => step.kind === 'dienst-neustart')).toMatchObject({ status: 'erledigt', approvedBy: `telegram:${OWNER}` })
        // a second press is refused by the card store, nothing runs twice
        await second.engine.tick()
        expect(calls['dienst-neustart']).toBe(1)
    })

    it('Nein blocks the mission with a handoff text', async () => {
        const { responsibilities, engine } = build()
        await activateService(responsibilities)
        state.serviceUp = false
        engine.startForViolations(responsibilities.check(signals()))
        await engine.tick()
        await press(cardOf('mission-schritt'), 'nein')
        const mission = engine.list()[0]
        expect(mission.status).toBe('blockiert')
        expect(mission.handoff).toMatch(/bis hier gekommen: .*Diagnose/)
        expect(mission.handoff).toMatch(/brauche dich für: .*Dienst neu starten/)
        expect(calls['dienst-neustart']).toBeUndefined()
        expect(thoughts.some(item => String(item.evidence || '').includes('brauche dich für'))).toBe(true)
    })

    it('an expired card blocks the mission; nothing runs and a late press is refused', async () => {
        const { responsibilities, engine } = build()
        await activateService(responsibilities)
        state.serviceUp = false
        engine.startForViolations(responsibilities.check(signals()))
        await engine.tick()
        const card = cardOf('mission-schritt')
        clock += 25 * 60 * 60_000
        maintainApprovalCards({ dataDir, now: () => clock })
        await engine.tick()
        const mission = engine.list()[0]
        expect(mission.status).toBe('blockiert')
        expect(mission.handoff).toContain('abgelaufen')
        const late = await press(card, 'ja')
        expect(late.ok).toBe(false)
        expect(calls['dienst-neustart']).toBeUndefined()
    })

    it('a step without a registered executor is a handoff before any card (no free command path)', async () => {
        const { responsibilities, engine } = build(executors().filter(item => item.kind !== 'dienst-neustart'))
        await activateService(responsibilities)
        state.serviceUp = false
        engine.startForViolations(responsibilities.check(signals()))
        await engine.tick()
        const mission = engine.list()[0]
        expect(mission.status).toBe('blockiert')
        expect(mission.handoff).toContain('kein registrierter Ausführungsweg')
        expect(listApprovalCards({ dataDir }).filter(card => card.aktion.kind === 'mission-schritt')).toHaveLength(0)
    })

    it('at most 3 attempts, with a diagnosis between attempts', async () => {
        const { responsibilities, engine } = build()
        responsibilities.sync(signals())
        state.disk = 'crit'
        state.healWorks = false
        engine.startForViolations(responsibilities.check(signals()))
        for (let i = 0; i < 6; i++) { clock += 60_000; await engine.tick() }
        const mission = engine.list()[0]
        expect(mission.status).toBe('fehlgeschlagen')
        expect(mission.versuche).toBe(3)
        expect(calls['self-heal-zyklus']).toBe(3)
        expect(calls['diagnose']).toBe(3)
        expect(mission.diagnosen.length).toBeGreaterThanOrEqual(3)
        expect(mission.handoff).toContain('brauche dich für')
    })

    it('a worker does nothing: no mission, no step, no approval', async () => {
        const { responsibilities, engine } = build()
        responsibilities.sync(signals())
        state.disk = 'crit'
        isMain = false
        expect(engine.startForViolations(responsibilities.check(signals()))).toHaveLength(0)
        expect((await engine.tick()).active).toBe(false)
        isMain = true
        engine.startForViolations(responsibilities.check(signals()))
        isMain = false
        await engine.tick()
        expect(calls).toEqual({})
        const mission = engine.list()[0]
        expect((await engine.approveStep(mission.id, 's1', { decidedBy: 'telegram:111' })).ok).toBe(false)
    })

    it('an L3 step never runs and never becomes a card; a missing executor is a handoff, not a free path', async () => {
        const { responsibilities, engine } = build()
        responsibilities.sync(signals())
        state.disk = 'crit'
        const [mission] = engine.startForViolations(responsibilities.check(signals()))
        // inject a dangerous step into the persisted plan (as a broken producer would)
        engine._replaceStepsForTest(mission.id, [{ id: 's1', kind: 'daten-loeschen', titel: 'Platz schaffen', status: 'offen', runs: 0 }])
        await engine.tick()
        expect(engine.get(mission.id)).toMatchObject({ status: 'blockiert' })
        expect(engine.get(mission.id)!.handoff).toContain('Nie-Liste')
        expect(listApprovalCards({ dataDir }).filter(card => card.aktion.kind === 'mission-schritt')).toHaveLength(0)

        const [second] = (() => { state.disk = 'crit'; clock += 25 * 60 * 60_000; return engine.startForViolations(responsibilities.check(signals())) })()
        engine._replaceStepsForTest(second.id, [{ id: 's1', kind: 'endpoint-umschalten', titel: 'umschalten', status: 'offen', runs: 0 }])
        await engine.tick()
        expect(engine.get(second.id)!.status).toBe('blockiert')
        expect(engine.get(second.id)!.handoff).toMatch(/nicht im Vertrag|kein registrierter Ausführungsweg/)
    })
})
