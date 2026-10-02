import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDelegationService, type DelegationConfig, type FetchLike } from '../core/delegation.js'
import { isTrustEligible, isTrustPromoted, recordActionOutcome, trustEvidence, TRUST_AUTO_PROMOTE_AFTER } from '../core/action-policy.js'
import { cardDeliveryFor } from '../core/approval-cards.js'
import { doctorCaseVerifier, DOCTOR_HANDOFF_KIND, runClaudeHandoffTick } from './claude-handoff.js'
import { FailureResearchCoordinator, type FailureResearchCase } from './failure-research-coordinator.js'

// Punkt 2 (2.83.0): Doctor-Übergabe an Claude über den EINEN Delegationsweg.
const NOW = new Date('2026-10-02T08:00:00Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

const config: DelegationConfig = {
    enabled: true, url: 'http://agentic.example.com', fromAgent: 'NOVA', agents: { claude: 'CLAUDE', codex: 'CODEX', hermes: 'HERMES' },
    pollSeconds: 60, defaultFristMinutes: 1440, maxOpen: 20,
}

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-delegation-')); dirs.push(dir)
    const doctor = new FailureResearchCoordinator(join(dir, 'failure-research.json'))
    const at = NOW.toISOString()
    const ingest = (id: string) => doctor.ingest({ id, title: `Wiederkehrender Fehler: web_search ${id}`, detail: 'Timeout bei web_search', category: 'tools', severity: 'warning',
        source: 'bug-finder', status: 'open', recommendation: '', evidence: {}, createdAt: at, updatedAt: at })
    const posts: Array<{ url: string; body: any }> = []
    let inbox: unknown[] = []
    const fetch: FetchLike = async (url, init) => {
        if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200, json: async () => ({}) } }
        return { ok: true, status: 200, json: async () => ({ messages: inbox }) }
    }
    const cards: any[] = []
    const createCard = vi.fn((input: any) => { cards.push(input); return { ok: true as const, card: { id: `card-${cards.length}` }, created: true } })
    const service = createDelegationService({
        dataDir: dir, now: () => NOW.getTime(), config, fetch, createCard, addThought: () => undefined,
        authority: () => true, isWorker: () => false, verifiers: { 'doctor-fall': doctorCaseVerifier(() => doctor.list()) },
    })
    const verified = () => doctor.list().map((item): FailureResearchCase => ({ ...item, investigation: { status: 'verified', runId: 'r1', attempts: 1, nextAttemptAt: 0, report: 'health_status: web_search 40 Fehler' } }))
    const outbox = join(dir, 'claude-handoff.json')
    const tick = (version = '2.83.0') => runClaudeHandoffTick({ cases: verified(), node: 'spark', version, now: NOW, path: outbox, delegation: service, trust: { dataDir: dir } })
    const records = () => JSON.parse(readFileSync(outbox, 'utf8')).records
    return { dir, doctor, ingest, service, posts, cards, createCard, tick, records, setInbox: (value: unknown[]) => { inbox = value } }
}

describe('Doctor-Übergabe über die Delegation (Punkt 2)', () => {
    it('ein verifizierter Fall ergibt genau einen delegate-Aufruf mit erwartet.art doctor-fall, kein eigenes POST', async () => {
        const f = setup()
        const item = f.ingest('fall-a')
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        const result = await f.tick()
        expect(result).toMatchObject({ queued: 1, delegated: 1 })
        const [delegation] = f.service.list()
        expect(f.service.list()).toHaveLength(1)
        expect(delegation).toMatchObject({ to: 'claude', stufe: 'L2', status: 'wartet-auf-freigabe', erwartet: { art: 'doctor-fall' } })
        expect(delegation.erwartet.text).toContain(item.id)
        expect(delegation.freigabeVon).toBeUndefined()
        // L2 mit Karte; nicht zeitkritisch → im Bericht gesammelt.
        expect(f.cards).toHaveLength(1)
        expect(cardDeliveryFor({ wirkung: 'intern', ttlMs: 24 * 60 * 60_000, text: `${f.cards[0].art} ${f.cards[0].aktion.kind} ${f.cards[0].quelle} ${f.cards[0].titel} ${f.cards[0].beleg}` })).toBe('bericht')
        // Nichts geht ohne Ja raus — weder über die Delegation noch über ein eigenes POST.
        expect(f.posts).toHaveLength(0)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(f.records()[0]).toMatchObject({ caseId: item.id, delegationId: delegation.id, state: 'queued' })
        // Nächster Takt: keine zweite Delegation.
        expect((await f.tick()).delegated).toBe(0)
        expect(f.service.list()).toHaveLength(1)
    })

    it('nach dem Ja geht der Auftrag über die Delegation raus; Antwort „fertig“ bei gemessen geschlossenem Fall ist verifiziert', async () => {
        const f = setup()
        const item = f.ingest('fall-b')
        await f.tick()
        const [delegation] = f.service.list()
        expect((await f.service.approve(delegation.id, 'owner:1')).ok).toBe(true)
        expect(f.posts).toHaveLength(1)
        expect(f.posts[0].url).toBe('http://agentic.example.com/messages')
        expect(f.posts[0].body).toMatchObject({ to_agent: 'CLAUDE', thread_id: delegation.threadId, metadata: { kind: 'xaventra-delegation', erwartet: { art: 'doctor-fall' } } })
        expect(f.posts[0].body.content).toContain('Timeout bei web_search')
        await f.tick()
        expect(f.records()[0].state).toBe('sent')

        f.doctor.closeByMeasurement(item.id, 'messung:web_search:0-fehler:6-ok:7d', NOW)
        f.setInbox([{ id: 'm1', thread_id: delegation.threadId, from_agent: 'CLAUDE', to_agent: 'NOVA', content: 'Fix in v2.83.1', metadata: { status: 'fertig', beleg: 'v2.83.1' } }])
        expect((await f.service.poll()).applied).toBe(1)
        expect(f.service.get(delegation.id)?.pruefung?.ergebnis).toBe('verifiziert')
    })

    it('„fertig“, solange der Fall gemessen noch offen ist, bleibt unverifiziert', async () => {
        const f = setup()
        f.ingest('fall-c')
        await f.tick()
        const [delegation] = f.service.list()
        await f.service.approve(delegation.id, 'owner:1')
        f.setInbox([{ id: 'm1', thread_id: delegation.threadId, from_agent: 'CLAUDE', to_agent: 'NOVA', content: 'erledigt', metadata: { status: 'fertig' } }])
        await f.service.poll()
        expect(f.service.get(delegation.id)?.pruefung?.ergebnis).toBe('unverifiziert')
    })

    it('ohne Agentic-OS-URL arbeitet nur die Outbox, wie bisher', async () => {
        const f = setup()
        f.ingest('fall-d')
        const offline = createDelegationService({ dataDir: f.dir, config: { ...config, url: null }, authority: () => true, isWorker: () => false, createCard: f.createCard })
        const result = await runClaudeHandoffTick({ cases: f.doctor.list().map(c => ({ ...c, investigation: { status: 'verified' as const, runId: 'r', attempts: 1, nextAttemptAt: 0 } })), node: 'spark', version: '2.83.0', now: NOW, path: join(f.dir, 'outbox.json'), delegation: offline, trust: { dataDir: f.dir } })
        expect(result).toMatchObject({ queued: 1, delegated: 0 })
        expect(offline.list()).toHaveLength(0)
        expect(f.createCard).not.toHaveBeenCalled()
    })

    it('Owner-Ja mit gemessen geschlossenem Fall füttert die Vertrauensleiter; Nein setzt sie zurück', async () => {
        const f = setup()
        expect(isTrustEligible(DOCTOR_HANDOFF_KIND)).toBe(true)
        const item = f.ingest('fall-e')
        await f.tick()
        const [delegation] = f.service.list()
        await f.service.approve(delegation.id, 'owner:1')
        await f.tick()
        f.doctor.closeByMeasurement(item.id, 'messung:web_search:0-fehler:6-ok:7d', NOW)
        await f.tick('2.83.1')
        expect(f.records()[0].state).toBe('closed')
        expect(trustEvidence(DOCTOR_HANDOFF_KIND, { dataDir: f.dir }).successes).toBe(1)
        await f.tick('2.83.1')
        expect(trustEvidence(DOCTOR_HANDOFF_KIND, { dataDir: f.dir }).successes).toBe(1) // einmal je Übergabe

        f.ingest('fall-f')
        await f.tick('2.83.1')
        const second = f.service.list().find(entry => entry.id !== delegation.id)!
        await f.service.reject(second.id, 'owner:1')
        await f.tick('2.83.1')
        expect(f.records().find((r: any) => r.delegationId === second.id).state).toBe('declined')
        expect(JSON.parse(readFileSync(join(f.dir, 'action-policy', 'trust.json'), 'utf8')).kinds[DOCTOR_HANDOFF_KIND].confirmedYes).toBe(0)
        // Abgelehnt ist endgültig: kein neuer Auftrag für denselben Befund.
        await f.tick('2.83.1')
        expect(f.service.list()).toHaveLength(2)
    })

    it(`nach ${TRUST_AUTO_PROMOTE_AFTER}× Ja hochgestuft: der nächste Fall geht ohne Karte, ehrlich als Vertrauensleiter vermerkt`, async () => {
        const f = setup()
        for (let i = 0; i < TRUST_AUTO_PROMOTE_AFTER; i++) recordActionOutcome(DOCTOR_HANDOFF_KIND, { ok: true, approvedByOwner: true }, { dataDir: f.dir })
        expect(isTrustPromoted(DOCTOR_HANDOFF_KIND, { dataDir: f.dir })).toBe(true)
        f.ingest('fall-g')
        await f.tick()
        expect(f.cards).toHaveLength(0)
        expect(f.posts).toHaveLength(1)
        const [delegation] = f.service.list()
        expect(delegation.freigabeVon).toMatch(/^vertrauensleiter/)
        expect(f.posts[0].body.content).toContain('Vertrauensleiter')
        expect(f.posts[0].body.content).not.toContain('Owner-Freigabe vertrauensleiter')
    })
})
