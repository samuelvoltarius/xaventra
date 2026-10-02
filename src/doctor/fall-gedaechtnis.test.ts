/**
 * 2.86 Punkt 3: Fall-Gedächtnis. Ein gemessen geschlossener Doctor-Fall mit
 * verifizierter Diagnose legt sein Lösungswissen in der vorhandenen
 * Memory-Governance ab (kein neuer Speicher); eine neue Untersuchung sieht
 * frühere ähnliche Fälle; kehrt der Fehler zurück, wird das Wissen
 * `superseded`. Nur Fall-Metadaten, nie Anfragetexte.
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as coordinatorModule from './failure-research-coordinator.js'
import { FailureResearchCoordinator, type ResearchWorker, type ResearchWorkerInput } from './failure-research-coordinator.js'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import type { DoctorFinding } from '../core/self-doctor.js'
import { MemoryGovernanceCoordinator } from '../memory/memory-governance.js'

const governanceCaseMemory = (coordinatorModule as any).governanceCaseMemory as (governance: () => MemoryGovernanceCoordinator, version: () => string) => any

let serial = 0
function finding(subject: string, detail: string, status: 'open' | 'resolved' = 'open'): DoctorFinding {
    return {
        id: `bug-finder-${subject}`, title: `Wiederkehrender Fehler: ${subject}`, detail, category: 'tools', severity: 'warning', source: 'bug-finder',
        recommendation: 'lesend prüfen', evidence: { subject }, status, createdAt: '', updatedAt: '',
    }
}

function fixture() {
    const root = mkdtempSync(join(process.cwd(), 'fall-gedaechtnis-'))
    const governance = new MemoryGovernanceCoordinator(join(root, 'governance'))
    const caseMemory = governanceCaseMemory(() => governance, () => '2.86.0')
    const path = join(root, `research-${serial++}.json`)
    const coordinator = new (FailureResearchCoordinator as any)(path, { caseMemory }) as FailureResearchCoordinator
    const ledger = new OutcomeLedger(`${path}.ledger`)
    const goals: string[] = []
    const execute = vi.fn(async (input: ResearchWorkerInput) => {
        goals.push(input.contract.goal)
        ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
        ledger.recordTool(input.contract.id, { toolName: 'health_status', success: true, result: { success: true, output: 'Observed' } })
        ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: true, awaitingApproval: false, criteria: [], violations: [] })
        ledger.completeValidated(input.contract.id, { success: true })
        return { output: 'Ursache: Zeitlimit des Suchdienstes zu knapp (3 s); Abhilfe: Zeitlimit 10 s und ein Wiederholversuch.' }
    })
    const worker: ResearchWorker = { hasAuthority: () => true, getRun: id => ledger.getRun(id), execute }
    const solutions = () => governance.list({ scope: 'system:doctor' }).filter(record => record.predicate === 'fall_loesung')
    return { governance, coordinator, worker, goals, solutions, path, caseMemory }
}

describe('Punkt 3: gelöste Doctor-Fälle werden Wissen', () => {
    it('a verified case closed by measurement leaves exactly one fall-loesung entry (verified, local, without request text)', async () => {
        const f = fixture()
        const item = f.coordinator.ingest(finding('web_search', '5 Vorkommen in 7 Tagen. Fehlerbild: timeout für anfrage von max@example.com'))
        expect((await f.coordinator.investigateNext(f.worker, 1))?.investigation?.status).toBe('verified')
        expect(f.solutions()).toHaveLength(0)
        f.coordinator.closeByMeasurement(item.id, 'messung:web_search:0-fehler:12-ok:7d')
        const entries = f.solutions()
        expect(entries).toHaveLength(1)
        expect(['verified', 'canonical']).toContain(entries[0].status)
        expect(entries[0].subject).toBe(`fall:${item.id}`)
        expect(entries[0].value).toBe('web_search')
        expect(entries[0].content).toMatch(/Zeitlimit/)
        expect(entries[0].content).toMatch(/2\.86\.0/)
        expect(entries[0].content).toMatch(/messung:web_search/)
        expect(entries[0].content).not.toContain('max@example.com')
    })

    it('without a measurement reference (merge) the entry stays a candidate; without a verified diagnosis there is none', async () => {
        const f = fixture()
        const merged = f.coordinator.ingest(finding('mail_read', 'Fehlerbild: 401'))
        await f.coordinator.investigateNext(f.worker, 1)
        f.coordinator.closeByMeasurement(merged.id, 'zusammengefuehrt:validator-shape')
        expect(f.solutions().map(item => item.status)).toEqual(['candidate'])
        const unverified = f.coordinator.ingest(finding('kalender', 'Fehlerbild: leer'))
        f.coordinator.closeByMeasurement(unverified.id, 'messung:kalender:0-fehler:9-ok:7d')
        expect(f.solutions().filter(item => item.value === 'kalender')).toHaveLength(0)
    })

    it('a new investigation of the same subject sees earlier closed cases (untrusted, bounded)', async () => {
        const f = fixture()
        const old = f.coordinator.ingest(finding('web_search', 'Fehlerbild: timeout'))
        await f.coordinator.investigateNext(f.worker, 1)
        f.coordinator.closeByMeasurement(old.id, 'messung:web_search:0-fehler:12-ok:7d')
        const fresh = f.coordinator.ingest({ ...finding('web_search', 'Fehlerbild: HTTP 502 vom Suchdienst'), id: 'bug-finder-web_search-502' })
        expect(fresh.id).not.toBe(old.id)
        await f.coordinator.investigateNext(f.worker, 2_000_000)
        const goal = f.goals.at(-1)!
        expect(goal).toMatch(/Frühere Fälle/)
        expect(goal).toContain(old.id)
        expect(goal).toMatch(/untrusted/)
        // Other subjects do not leak in.
        const other = f.coordinator.ingest(finding('drucker_status', 'Fehlerbild: offline'))
        await f.coordinator.investigateNext(f.worker, 4_000_000)
        expect(f.goals.at(-1)).not.toContain(old.id)
        expect(other.id).toBeTruthy()
    })

    it('when the fault returns (case reopens), the solution entry is superseded', async () => {
        const f = fixture()
        const item = f.coordinator.ingest(finding('web_search', 'Fehlerbild: timeout'))
        await f.coordinator.investigateNext(f.worker, 1)
        f.coordinator.closeByMeasurement(item.id, 'messung:web_search:0-fehler:12-ok:7d')
        const [entry] = f.solutions()
        expect(entry.status).toBe('verified')
        f.coordinator.ingest(finding('web_search', 'Fehlerbild: timeout'))
        expect(f.governance.get(entry.id)?.status).toBe('superseded')
        const active = f.solutions().filter(record => record.status === 'verified' || record.status === 'canonical')
        expect(active).toHaveLength(1)
        expect(active[0].content).toMatch(/wieder aufgetreten/)
    })

    it('a broken memory port never breaks closing or investigating', async () => {
        const root = mkdtempSync(join(process.cwd(), 'fall-gedaechtnis-kaputt-'))
        const broken = { remember: () => { throw new Error('boom') }, supersede: () => { throw new Error('boom') }, similar: () => { throw new Error('boom') } }
        const coordinator = new (FailureResearchCoordinator as any)(join(root, 'r.json'), { caseMemory: broken }) as FailureResearchCoordinator
        const item = coordinator.ingest(finding('web_search', 'Fehlerbild: timeout'))
        const ledger = new OutcomeLedger(join(root, 'l'))
        const worker: ResearchWorker = {
            hasAuthority: () => true, getRun: id => ledger.getRun(id),
            execute: async input => {
                ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
                ledger.recordTool(input.contract.id, { toolName: 'health_status', success: true, result: { success: true } })
                ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: true, awaitingApproval: false, criteria: [], violations: [] })
                ledger.completeValidated(input.contract.id, { success: true })
                return { output: 'Diagnose' }
            },
        }
        expect((await coordinator.investigateNext(worker, 1))?.investigation?.status).toBe('verified')
        expect(coordinator.closeByMeasurement(item.id, 'messung:web_search:0-fehler:3-ok:7d')?.findingOpen).toBe(false)
        expect(coordinator.ingest(finding('web_search', 'Fehlerbild: timeout')).findingOpen).toBe(true)
    })
})
