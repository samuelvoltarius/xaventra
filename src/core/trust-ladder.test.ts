import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    evaluateAction, evaluateActionWithTrust, isTrustEligible, isTrustPromoted, promotedKinds, recordActionOutcome, recordOwnerAnswer,
    resetTrust, TRUST_AUTO_PROMOTE_AFTER, trustChangesSince,
} from './action-policy.js'
import { answerApprovalCard, createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor, type ApprovalCard } from './approval-cards.js'
import { createMissionCardExecutor, createMissionEngine, type StepExecutor } from './missions.js'
import { createResponsibilityCardExecutor, createResponsibilityManager, type ResponsibilitySignals } from './responsibilities.js'
import { formatArbeit } from './responsibility-runtime.js'

// P8 Vertrauensleiter: 3 confirmed Ja of the same kind without rollback/failure
// promote it L2 → L1 (runs by itself); never for physical/outward/money/delete/
// infra-destroy/L3; a Nein or a failure takes it back.

let dataDir: string
let clock: number
const opts = () => ({ dataDir, now: () => clock })
const yes = (kind: string, n = 1) => { for (let i = 0; i < n; i++) recordActionOutcome(kind, { ok: true, approvedByOwner: true }, opts()) }

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'trust-ladder-'))
    clock = Date.parse('2026-10-01T10:00:00Z')
})

describe('Vertrauensleiter: Regeln', () => {
    it('3× Ja ohne Rückweg → L1 selbst; 2× reicht nicht', () => {
        expect(TRUST_AUTO_PROMOTE_AFTER).toBe(3)
        const request = { kind: 'dienst-neustart', origin: 'mission' }
        yes('dienst-neustart', 2)
        expect(isTrustPromoted('dienst-neustart', opts())).toBe(false)
        expect(evaluateActionWithTrust(request, opts())).toMatchObject({ level: 'L2', decision: 'ask' })
        yes('dienst-neustart')
        expect(isTrustPromoted('dienst-neustart', opts())).toBe(true)
        expect(evaluateActionWithTrust(request, opts())).toMatchObject({ level: 'L1', decision: 'auto', trusted: true })
        // the pure kernel is unchanged
        expect(evaluateAction(request)).toMatchObject({ level: 'L2', decision: 'ask' })
        // promotion is persisted (a fresh read sees it)
        expect(promotedKinds({ dataDir }).map(item => item.kind)).toEqual(['dienst-neustart'])
    })

    it('Ausführungen ohne Owner-Ja zählen nicht', () => {
        for (let i = 0; i < 5; i++) recordActionOutcome('config-aendern', { ok: true }, opts())
        expect(isTrustPromoted('config-aendern', opts())).toBe(false)
    })

    it('nie für physisch, extern, Geld, Löschen, infra-destroy, Release/Patch oder L3', () => {
        for (const kind of ['drucken', 'schalten', 'mail-senden', 'nachricht-senden', 'daten-loeschen', 'pve-entfernen', 'pve-rollback', 'vm-stoppen', 'release-ausrollen', 'patch-anwenden', 'firewall-aendern', 'kaufen-bestellen', 'unbekannte-art']) {
            yes(kind, 5)
            expect(isTrustEligible(kind), kind).toBe(false)
            expect(isTrustPromoted(kind, opts()), kind).toBe(false)
            const verdict = evaluateActionWithTrust({ kind, origin: 'mission' }, opts())
            expect(verdict.decision, kind).not.toBe('auto')
            expect(verdict.trusted, kind).toBeUndefined()
        }
        expect(promotedKinds({ dataDir })).toEqual([])
    })

    it('ein physischer/externer Effekt oder ein fremder Knoten hebelt die Hochstufung nicht aus', () => {
        yes('dienst-neustart', 3)
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'mission', effects: ['extern:senden'] }, opts()).decision).toBe('ask')
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'mission', effects: ['physisch:drucken'] }, opts()).decision).toBe('ask')
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'mission', node: 'ns2' }, { ...opts(), localNodeId: 'main-a' }).decision).toBe('ask')
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'mission', node: 'main-a' }, { ...opts(), localNodeId: 'main-a' }).decision).toBe('auto')
    })

    it('ein Nein setzt zurück und nimmt die Hochstufung zurück', () => {
        yes('install-katalog', 3)
        expect(isTrustPromoted('install-katalog', opts())).toBe(true)
        clock += 60_000
        recordOwnerAnswer('install-katalog', 'nein', opts())
        expect(isTrustPromoted('install-katalog', opts())).toBe(false)
        yes('install-katalog', 2)
        expect(isTrustPromoted('install-katalog', opts())).toBe(false)
        yes('install-katalog')
        expect(isTrustPromoted('install-katalog', opts())).toBe(true)
    })

    it('ein Fehlschlag oder Rückweg setzt zurück', () => {
        yes('modell-wechseln', 3)
        recordActionOutcome('modell-wechseln', { ok: false }, opts())
        expect(isTrustPromoted('modell-wechseln', opts())).toBe(false)
        yes('modell-wechseln', 2)
        recordActionOutcome('modell-wechseln', { ok: true, rolledBack: true, approvedByOwner: true }, opts())
        yes('modell-wechseln', 2)
        expect(isTrustPromoted('modell-wechseln', opts())).toBe(false)
    })

    it('„das wieder fragen“ (resetTrust) nimmt die Hochstufung zurück; Abendbericht-Quelle meldet beides', () => {
        const since = clock
        yes('config-aendern', 3)
        expect(trustChangesSince(since, clock + 1, { dataDir }).promoted.map(item => item.kind)).toEqual(['config-aendern'])
        clock += 60_000
        expect(resetTrust('config-aendern', { dataDir, now: () => clock })).toEqual({ kind: 'config-aendern', wasPromoted: true })
        expect(isTrustPromoted('config-aendern', opts())).toBe(false)
        const changes = trustChangesSince(since, clock + 1, { dataDir })
        expect(changes.promoted).toEqual([])
        expect(changes.reset).toEqual([{ kind: 'config-aendern', at: new Date(clock).toISOString(), reason: 'Owner: wieder fragen' }])
    })

    it('/arbeit zeigt hochgestufte Arten', () => {
        yes('dienst-neustart', 3)
        const text = formatArbeit([], [], { promoted: promotedKinds({ dataDir }) })
        expect(text).toContain('Vertrauensleiter: selbst statt fragen (1)')
        expect(text).toContain('dienst-neustart')
        expect(text).toContain('/arbeit fragen dienst-neustart')
    })
})

describe('Vertrauensleiter in Missionen (Karten-Antworten)', () => {
    const OWNER = '111'
    let up = true
    let runs: Array<{ approvedBy?: string; trustedBy?: string }> = []
    const signals = (): ResponsibilitySignals => ({
        now: clock, localNodeId: 'main-a',
        nodes: [{ nodeId: 'main-a', lastSeen: clock, profile: { version: '2.82.0', role: 'main', selfCheck: { status: 'ok', items: [] } } }],
        nightwatch: { finishedAt: new Date(clock).toISOString(), results: [{ id: 'rest', label: 'REST-API', host: 'main-a', status: up ? 'ok' : 'fehler', message: up ? 'ok' : 'hängt', severity: 'critical' }] },
        devices: [], release: null, ownerRequests: [],
    } as any)
    const executors: StepExecutor[] = [
        { kind: 'diagnose', async run() { return { ok: true, message: 'gemessen' } } },
        { kind: 'dienst-neustart', async run(_s, _m, ctx) { runs.push({ approvedBy: ctx.approvedBy, trustedBy: ctx.trustedBy }); if (!ctx.approvedBy && !ctx.trustedBy) throw new Error('ohne Freigabe'); up = true; return { ok: true, message: 'neu gestartet' } } },
    ]
    function build() {
        const ports = {
            thoughts: { add: () => undefined },
            cards: { create: (input: any) => createApprovalCard(input, { dataDir, now: () => clock, ledger: null }), status: (id: string) => listApprovalCards({ dataDir }).find(card => card.id === id)?.status },
        }
        const responsibilities = createResponsibilityManager({ dataDir, now: () => clock, localNodeId: 'main-a', ports })
        const engine = createMissionEngine({ dataDir, now: () => clock, localNodeId: 'main-a', isMain: () => true, responsibilities, signals, executors, ports })
        unregisterCardExecutor('mission-schritt'); registerCardExecutor(createMissionCardExecutor(() => engine))
        unregisterCardExecutor('verantwortung'); registerCardExecutor(createResponsibilityCardExecutor(() => responsibilities))
        return { responsibilities, engine }
    }
    const open = (kind: string) => listApprovalCards({ dataDir }).filter(card => card.aktion.kind === kind && card.status === 'offen').pop()
    const press = (card: ApprovalCard, answer: 'ja' | 'nein') =>
        answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId: OWNER, ownerIds: [OWNER] }, { dataDir, now: () => clock, ledger: null })

    async function outage(engine: ReturnType<typeof build>['engine'], responsibilities: ReturnType<typeof build>['responsibilities']) {
        up = false
        clock += 60 * 60_000
        engine.startForViolations(responsibilities.check(signals()))
        await engine.tick()
    }

    it('nach 3× Ja startet die 4. Mission den Dienst selbst neu (ohne Karte); ein Nein holt die Karte zurück', async () => {
        runs = []
        const { responsibilities, engine } = build()
        responsibilities.sync(signals())
        expect(open('verantwortung')).toBeFalsy() // 2.84: no activation card
        for (let i = 0; i < 3; i++) {
            await outage(engine, responsibilities)
            const card = open('mission-schritt')
            expect(card, `Karte ${i + 1}`).toBeTruthy()
            await press(card!, 'ja')
            expect(engine.list().every(mission => mission.status === 'abgeschlossen')).toBe(true)
        }
        expect(isTrustPromoted('dienst-neustart', { dataDir })).toBe(true)
        await outage(engine, responsibilities)
        expect(open('mission-schritt')).toBeUndefined()
        expect(runs.at(-1)).toEqual({ approvedBy: undefined, trustedBy: 'vertrauensleiter:dienst-neustart' })
        expect(engine.list().every(mission => mission.status === 'abgeschlossen')).toBe(true)

        // Owner nimmt es zurück → wieder eine Karte; Nein darauf setzt die Serie auf 0.
        resetTrust('dienst-neustart', { dataDir })
        await outage(engine, responsibilities)
        const card = open('mission-schritt')
        expect(card).toBeTruthy()
        await press(card!, 'nein')
        expect(isTrustPromoted('dienst-neustart', { dataDir })).toBe(false)
    })
})
