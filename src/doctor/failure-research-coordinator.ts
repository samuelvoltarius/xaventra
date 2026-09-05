import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { DoctorFinding } from '../core/self-doctor.js'

export type ResearchStage = 'diagnosed' | 'researching' | 'repair-proposed' | 'sandbox-passed' | 'regression-passed' | 'rollback-passed' | 'awaiting-patch-gate' | 'approved' | 'resolved'
export interface FailureResearchCase {
    id: string; findingId: string; title: string; stage: ResearchStage; severity: string
    hypothesis: string; researchQueries: string[]; requiredEvidence: string[]; evidenceRefs: string[]
    patchGateRequired: boolean; updatedAt: string
}
interface ResearchFile { version: 1; updatedAt: string; cases: FailureResearchCase[] }

export class FailureResearchCoordinator {
    private cases: FailureResearchCase[] = []
    constructor(private readonly path = getNovaDataDir('self-doctor', 'failure-research.json')) {
        try { if (existsSync(path)) this.cases = (JSON.parse(readFileSync(path, 'utf8')) as ResearchFile).cases || [] } catch { this.cases = [] }
    }

    ingest(finding: DoctorFinding): FailureResearchCase {
        const id = createHash('sha256').update(finding.id).digest('hex').slice(0, 24)
        let item = this.cases.find(value => value.id === id)
        if (!item) {
            item = {
                id, findingId: finding.id, title: finding.title, stage: 'diagnosed', severity: finding.severity,
                hypothesis: finding.detail.slice(0, 500),
                researchQueries: [
                    `${finding.category} ${finding.title}`,
                    `${finding.source} ${finding.recommendation}`,
                ].map(value => value.replace(/\s+/g, ' ').trim().slice(0, 300)),
                requiredEvidence: ['source or documentation evidence', 'sandbox test', 'regression test', 'rollback test', 'PATCH_GATE approval'],
                evidenceRefs: [`doctor:${finding.id}`], patchGateRequired: true, updatedAt: new Date().toISOString(),
            }
            this.cases.push(item)
        } else {
            item.hypothesis = finding.detail.slice(0, 500)
            item.updatedAt = new Date().toISOString()
        }
        this.persist(); return structuredClone(item)
    }

    advance(id: string, target: ResearchStage, evidenceRef: string, options: { patchGateApproved?: boolean } = {}): FailureResearchCase | null {
        const item = this.cases.find(value => value.id === id)
        if (!item || !evidenceRef) return null
        const order: ResearchStage[] = ['diagnosed', 'researching', 'repair-proposed', 'sandbox-passed', 'regression-passed', 'rollback-passed', 'awaiting-patch-gate', 'approved', 'resolved']
        const current = order.indexOf(item.stage), next = order.indexOf(target)
        if (next !== current + 1) return null
        if (target === 'approved' && options.patchGateApproved !== true) return null
        item.stage = target
        item.evidenceRefs = [...new Set([...item.evidenceRefs, evidenceRef])].slice(-30)
        item.updatedAt = new Date().toISOString()
        this.persist(); return structuredClone(item)
    }

    list(): FailureResearchCase[] { return this.cases.map(item => structuredClone(item)) }
    private persist(): void { atomicWriteJsonSync(this.path, { version: 1, updatedAt: new Date().toISOString(), cases: this.cases.slice(-1_000) } satisfies ResearchFile) }
}

let singleton: FailureResearchCoordinator | null = null
export function getFailureResearchCoordinator(): FailureResearchCoordinator { return singleton ||= new FailureResearchCoordinator() }
export function setFailureResearchCoordinator(value: FailureResearchCoordinator): void { singleton = value }
