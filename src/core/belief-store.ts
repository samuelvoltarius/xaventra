import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

export interface BeliefEvidence { id: string; source: string; summary: string; verifiedAt: string; supports: boolean; confidence: number; expiresAt?: string }
export interface NovaBelief {
    id: string; userId: string; subject: string; predicate: string; value: string
    confidence: number; status: 'supported' | 'uncertain' | 'disputed' | 'expired'
    evidence: BeliefEvidence[]; counterEvidence: BeliefEvidence[]; updatedAt: string
}
interface BeliefFile { version: 1; updatedAt: string; beliefs: NovaBelief[] }

export class BeliefStore {
    private beliefs: NovaBelief[] = []
    constructor(private readonly path = getNovaDataDir('beliefs.json')) {
        try { if (existsSync(path)) this.beliefs = (JSON.parse(readFileSync(path, 'utf8')) as BeliefFile).beliefs || [] } catch { this.beliefs = [] }
    }

    observe(input: { userId: string; subject: string; predicate: string; value: string; source: string; summary: string; confidence: number; supports?: boolean; verifiedAt?: string; ttlMs?: number }): NovaBelief {
        const key = `${input.userId}\0${input.subject}\0${input.predicate}`
        const id = createHash('sha256').update(key).digest('hex').slice(0, 24)
        let belief = this.beliefs.find(item => item.id === id)
        if (!belief) {
            belief = { id, userId: input.userId, subject: input.subject, predicate: input.predicate, value: redactSecrets(input.value).slice(0, 500), confidence: 0, status: 'uncertain', evidence: [], counterEvidence: [], updatedAt: new Date().toISOString() }
            this.beliefs.push(belief)
        }
        const verifiedAt = input.verifiedAt || new Date().toISOString()
        const evidence: BeliefEvidence = {
            id: createHash('sha256').update(`${id}\0${input.source}\0${verifiedAt}\0${input.summary}`).digest('hex').slice(0, 24),
            source: input.source, summary: redactSecrets(input.summary).slice(0, 500), verifiedAt,
            supports: input.supports !== false, confidence: Math.max(0, Math.min(1, input.confidence)),
            expiresAt: input.ttlMs ? new Date(Date.parse(verifiedAt) + input.ttlMs).toISOString() : undefined,
        }
        const target = evidence.supports ? belief.evidence : belief.counterEvidence
        if (!target.some(item => item.id === evidence.id)) target.push(evidence)
        if (evidence.supports && evidence.confidence >= belief.confidence) belief.value = redactSecrets(input.value).slice(0, 500)
        this.recalculate(belief)
        this.persist()
        return structuredClone(belief)
    }

    assess(id: string, now = Date.now()): NovaBelief | null {
        const belief = this.beliefs.find(item => item.id === id)
        if (!belief) return null
        this.recalculate(belief, now)
        return structuredClone(belief)
    }

    list(userId?: string): NovaBelief[] {
        const now = Date.now()
        for (const belief of this.beliefs) this.recalculate(belief, now)
        return this.beliefs.filter(item => !userId || item.userId === userId).map(item => structuredClone(item))
    }

    unresolved(userId: string): NovaBelief[] { return this.list(userId).filter(item => item.status === 'uncertain' || item.status === 'disputed') }

    retractSource(source: string): number {
        let removed = 0
        for (const belief of this.beliefs) {
            const before = belief.evidence.length + belief.counterEvidence.length
            belief.evidence = belief.evidence.filter(item => item.source !== source)
            belief.counterEvidence = belief.counterEvidence.filter(item => item.source !== source)
            removed += before - belief.evidence.length - belief.counterEvidence.length
            this.recalculate(belief)
        }
        this.beliefs = this.beliefs.filter(belief => belief.evidence.length + belief.counterEvidence.length > 0)
        if (removed > 0) this.persist()
        return removed
    }

    getPrompt(userId: string, query: string): string {
        const terms = query.toLowerCase().split(/[^a-z0-9äöüß]+/i).filter(term => term.length >= 4)
        const relevant = this.list(userId).filter(belief => {
            const haystack = `${belief.subject} ${belief.predicate} ${belief.value}`.toLowerCase()
            return terms.some(term => haystack.includes(term))
        }).slice(0, 6)
        if (!relevant.length) return ''
        return [
            'Belief-Evidence (nicht als sichere Tatsache behandeln, wenn ungeklärt):',
            ...relevant.map(belief => `- [${belief.status}, ${Math.round(belief.confidence * 100)}%] ${belief.subject} ${belief.predicate}: ${belief.value}`),
        ].join('\n')
    }

    private recalculate(belief: NovaBelief, now = Date.now()): void {
        const live = (item: BeliefEvidence) => !item.expiresAt || Date.parse(item.expiresAt) > now
        const support = belief.evidence.filter(live).reduce((sum, item) => sum + item.confidence, 0)
        const counter = belief.counterEvidence.filter(live).reduce((sum, item) => sum + item.confidence, 0)
        const total = support + counter
        belief.confidence = total ? support / total : 0
        belief.status = total === 0 ? 'expired' : counter >= 0.6 && support >= 0.6 ? 'disputed' : belief.confidence >= 0.7 ? 'supported' : 'uncertain'
        belief.updatedAt = new Date(now).toISOString()
    }

    private persist(): void {
        this.beliefs = this.beliefs.slice(-2_000)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: new Date().toISOString(), beliefs: this.beliefs } satisfies BeliefFile)
    }
}

let singleton: BeliefStore | null = null
export function getBeliefStore(): BeliefStore { return singleton ||= new BeliefStore() }
export function setBeliefStore(value: BeliefStore): void { singleton = value }
