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
    manager = createResponsibilityManager({
        dataDir, now: () => NOW, localNodeId: 'main-a',
        ports: {
            thoughts: { add: input => { thoughts.push(input) } },
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

    it('derives "Dienst Y läuft" from Nachtwache checks; it needs L2 and stays a proposal until the owner presses Ja', async () => {
        manager.sync(signals({
            nightwatch: { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'rest', label: 'REST-API', host: 'main-a', status: 'ok', message: 'ok', severity: 'warning' }] },
        }))
        const service = manager.get('dienst-laeuft:rest@main-a')!
        expect(service).toMatchObject({ status: 'vorgeschlagen', maxLevel: 'L2', regel: 'dienst-laeuft' })
        expect(service.aktionen).toContain('dienst-neustart')
        expect(service.cardId).toBeTruthy()
        // not active, so a check never reports it
        expect(manager.check(signals()).map(item => item.responsibility.id)).not.toContain('dienst-laeuft:rest@main-a')

        const { listApprovalCards } = await import('./approval-cards.js')
        const card = listApprovalCards({ dataDir }).find(item => item.id === service.cardId)!
        expect(card).toMatchObject({ art: 'verantwortung', aktion: { kind: 'verantwortung', ref: 'dienst-laeuft:rest@main-a' } })
        expect(card.buttons.map(button => button.answer)).not.toContain('immer')
        const answer = await press(card, 'ja')
        expect(answer.ok).toBe(true)
        expect(manager.get('dienst-laeuft:rest@main-a')).toMatchObject({ status: 'aktiv', activatedBy: `telegram:${OWNER}` })
    })

    it('Nein rejects the proposal and it is not proposed again', async () => {
        const nightwatch = { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'rest', label: 'REST-API', host: 'main-a', status: 'ok' as const, message: 'ok', severity: 'warning' as const }] }
        manager.sync(signals({ nightwatch }))
        const { listApprovalCards } = await import('./approval-cards.js')
        const card = listApprovalCards({ dataDir }).find(item => item.aktion.kind === 'verantwortung')!
        await press(card, 'nein')
        expect(manager.get('dienst-laeuft:rest@main-a')!.status).toBe('abgelehnt')
        manager.sync(signals({ nightwatch }))
        expect(listApprovalCards({ dataDir }).filter(item => item.aktion.kind === 'verantwortung').length).toBe(1)
        expect(manager.get('dienst-laeuft:rest@main-a')!.status).toBe('abgelehnt')
    })

    it('a responsibility is never activated by sync alone when it carries an L2 action', () => {
        for (let i = 0; i < 3; i++) manager.sync(signals({
            nightwatch: { finishedAt: new Date(NOW).toISOString(), results: [{ id: 'db', label: 'Datenbank', host: 'worker-b', status: 'fehler', message: 'down', severity: 'critical' }] },
        }))
        expect(manager.get('dienst-laeuft:db@worker-b')!.status).toBe('vorgeschlagen')
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

    it('repeated owner requests of the same kind (>=3 in 14 days) become a proposal thought (ask), fewer do not', () => {
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
        expect(proposed[0]).toMatchObject({ status: 'vorgeschlagen', herkunft: 'selbst-abgeleitet' })
        expect(thoughts.some(item => item.permission === 'fragen' && String(item.title).includes('Drucker'))).toBe(true)
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
