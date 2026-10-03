import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, registerCardExecutor, unregisterCardExecutor, type ApprovalCard } from './approval-cards.js'
import {
    createResponsibilityCardExecutor, createResponsibilityManager, deriveResponsibilities, measureCriterion,
    type ResponsibilityManager, type ResponsibilitySignals,
} from './responsibilities.js'

// Phase 6b: responsibilities are derived by fixed rules (no model decides).
// Gegenproben: see branch report.

const OWNER = '111'
const NOW = Date.parse('2026-10-01T10:00:00Z')
let dataDir: string
let thoughts: Array<Record<string, any>>
let manager: ResponsibilityManager
let retired: string[]

function signals(overrides: Partial<ResponsibilitySignals> = {}): ResponsibilitySignals {
    return {
        now: NOW,
        localNodeId: 'main-a',
        nodes: [
            { nodeId: 'main-a', lastSeen: NOW, profile: { version: '2.81.0', role: 'main', selfCheck: { status: 'ok', items: [] } } },
        ],
        nightwatch: null,
        devices: [],
        release: null,
        ownerRequests: [],
        ...overrides,
    }
}

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'responsibilities-'))
    thoughts = []
    retired = []
    manager = createResponsibilityManager({
        dataDir, now: () => NOW, localNodeId: 'main-a',
        ports: {
            thoughts: { add: input => { thoughts.push(input) }, retireProposal: signature => { retired.push(signature) } },
            cards: { create: input => createApprovalCard(input, { dataDir, now: () => NOW, ledger: null }) },
        },
    })
    unregisterCardExecutor('verantwortung')
    registerCardExecutor(createResponsibilityCardExecutor(() => manager))
})

const press = (card: ApprovalCard, answer: 'ja' | 'nein') =>
    answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId: OWNER, ownerIds: [OWNER] }, { dataDir, now: () => NOW, ledger: null })

describe('self-derived responsibilities (fixed rules)', () => {
    it('derives "Knoten X gesund halten" from every node profile and activates it on its own (L0/L1 only)', () => {
        const result = manager.sync(signals({
            nodes: [
                { nodeId: 'main-a', lastSeen: NOW, profile: { version: '2.81.0', role: 'main', selfCheck: { status: 'ok', items: [] } } },
                { nodeId: 'worker-b', lastSeen: NOW, profile: { version: '2.81.0', role: 'worker', selfCheck: { status: 'warn', items: [] } } },
            ],
        }))
        const ids = manager.list().map(item => item.id)
        expect(ids).toEqual(expect.arrayContaining(['knoten-gesund:main-a', 'knoten-gesund:worker-b']))
        const local = manager.get('knoten-gesund:main-a')!
        expect(local).toMatchObject({ status: 'aktiv', herkunft: 'selbst-abgeleitet', regel: 'knoten-gesund', scope: ['main-a'] })
        expect(local.aktionen).toEqual(expect.arrayContaining(['diagnose', 'self-heal-zyklus']))
        expect(['L0', 'L1']).toContain(local.maxLevel)
        expect(manager.get('knoten-gesund:worker-b')!.aktionen).not.toContain('self-heal-zyklus')
        expect(result.aktiviert.length).toBe(2)
        expect(thoughts.some(item => String(item.title).startsWith('Ich kümmere mich ab jetzt um') && item.permission === 'selbst')).toBe(true)
    })

    it('derives "Dienst Y läuft" from Nachtwache checks and takes it over without a Ja (2.84); the L2 restart still asks per step', async () => {
        manager.sync(signals({
            nightwatch: { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'rest', label: 'REST-API', host: 'main-a', status: 'ok', message: 'ok', severity: 'warning' }] },
        }))
        const service = manager.get('dienst-laeuft:rest@main-a')!
        expect(service).toMatchObject({ status: 'aktiv', maxLevel: 'L2', regel: 'dienst-laeuft', activatedBy: 'regel:selbst-abgeleitet' })
        expect(service.aktionen).toContain('dienst-neustart')
        expect(service.cardId).toBeUndefined()
        const { listApprovalCards } = await import('./approval-cards.js')
        expect(listApprovalCards({ dataDir }).filter(item => item.aktion.kind === 'verantwortung')).toHaveLength(0)
        const thought = thoughts.find(item => item.signature === 'verantwortung:aktiv:dienst-laeuft:rest@main-a')!
        expect(thought).toMatchObject({ permission: 'selbst', kind: 'ereignis' })
        expect(String(thought.evidence)).toContain('L2-Schritte frage ich einzeln per Knopf')
        expect(String(thought.evidence)).not.toMatch(/Darf selbst: [^(]*dienst-neustart/)
        // Gegenprobe: the restart itself stays L2 for the mission (own card per step).
        const { evaluateAction } = await import('./action-policy.js')
        expect(evaluateAction({ kind: 'dienst-neustart', origin: 'verantwortung', node: 'main-a' }, { localNodeId: 'main-a' }).level).toBe('L2')
        expect(manager.check(signals()).map(item => item.responsibility.id)).toContain('dienst-laeuft:rest@main-a')
    })

    it('Nachtwache host "local" is shown as the own node id in title and scope; the id stays stable', () => {
        manager.sync(signals({
            nightwatch: { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'disk-root', label: 'Platte Spark', host: 'local', status: 'ok', message: 'ok', severity: 'warning' }] },
        }))
        const item = manager.get('dienst-laeuft:disk-root@local')!
        expect(item.titel).toBe('Platte Spark auf main-a läuft')
        expect(item.scope).toEqual(['main-a'])
        expect(item.kriterien[0].ref).toBe('disk-root@local')
        expect(manager.check(signals({
            nightwatch: { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'disk-root', label: 'Platte Spark', host: 'local', status: 'fehler', message: 'voll', severity: 'warning' }] },
        }))[0]).toBeDefined()
    })

    it('a proposal left by an older version is taken over on sync and its card closes; abgelehnt stays abgelehnt', async () => {
        const { atomicWriteJsonSync } = await import('./atomic-storage.js')
        const { listApprovalCards, maintainApprovalCards } = await import('./approval-cards.js')
        const card = createApprovalCard({ art: 'verantwortung', titel: 'Soll ich mich um „Platte Spark auf local läuft“ kümmern?', beleg: 'b', vorschlag: 'v', aktion: { kind: 'verantwortung', ref: 'dienst-laeuft:disk-root@local' }, dedupeKey: 'verantwortung:dienst-laeuft:disk-root@local', quelle: 'verantwortung', node: 'local', ablaufMs: 86_400_000 }, { dataDir, now: () => NOW, ledger: null })
        expect(card.ok).toBe(true)
        const base = { ziel: 'Nachtwache-Prüfung ist grün', aktionen: ['diagnose', 'dienst-neustart', 'melden'], maxLevel: 'L2', herkunft: 'selbst-abgeleitet', regel: 'dienst-laeuft', beleg: 'b', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }
        atomicWriteJsonSync(join(dataDir, 'responsibilities', 'responsibilities.json'), { version: 1, items: [
            { ...base, id: 'dienst-laeuft:disk-root@local', titel: 'Platte Spark auf local läuft', kriterien: [{ id: 'nachtwache', typ: 'nachtwache-pruefung', ref: 'disk-root@local', text: 'x' }], scope: ['local'], status: 'vorgeschlagen', cardId: card.ok ? card.card.id : undefined },
            { ...base, id: 'dienst-laeuft:vllm@local', titel: 'vLLM auf local läuft', kriterien: [{ id: 'nachtwache', typ: 'nachtwache-pruefung', ref: 'vllm@local', text: 'x' }], scope: ['local'], status: 'abgelehnt' },
        ] })
        const nightwatch = { finishedAt: new Date(NOW).toISOString(), results: [
            { id: 'disk-root', label: 'Platte Spark', host: 'local', status: 'ok' as const, message: 'ok' },
            { id: 'vllm', label: 'vLLM', host: 'local', status: 'ok' as const, message: 'ok' },
        ] }
        const result = manager.sync(signals({ nightwatch }))
        expect(result.aktiviert.map(item => item.id).filter(id => id.startsWith('dienst-laeuft'))).toEqual(['dienst-laeuft:disk-root@local'])
        expect(manager.get('dienst-laeuft:disk-root@local')).toMatchObject({ status: 'aktiv', titel: 'Platte Spark auf main-a läuft', scope: ['main-a'] })
        expect(manager.get('dienst-laeuft:vllm@local')!.status).toBe('abgelehnt')
        expect(retired).toContain('verantwortung:vorschlag:dienst-laeuft:disk-root@local')
        expect(retired).toContain('verantwortung:vorschlag:dienst-laeuft:vllm@local')
        maintainApprovalCards({ dataDir, now: () => NOW })
        expect(listApprovalCards({ dataDir }).find(item => card.ok && item.id === card.card.id)!.status).toBe('erledigt')
        // idempotent: a second sync announces nothing again
        retired = []
        expect(manager.sync(signals({ nightwatch })).aktiviert).toHaveLength(0)
        expect(retired).toContain('verantwortung:vorschlag:dienst-laeuft:disk-root@local')
    })

    it('derives device and release responsibilities', () => {
        manager.sync(signals({
            devices: [{ id: 'moonraker-printer-1', name: 'Voron', type: 'moonraker', status: 'eingerichtet', ok: true }, { id: 'x-2', name: 'Fremd', type: 'octoprint', status: 'gefunden', ok: null }],
            release: { version: '2.82.0' },
        }))
        expect(manager.get('geraet:moonraker-printer-1')).toMatchObject({ status: 'aktiv', regel: 'geraet-ueberwachen' })
        expect(manager.get('geraet:x-2')).toBeNull()
        expect(manager.get('release-aktuell')).toMatchObject({ status: 'aktiv', regel: 'release-aktuell' })
    })

    it('repeated owner requests of the same kind (>=3 in 14 days) are taken over on their own (only diagnose/melden), fewer do not', () => {
        const day = 24 * 60 * 60_000
        manager.sync(signals({ ownerRequests: [{ at: NOW - day, text: 'Wie steht der Drucker?' }, { at: NOW - 2 * day, text: 'drucker status bitte' }] }))
        expect(manager.list().filter(item => item.regel === 'wiederholte-anfrage')).toHaveLength(0)
        manager.sync(signals({ ownerRequests: [
            { at: NOW - day, text: 'Wie steht der Drucker?' }, { at: NOW - 2 * day, text: 'drucker status bitte' },
            { at: NOW - 20 * day, text: 'Drucker?' },
        ] }))
        expect(manager.list().filter(item => item.regel === 'wiederholte-anfrage')).toHaveLength(0)
        manager.sync(signals({ ownerRequests: [
            { at: NOW - day, text: 'Wie steht der Drucker?' }, { at: NOW - 2 * day, text: 'drucker status bitte' }, { at: NOW - 3 * day, text: 'Ist der Druck fertig?' },
        ] }))
        const proposed = manager.list().filter(item => item.regel === 'wiederholte-anfrage')
        expect(proposed).toHaveLength(1)
        expect(proposed[0]).toMatchObject({ status: 'aktiv', herkunft: 'selbst-abgeleitet', maxLevel: 'L0' })
        expect(thoughts.some(item => item.permission === 'selbst' && String(item.title).includes('Drucker'))).toBe(true)
        expect(thoughts.some(item => item.permission === 'fragen')).toBe(false)
    })

    it('rules are deterministic and never include an L3 action', () => {
        const input = signals({
            nightwatch: { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'rest', label: 'REST', host: 'main-a', status: 'ok', message: 'ok', severity: 'warning' }] },
            release: { version: '2.82.0' },
        })
        const first = deriveResponsibilities(input)
        expect(deriveResponsibilities(input)).toEqual(first)
        for (const candidate of first) expect(candidate.aktionen.join(' ')).not.toMatch(/loesch|firewall|ssh|sudo|migration|nas-neustart/)
    })
})

describe('criteria are measured from existing measurements', () => {
    it('node self-check crit -> violated; ok/warn -> fulfilled; missing -> unknown', () => {
        const base = signals()
        const crit = signals({ nodes: [{ nodeId: 'main-a', lastSeen: NOW, profile: { version: '2.81.0', role: 'main', selfCheck: { status: 'crit', items: [{ id: 'disk', label: 'Platte', status: 'crit', detail: '97 %' }] } } }] })
        const criterion = { id: 'k1', typ: 'knoten-selbstpruefung' as const, ref: 'main-a', text: 'Selbstprüfung nicht kritisch' }
        expect(measureCriterion(criterion, base).erfuellt).toBe(true)
        expect(measureCriterion(criterion, crit)).toMatchObject({ erfuellt: false })
        expect(measureCriterion(criterion, crit).befund).toContain('Platte')
        expect(measureCriterion({ ...criterion, ref: 'gibts-nicht' }, base).erfuellt).toBeNull()
    })

    it('check() reports violated active responsibilities', () => {
        manager.sync(signals())
        const crit = signals({ nodes: [{ nodeId: 'main-a', lastSeen: NOW, profile: { version: '2.81.0', role: 'main', selfCheck: { status: 'crit', items: [] } } }] })
        const outcome = manager.check(crit).find(item => item.responsibility.id === 'knoten-gesund:main-a')!
        expect(outcome.erfuellt).toBe(false)
        expect(manager.get('knoten-gesund:main-a')!.lastCheck).toMatchObject({ erfuellt: false })
    })

    it('a paused responsibility is not checked', () => {
        manager.sync(signals())
        manager.setPaused('knoten-gesund:main-a', true, 'owner:111')
        expect(manager.check(signals()).map(item => item.responsibility.id)).not.toContain('knoten-gesund:main-a')
    })
})
