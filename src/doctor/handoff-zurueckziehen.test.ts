/**
 * 2.84.0 Punkt 7: Übergabe-Karte zurückziehen, wenn der Fall vorher gemessen
 * geschlossen ist; einen geschlossenen Fall nicht mehr an Claude senden.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDelegationService, type DelegationConfig, type FetchLike } from '../core/delegation.js'
import { trustEvidence } from '../core/action-policy.js'
import { doctorCaseVerifier, DOCTOR_HANDOFF_KIND, runClaudeHandoffTick } from './claude-handoff.js'
import { FailureResearchCoordinator, type FailureResearchCase } from './failure-research-coordinator.js'

const NOW = new Date('2026-10-02T08:00:00Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
const config: DelegationConfig = {
    enabled: true, url: 'http://agentic.example.com', fromAgent: 'NOVA', agents: { claude: 'CLAUDE', codex: 'CODEX', hermes: 'HERMES' },
    pollSeconds: 60, defaultFristMinutes: 1440, maxOpen: 20,
}

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-withdraw-')); dirs.push(dir)
    const doctor = new FailureResearchCoordinator(join(dir, 'failure-research.json'))
    const at = NOW.toISOString()
    const item = doctor.ingest({ id: 'fall-z', title: 'Wiederkehrender Fehler: web_search', detail: 'Timeout bei web_search', category: 'tools', severity: 'warning',
        source: 'bug-finder', status: 'open', recommendation: '', evidence: {}, createdAt: at, updatedAt: at })
    const posts: unknown[] = []
    const fetch: FetchLike = async (_url, init) => {
        if (init?.method === 'POST') posts.push(init.body)
        return { ok: true, status: 200, json: async () => ({ messages: [] }) }
    }
    const thoughts: any[] = []
    const service = createDelegationService({
        dataDir: dir, now: () => NOW.getTime(), config, fetch, addThought: () => undefined,
        createCard: () => ({ ok: true as const, card: { id: 'card-1' }, created: true }),
        authority: () => true, isWorker: () => false, verifiers: { 'doctor-fall': doctorCaseVerifier(() => doctor.list()) },
    })
    const delegate = vi.spyOn(service, 'delegate')
    const verified = () => doctor.list().map((entry): FailureResearchCase => ({ ...entry, investigation: { status: 'verified', runId: 'r1', attempts: 1, nextAttemptAt: 0, report: 'health_status: web_search 40 Fehler' } }))
    const outbox = join(dir, 'claude-handoff.json')
    const port = { add: (input: any) => { thoughts.push(input); return { thought: { id: `th-${thoughts.length}` } } }, setStatus: (id: string, status: string) => { thoughts.push({ id, status }) } }
    const tick = (delegation: any = service) => runClaudeHandoffTick({ cases: verified(), node: 'spark', version: '2.84.0', now: NOW, path: outbox, delegation, trust: { dataDir: dir }, thoughts: port })
    const records = () => JSON.parse(readFileSync(outbox, 'utf8')).records
    return { dir, doctor, item, service, delegate, posts, thoughts, tick, records }
}

describe('Übergabe zurückziehen (Punkt 7)', () => {
    it('wartende Delegation, Fall danach gemessen geschlossen → zurückgezogen, Karte nicht mehr offen, Record closed, Vertrauensleiter unverändert', async () => {
        const f = setup()
        await f.tick()
        const [delegation] = f.service.list()
        expect(delegation.status).toBe('wartet-auf-freigabe')
        const trustBefore = trustEvidence(DOCTOR_HANDOFF_KIND, { dataDir: f.dir })
        f.doctor.closeByMeasurement(f.item.id, 'messung:web_search:0-fehler:6-ok:seit-rollout', NOW)
        await f.tick()
        const after = f.service.get(delegation.id)!
        expect(after.status).toBe('zurueckgezogen')
        // isStillOpen der Delegationskarte: nur 'wartet-auf-freigabe' gilt als offen.
        expect(after.status === 'wartet-auf-freigabe').toBe(false)
        expect(f.service.list({ open: true })).toHaveLength(0)
        expect(f.records()[0]).toMatchObject({ state: 'closed', trustCounted: true, delegationId: delegation.id })
        expect(trustEvidence(DOCTOR_HANDOFF_KIND, { dataDir: f.dir })).toEqual(trustBefore)
        expect(f.thoughts.some(t => /Übergabe zurückgezogen: Fehler nicht mehr beobachtet/.test(t.title || ''))).toBe(true)
        expect(f.thoughts.some(t => t.status === 'erledigt')).toBe(true)
        // Ein spätes Ja schickt nichts mehr an Claude.
        expect((await f.service.approve(delegation.id, 'owner:1')).ok).toBe(false)
        expect(f.posts).toHaveLength(0)
        // Folgetakte: kein Neuversuch.
        await f.tick()
        expect(f.service.list()).toHaveLength(1)
        expect(f.delegate).toHaveBeenCalledTimes(1)
    })

    it('Record queued, Fall schon geschlossen, URL gesetzt → kein delegate-Aufruf', async () => {
        const f = setup()
        const offline = { config: { enabled: false, url: null }, delegate: vi.fn(), get: () => null }
        await f.tick(offline)
        expect(f.records()[0].state).toBe('queued')
        f.doctor.closeByMeasurement(f.item.id, 'messung:web_search:0-fehler:6-ok:7d', NOW)
        const result = await f.tick()
        expect(result.delegated).toBe(0)
        expect(f.delegate).not.toHaveBeenCalled()
        expect(f.records()[0]).toMatchObject({ state: 'closed', trustCounted: true })
    })

    it('Gegenprobe: bereits gesendet → kein Zurückziehen; Claudes Antwort wird wie bisher geprüft', async () => {
        const f = setup()
        await f.tick()
        const [delegation] = f.service.list()
        expect((await f.service.approve(delegation.id, 'owner:1')).ok).toBe(true)
        await f.tick()
        expect(f.records()[0].state).toBe('sent')
        f.doctor.closeByMeasurement(f.item.id, 'messung:web_search:0-fehler:6-ok:7d', NOW)
        await f.tick()
        expect(f.service.get(delegation.id)!.status).toBe('gesendet')
        expect(f.records()[0].state).toBe('sent')
    })

    it('withdraw nur aus wartet-auf-freigabe', async () => {
        const f = setup()
        await f.tick()
        const [delegation] = f.service.list()
        expect(f.service.withdraw(delegation.id, 'Fall gemessen geschlossen').ok).toBe(true)
        expect(f.service.withdraw(delegation.id, 'nochmal').ok).toBe(false)
        expect(f.service.get(delegation.id)!.fehler).toBe('Fall gemessen geschlossen')
    })
})
