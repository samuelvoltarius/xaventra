import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaLearningDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

export interface LearnedRegressionCase {
    id: string; userId: string; taskType: string; failureClass: string; redactedRequest: string
    sourceRunIds: string[]; occurrences: number; status: 'quarantined' | 'promoted' | 'resolved'; updatedAt: string
}
interface RegressionFile { version: 1; updatedAt: string; cases: LearnedRegressionCase[] }

export class RegressionCaseStore {
    private cases: LearnedRegressionCase[] = []
    constructor(private readonly path = getNovaLearningDir('regression-cases.json')) {
        try { if (existsSync(path)) this.cases = (JSON.parse(readFileSync(path, 'utf8')) as RegressionFile).cases || [] } catch { this.cases = [] }
    }
    record(input: { userId: string; taskType: string; request: string; runId: string; failureClass: string }): LearnedRegressionCase {
        const redactedRequest = redactSecrets(input.request).replace(/\s+/g, ' ').trim().slice(0, 500)
        const id = createHash('sha256').update(`${input.userId}\0${input.taskType}\0${input.failureClass}\0${redactedRequest}`).digest('hex').slice(0, 24)
        let item = this.cases.find(value => value.id === id)
        if (!item) {
            item = { id, userId: input.userId, taskType: input.taskType, failureClass: input.failureClass, redactedRequest, sourceRunIds: [], occurrences: 0, status: 'quarantined', updatedAt: new Date().toISOString() }
            this.cases.push(item)
        }
        item.occurrences++; item.sourceRunIds = [...new Set([...item.sourceRunIds, input.runId])].slice(-20); item.updatedAt = new Date().toISOString()
        this.persist(); return structuredClone(item)
    }
    list(userId?: string) { return this.cases.filter(item => !userId || item.userId === userId).map(item => structuredClone(item)) }
    promote(id: string, evidenceRef: string): LearnedRegressionCase | null {
        const item = this.cases.find(value => value.id === id)
        if (!item || item.status !== 'quarantined' || !evidenceRef.startsWith('test:')) return null
        item.status = 'promoted'; item.updatedAt = new Date().toISOString(); this.persist(); return structuredClone(item)
    }
    resolve(id: string, evidenceRef: string): LearnedRegressionCase | null {
        const item = this.cases.find(value => value.id === id)
        if (!item || item.status !== 'promoted' || !evidenceRef.startsWith('benchmark:')) return null
        item.status = 'resolved'; item.updatedAt = new Date().toISOString(); this.persist(); return structuredClone(item)
    }
    toTestSpec(id: string) {
        const item = this.cases.find(value => value.id === id)
        return item ? { id: item.id, title: `${item.taskType}: ${item.failureClass}`, prompt: item.redactedRequest, expected: 'validated outcome without the recorded failure class', isolated: true } : null
    }
    private persist() { atomicWriteJsonSync(this.path, { version: 1, updatedAt: new Date().toISOString(), cases: this.cases.slice(-2_000) } satisfies RegressionFile) }
}
let singleton: RegressionCaseStore | null = null
export function getRegressionCaseStore(): RegressionCaseStore { return singleton ||= new RegressionCaseStore() }
export function setRegressionCaseStore(value: RegressionCaseStore): void { singleton = value }
