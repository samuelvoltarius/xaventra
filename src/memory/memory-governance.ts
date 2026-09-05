import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import {
    classifyMemoryQuery,
    isDurableMemoryCandidate,
    memoryKindBonus,
    memoryRelevance,
    memoryFreshnessBonus,
    selectDiverseMemories,
} from './memory-quality.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type MemoryLifecycle = 'candidate' | 'verified' | 'canonical' | 'superseded' | 'rejected' | 'expired'
export type MemoryEvidence =
    | 'user_statement'
    | 'explicit_user_instruction'
    | 'verified_tool_result'
    | 'distillation'
    | 'model_inference'
    | 'manual'
    | 'correction'

export type GovernedMemoryKind =
    | 'identity' | 'preference' | 'project' | 'skill' | 'context' | 'instruction'
    | 'relationship' | 'fact' | 'learning' | 'operational'

export interface MemoryProvenance {
    source: string
    evidence: MemoryEvidence
    timestamp: number
    sessionId?: string
    channel?: string
    toolName?: string
    verified: boolean
}

export interface MemoryProposal {
    content: string
    kind: GovernedMemoryKind
    scope: string
    source: string
    evidence: MemoryEvidence
    confidence: number
    timestamp?: number
    sessionId?: string
    channel?: string
    toolName?: string
    verified?: boolean
    subject?: string
    predicate?: string
    value?: string
    ttlMs?: number
    /** Explicitly rejected/replaced statement supplied by a user correction. */
    replacesContent?: string
}

export interface GovernedMemory {
    id: string
    fingerprint: string
    memoryKey: string
    content: string
    kind: GovernedMemoryKind
    scope: string
    status: MemoryLifecycle
    confidence: number
    createdAt: number
    updatedAt: number
    expiresAt?: number
    lastVerifiedAt?: number
    subject?: string
    predicate?: string
    value?: string
    confirmations: number
    provenance: MemoryProvenance[]
    conflictIds: string[]
    supersedes?: string
    supersededBy?: string
    backends: {
        lancedbId?: string
        coreFact?: boolean
        knowledgeGraph?: boolean
    }
}

interface GovernanceStore {
    version: 1
    updatedAt: number
    records: GovernedMemory[]
}

export interface RecordMemoryOptions {
    publish?: boolean
}

export interface ReplicationMergeOptions {
    /**
     * Project merged records into LanceDB, Core Facts, and the Knowledge Graph.
     * Production federation defaults to true. Isolated validation must disable
     * this so a replication test cannot mutate canonical memory backends.
     */
    projectBackends?: boolean
}

export interface MemoryMaintenanceReport {
    exactDuplicateGroups: string[][]
    activeConflictPairs: Array<[string, string]>
    staleCandidateIds: string[]
    expired: number
}

const STATUS_RANK: Record<MemoryLifecycle, number> = {
    rejected: 0, expired: 0, superseded: 0, candidate: 1, verified: 2, canonical: 3,
}

const STOP_WORDS = new Set([
    'aber', 'auch', 'dass', 'eine', 'einen', 'einer', 'immer', 'nicht', 'oder', 'sind', 'sein',
    'verwende', 'verwenden', 'benutze', 'benutzen', 'nutze', 'nutzen', 'mein', 'meine', 'the',
    'that', 'this', 'with', 'from', 'use', 'uses', 'using', 'never', 'always', 'preference', 'context',
])

function normalize(value: string): string {
    return redactSecrets(value).replace(/\s+/g, ' ').trim()
}

function fingerprint(value: string): string {
    return createHash('sha256').update(normalize(value).toLowerCase()).digest('hex').slice(0, 24)
}

function hasNegation(value: string): boolean {
    return /\b(?:nicht|nie|kein(?:e|en|er)?|never|not|no)\b/i.test(value)
}

function topicTokens(value: string): string[] {
    return (normalize(value).toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])
        .filter(token => !STOP_WORDS.has(token))
        .slice(0, 4)
        .sort()
}

function deriveMemoryKey(proposal: MemoryProposal): string {
    const subject = proposal.subject ? normalize(proposal.subject).toLowerCase() : ''
    const predicate = proposal.predicate ? normalize(proposal.predicate).toLowerCase() : ''
    if (subject && predicate) return `${proposal.scope}:${proposal.kind}:${subject}:${predicate}`
    return `${proposal.scope}:${proposal.kind}:${topicTokens(proposal.content).join(':')}`
}

function initialStatus(proposal: MemoryProposal): MemoryLifecycle {
    if (proposal.evidence === 'manual' || proposal.evidence === 'correction' || proposal.evidence === 'explicit_user_instruction') {
        return 'canonical'
    }
    if (proposal.evidence === 'verified_tool_result' && proposal.verified === true) return 'canonical'
    if (proposal.evidence === 'user_statement') return 'verified'
    if (proposal.evidence === 'distillation' && proposal.confidence >= 0.8) return 'verified'
    return 'candidate'
}

function defaultTtl(proposal: MemoryProposal): number | undefined {
    if (proposal.ttlMs != null) return proposal.ttlMs
    if (proposal.kind === 'operational' || proposal.evidence === 'verified_tool_result') return 30 * 60_000
    if (proposal.kind === 'context' && /\b(?:online|offline|laeuft|läuft|running|port|modell|model|service)\b/i.test(proposal.content)) {
        return 6 * 60 * 60_000
    }
    return undefined
}

function toProvenance(proposal: MemoryProposal, timestamp: number): MemoryProvenance {
    return {
        source: proposal.source,
        evidence: proposal.evidence,
        timestamp,
        sessionId: proposal.sessionId,
        channel: proposal.channel,
        toolName: proposal.toolName,
        verified: proposal.verified === true || proposal.evidence === 'user_statement'
            || proposal.evidence === 'explicit_user_instruction' || proposal.evidence === 'manual'
            || proposal.evidence === 'correction',
    }
}

export class MemoryGovernanceCoordinator {
    private readonly dir: string
    private readonly storePath: string
    private readonly backupPath: string
    private readonly auditPath: string
    private store: GovernanceStore

    constructor(dataDir = getNovaDataDir('memory', 'governance')) {
        this.dir = dataDir
        this.storePath = join(dataDir, 'records.json')
        this.backupPath = join(dataDir, 'records.json.bak')
        this.auditPath = join(dataDir, 'audit.jsonl')
        this.store = this.load()
    }

    private readStore(path: string): GovernanceStore | null {
        try {
            if (!existsSync(path)) return null
            const parsed = JSON.parse(readFileSync(path, 'utf-8')) as GovernanceStore
            return Array.isArray(parsed.records) ? parsed : null
        } catch { return null }
    }

    private replayAudit(): GovernanceStore | null {
        if (!existsSync(this.auditPath)) return null
        const records = new Map<string, GovernedMemory>()
        try {
            for (const line of readFileSync(this.auditPath, 'utf-8').split(/\r?\n/)) {
                if (!line.trim()) continue
                const event = JSON.parse(line) as { record?: GovernedMemory }
                if (event.record?.id) records.set(event.record.id, event.record)
            }
        } catch { return null }
        return records.size > 0
            ? { version: 1, updatedAt: Date.now(), records: [...records.values()] }
            : null
    }

    private load(): GovernanceStore {
        const primary = this.readStore(this.storePath)
        if (primary) return primary
        const replayed = this.replayAudit()
        if (replayed) return replayed
        const backup = this.readStore(this.backupPath)
        if (backup) return backup
        if (existsSync(this.storePath) || existsSync(this.backupPath)) {
            throw new Error('Memory governance catalog is corrupt and could not be recovered')
        }
        return { version: 1, updatedAt: Date.now(), records: [] }
    }

    private persist(): void {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
        this.store.updatedAt = Date.now()
        const temporary = `${this.storePath}.tmp`
        writeFileSync(temporary, JSON.stringify(this.store, null, 2))
        if (existsSync(this.storePath)) copyFileSync(this.storePath, this.backupPath)
        renameSync(temporary, this.storePath)
    }

    private audit(event: string, record: GovernedMemory, detail?: Record<string, unknown>): void {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
        appendFileSync(this.auditPath, JSON.stringify({
            timestamp: Date.now(), event, memoryId: record.id, status: record.status,
            source: record.provenance.at(-1)?.source, detail, record,
        }) + '\n')
    }

    private expireRecords(now = Date.now()): void {
        let changed = false
        for (const record of this.store.records) {
            if (record.expiresAt && record.expiresAt <= now && (record.status === 'verified' || record.status === 'canonical')) {
                record.status = 'expired'
                record.updatedAt = now
                this.audit('expired', record)
                changed = true
            }
        }
        if (changed) this.persist()
    }

    propose(input: MemoryProposal): GovernedMemory | null {
        const content = normalize(input.content)
        const shortHighSignal = (input.kind === 'identity' && content.length >= 5)
            || (input.evidence === 'explicit_user_instruction' && content.length >= 10)
            || (input.evidence === 'correction' && content.length >= 10)
        if (!isDurableMemoryCandidate(content) && !shortHighSignal
            && input.evidence !== 'verified_tool_result' && input.evidence !== 'manual') return null
        if (!content || content.includes('[REDACTED')) return null

        this.expireRecords(input.timestamp || Date.now())
        const proposal = { ...input, content }
        const now = proposal.timestamp || Date.now()
        const hash = fingerprint(content)
        const key = deriveMemoryKey(proposal)
        const provenance = toProvenance(proposal, now)

        const duplicate = this.store.records.find(record =>
            record.scope === proposal.scope
            && !['rejected', 'expired', 'superseded'].includes(record.status)
            && (record.fingerprint === hash || memoryRelevance(record.content, content) >= 0.88))

        if (duplicate) {
            const evidenceKey = `${provenance.source}:${provenance.sessionId || ''}:${provenance.evidence}`
            const knownEvidence = duplicate.provenance.some(item =>
                `${item.source}:${item.sessionId || ''}:${item.evidence}` === evidenceKey)
            if (!knownEvidence) {
                duplicate.provenance.push(provenance)
                duplicate.confirmations++
            }
            duplicate.confidence = Math.max(duplicate.confidence, proposal.confidence)
            duplicate.updatedAt = now
            if (duplicate.status === 'candidate' && initialStatus(proposal) === 'verified') duplicate.status = 'verified'
            if (duplicate.status === 'verified' && duplicate.confirmations >= 2) duplicate.status = 'canonical'
            if (provenance.verified) duplicate.lastVerifiedAt = now
            this.persist()
            this.audit('confirmed', duplicate, { confirmations: duplicate.confirmations })
            return duplicate
        }

        const status = initialStatus(proposal)
        const ttl = defaultTtl(proposal)
        const record: GovernedMemory = {
            id: `mem_${randomUUID()}`,
            fingerprint: hash,
            memoryKey: key,
            content,
            kind: proposal.kind,
            scope: proposal.scope,
            status,
            confidence: Math.max(0, Math.min(1, proposal.confidence)),
            createdAt: now,
            updatedAt: now,
            expiresAt: ttl ? now + ttl : undefined,
            lastVerifiedAt: provenance.verified ? now : undefined,
            subject: proposal.subject,
            predicate: proposal.predicate,
            value: proposal.value,
            confirmations: 1,
            provenance: [provenance],
            conflictIds: [],
            backends: {},
        }

        const conflicts = this.store.records.filter(existing => {
            if (existing.scope !== record.scope || existing.kind !== record.kind) return false
            if (['rejected', 'expired', 'superseded'].includes(existing.status)) return false
            const sameStructuredKey = Boolean(proposal.subject && proposal.predicate && existing.memoryKey === key)
            const similarTopic = memoryRelevance(existing.content, content) >= 0.55
            const explicitlyReplaced = Boolean(proposal.replacesContent
                && memoryRelevance(existing.content, proposal.replacesContent) >= 0.35)
            return existing.fingerprint !== hash
                && (sameStructuredKey || explicitlyReplaced
                    || (similarTopic && hasNegation(existing.content) !== hasNegation(content)))
        })

        for (const conflict of conflicts) {
            record.conflictIds.push(conflict.id)
            conflict.conflictIds.push(record.id)
            if (STATUS_RANK[record.status] >= STATUS_RANK[conflict.status] && record.createdAt >= conflict.createdAt) {
                conflict.status = 'superseded'
                conflict.supersededBy = record.id
                conflict.updatedAt = now
                record.supersedes = conflict.id
                this.audit('superseded', conflict, { by: record.id })
            } else {
                record.status = 'candidate'
            }
        }

        this.store.records.push(record)
        this.persist()
        this.audit('proposed', record, { conflicts: record.conflictIds })
        return record
    }

    async record(proposal: MemoryProposal, options: RecordMemoryOptions = {}): Promise<GovernedMemory | null> {
        const record = this.propose(proposal)
        if (!record || options.publish === false) return record
        if (process.env.NOVA_NO_SIDE_EFFECTS === '1' || process.env.NOVA_TEST_MODE === '1') return record
        return this.publish(record.id)
    }

    async publish(id: string): Promise<GovernedMemory | null> {
        const record = this.store.records.find(item => item.id === id)
        if (!record || !this.isRecallable(record.id) || record.status === 'candidate') return record || null
        if (process.env.NOVA_NO_SIDE_EFFECTS === '1' || process.env.NOVA_TEST_MODE === '1') return record
        const latest = record.provenance.at(-1)

        if (!record.backends.lancedbId) {
            try {
                const lance = await import('./lancedb-memory.js')
                const type = record.kind === 'learning' ? 'learning' : 'fact'
                const lanceId = await lance.remember(record.content, type, `governance:${latest?.source || 'unknown'}`, {
                    governanceId: record.id,
                    governanceStatus: record.status,
                    scope: record.scope,
                    evidence: latest?.evidence,
                    confidence: record.confidence,
                    expiresAt: record.expiresAt,
                    provenance: record.provenance,
                })
                if (lanceId) record.backends.lancedbId = lanceId
            } catch { /* LanceDB remains an optional backend */ }
        }

        if (record.status === 'canonical' && record.kind !== 'operational' && !record.backends.coreFact) {
            try {
                const { addFact } = await import('../layers/L6-core-facts.js')
                const category = record.kind === 'identity' ? 'identity'
                    : record.kind === 'preference' ? 'preference'
                        : record.kind === 'project' ? 'project' : 'other'
                addFact({
                    category,
                    fact: record.content,
                    source: 'governance',
                    confidence: record.confidence,
                    updatedAt: new Date(record.updatedAt).toISOString(),
                    governanceId: record.id,
                    governanceStatus: record.status,
                    expiresAt: record.expiresAt,
                })
                record.backends.coreFact = true
            } catch { /* Core facts remain optional during isolated tests */ }
        }

        if (record.status === 'canonical' && record.subject && record.predicate && record.value
            && record.subject.length <= 50 && record.value.length <= 50 && !record.backends.knowledgeGraph) {
            try {
                const graph = await import('./knowledge-graph.js')
                graph.addNode(record.subject, record.scope.startsWith('user:') ? 'person' : 'other', { governanceId: record.id })
                graph.addNode(record.value, record.kind === 'preference' ? 'preference' : 'concept', { governanceId: record.id })
                graph.addEdge(record.subject, record.predicate, record.value, record.confidence, `governance:${record.id}`)
                record.backends.knowledgeGraph = true
            } catch { /* Graph is an optional projection */ }
        }

        this.persist()
        this.audit('published', record, { backends: record.backends })
        return record
    }

    adoptLegacy(
        proposal: MemoryProposal,
        projections: GovernedMemory['backends'],
    ): GovernedMemory | null {
        const record = this.propose({ ...proposal, evidence: 'manual', verified: true })
        if (!record) return null
        record.status = 'canonical'
        record.backends = { ...record.backends, ...projections }
        record.updatedAt = Date.now()
        this.persist()
        this.audit('legacy-adopted', record, { projections })
        return record
    }

    approve(id: string, source = 'operator'): GovernedMemory | null {
        const record = this.store.records.find(item => item.id === id)
        if (!record || ['rejected', 'expired', 'superseded'].includes(record.status)) return null
        record.status = 'canonical'
        record.updatedAt = Date.now()
        record.lastVerifiedAt = record.updatedAt
        record.provenance.push({ source, evidence: 'manual', timestamp: record.updatedAt, verified: true })
        this.persist()
        this.audit('approved', record)
        return record
    }

    reject(id: string, source = 'operator'): GovernedMemory | null {
        const record = this.store.records.find(item => item.id === id)
        if (!record) return null
        record.status = 'rejected'
        record.updatedAt = Date.now()
        record.provenance.push({ source, evidence: 'manual', timestamp: record.updatedAt, verified: true })
        this.persist()
        this.audit('rejected', record)
        return record
    }

    rescope(id: string, scope: string, source = 'migration'): GovernedMemory | null {
        const record = this.store.records.find(item => item.id === id)
        if (!record || !scope.trim() || record.scope === scope) return record || null
        const previous = record.scope
        record.scope = scope.trim()
        record.memoryKey = deriveMemoryKey({
            content: record.content, kind: record.kind, scope: record.scope, source,
            evidence: 'manual', confidence: record.confidence,
            subject: record.subject, predicate: record.predicate, value: record.value,
        })
        record.updatedAt = Date.now()
        record.provenance.push({ source, evidence: 'manual', timestamp: record.updatedAt, verified: true })
        this.persist()
        this.audit('rescoped', record, { previous, scope: record.scope })
        return record
    }

    async retractProjections(id: string): Promise<boolean> {
        const record = this.store.records.find(item => item.id === id)
        if (!record) return false
        if (record.backends.lancedbId) {
            try {
                const lance = await import('./lancedb-memory.js')
                await lance.forget(record.backends.lancedbId)
            } catch { /* optional projection */ }
        }
        if (record.backends.coreFact) {
            try {
                const core = await import('../layers/L6-core-facts.js')
                core.removeFactByGovernanceId(record.id)
            } catch { /* optional projection */ }
        }
        if (record.backends.knowledgeGraph) {
            try {
                const graph = await import('./knowledge-graph.js')
                graph.removeGovernanceProjection(record.id)
            } catch { /* optional projection */ }
        }
        record.backends = {}
        record.updatedAt = Date.now()
        this.persist()
        this.audit('projections-retracted', record)
        return true
    }

    async rejectAndRetract(id: string, source = 'operator'): Promise<GovernedMemory | null> {
        const record = this.reject(id, source)
        if (!record) return null
        await this.retractProjections(id)
        return record
    }

    getReplicationSnapshot(): GovernedMemory[] {
        this.expireRecords()
        return this.store.records.map(record => JSON.parse(JSON.stringify(record)) as GovernedMemory)
    }

    async mergeReplicationSnapshot(
        records: GovernedMemory[],
        sourceNode: string,
        options: ReplicationMergeOptions = {},
    ): Promise<number> {
        const projectBackends = options.projectBackends !== false
        let merged = 0
        for (const remote of records) {
            if (!remote?.id || !remote.content || !remote.scope || remote.status === 'candidate') continue
            const local = this.store.records.find(record => record.id === remote.id)
            if (local && local.updatedAt >= remote.updatedAt) continue
            const competing = this.store.records.find(record => record.id !== remote.id
                && record.memoryKey === remote.memoryKey
                && !['rejected', 'expired', 'superseded'].includes(record.status))
            if (competing && competing.updatedAt >= remote.updatedAt) continue
            if (competing) {
                competing.status = 'superseded'
                competing.supersededBy = remote.id
                competing.updatedAt = remote.updatedAt
                if (projectBackends) await this.retractProjections(competing.id)
                this.audit('federated-superseded', competing, { sourceNode, by: remote.id })
            }
            const next: GovernedMemory = {
                ...JSON.parse(JSON.stringify(remote)),
                backends: projectBackends ? (local?.backends || {}) : {},
                provenance: [...(remote.provenance || []), {
                    source: `federated:${sourceNode}`, evidence: 'manual', timestamp: Date.now(), verified: true,
                }],
            }
            if (competing) next.supersedes = competing.id
            if (local) Object.assign(local, next)
            else this.store.records.push(next)
            merged++
            if (projectBackends) {
                if (['rejected', 'expired', 'superseded'].includes(next.status)) await this.retractProjections(next.id)
                else await this.publish(next.id)
            }
            this.audit('federated-merge', next, { sourceNode })
        }
        if (merged > 0) this.persist()
        return merged
    }

    isRecallable(id: string, now = Date.now()): boolean {
        this.expireRecords(now)
        const record = this.store.records.find(item => item.id === id)
        return Boolean(record && (record.status === 'verified' || record.status === 'canonical'))
    }

    getMaintenanceReport(now = Date.now()): MemoryMaintenanceReport {
        this.expireRecords(now)
        const live = this.store.records.filter(record => !['rejected', 'expired', 'superseded'].includes(record.status))
        const duplicateGroups = new Map<string, GovernedMemory[]>()
        for (const record of live) {
            const key = `${record.scope}:${record.fingerprint}`
            duplicateGroups.set(key, [...(duplicateGroups.get(key) || []), record])
        }
        const activeIds = new Set(live.map(record => record.id))
        const pairKeys = new Set<string>()
        const activeConflictPairs: Array<[string, string]> = []
        for (const record of live) for (const conflictId of record.conflictIds) {
            if (!activeIds.has(conflictId)) continue
            const pair = [record.id, conflictId].sort() as [string, string]
            const key = pair.join(':')
            if (!pairKeys.has(key)) { pairKeys.add(key); activeConflictPairs.push(pair) }
        }
        return {
            exactDuplicateGroups: [...duplicateGroups.values()].filter(group => group.length > 1).map(group => group.map(record => record.id)),
            activeConflictPairs,
            staleCandidateIds: live.filter(record => record.status === 'candidate' && now - record.updatedAt > 30 * 24 * 60 * 60_000).map(record => record.id),
            expired: this.store.records.filter(record => record.status === 'expired').length,
        }
    }

    /** Consolidates only byte-equivalent facts inside the same principal
     * scope. Semantic conflicts remain operator-visible and are never guessed. */
    async consolidateExactDuplicates(source = 'memory-maintenance'): Promise<{ merged: number; retained: string[] }> {
        const report = this.getMaintenanceReport()
        const retained: string[] = []
        let merged = 0
        for (const ids of report.exactDuplicateGroups) {
            const records = ids.map(id => this.store.records.find(record => record.id === id)).filter(Boolean) as GovernedMemory[]
            records.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || b.confirmations - a.confirmations || b.updatedAt - a.updatedAt)
            const winner = records[0]
            if (!winner) continue
            retained.push(winner.id)
            for (const duplicate of records.slice(1)) {
                const known = new Set(winner.provenance.map(item => `${item.source}:${item.timestamp}:${item.evidence}`))
                for (const item of duplicate.provenance) {
                    const key = `${item.source}:${item.timestamp}:${item.evidence}`
                    if (!known.has(key)) { known.add(key); winner.provenance.push(item) }
                }
                winner.confirmations += duplicate.confirmations
                winner.confidence = Math.max(winner.confidence, duplicate.confidence)
                winner.updatedAt = Math.max(winner.updatedAt, duplicate.updatedAt)
                duplicate.status = 'superseded'
                duplicate.supersededBy = winner.id
                duplicate.updatedAt = Date.now()
                await this.retractProjections(duplicate.id)
                this.audit('duplicate-consolidated', duplicate, { source, retained: winner.id })
                merged++
            }
            this.audit('duplicate-retained', winner, { source, merged: records.length - 1 })
        }
        if (merged > 0) this.persist()
        return { merged, retained }
    }

    getContextForPrompt(scope: string | string[], query: string, limit = 8): string {
        this.expireRecords()
        const scopes = new Set(Array.isArray(scope) ? scope : [scope])
        const intent = classifyMemoryQuery(query)
        const ranked = this.store.records
            .filter(record => scopes.has(record.scope) && (record.status === 'verified' || record.status === 'canonical'))
            .map(record => {
                const relevance = memoryRelevance(query, record.content)
                return {
                    record,
                    relevance,
                    score: relevance * 6
                        + memoryKindBonus(query, record.kind)
                        + (record.status === 'canonical' ? 2 : 1)
                        + record.confidence,
                }
            })
            .filter(item => {
                if (intent === 'overview' && item.record.scope === 'global' && item.relevance === 0) return false
                return item.relevance > 0 || memoryKindBonus(query, item.record.kind) > 0
                    || item.record.kind === 'identity'
            })
            .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
            .slice(0, limit)
        if (ranked.length === 0) return ''
        return [
            '## Verifiziertes Gedächtnis',
            'Beachte Gültigkeit und Herkunft. "Verifiziert" ist eine bestätigte Aussage; "Kanonisch" ist die aktuelle Autorität.',
            ...ranked.map(({ record }) => `- [${record.status === 'canonical' ? 'KANONISCH' : 'VERIFIZIERT'}] ${record.content} (Quelle: ${record.provenance.at(-1)?.source || 'unbekannt'})`),
        ].join('\n')
    }

    recall(scope: string | string[], query: string, limit = 8): GovernedMemory[] {
        this.expireRecords()
        const scopes = new Set(Array.isArray(scope) ? scope : [scope])
        const intent = classifyMemoryQuery(query)
        const ranked = this.store.records
            .filter(record => scopes.has(record.scope) && (record.status === 'verified' || record.status === 'canonical'))
            .map(record => {
                const relevance = memoryRelevance(query, record.content)
                return {
                    record,
                    relevance,
                    score: relevance * 6 + memoryKindBonus(query, record.kind)
                        + (record.status === 'canonical' ? 2 : 1) + record.confidence
                        + memoryFreshnessBonus(record.kind, record.updatedAt),
                }
            })
            .filter(item => {
                if (intent === 'overview' && item.record.scope === 'global' && item.relevance === 0) return false
                return item.relevance > 0 || memoryKindBonus(query, item.record.kind) > 0
                    || item.record.kind === 'identity'
            })
            .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
            .map(item => ({ ...item.record, score: item.score }))
        return selectDiverseMemories(ranked, limit).map(({ score: _score, ...record }) => record as GovernedMemory)
    }

    list(filter?: { scope?: string; status?: MemoryLifecycle }): GovernedMemory[] {
        this.expireRecords()
        return this.store.records.filter(record =>
            (!filter?.scope || record.scope === filter.scope)
            && (!filter?.status || record.status === filter.status))
    }

    get(id: string): GovernedMemory | undefined {
        this.expireRecords()
        return this.store.records.find(record => record.id === id)
    }

    getStats(): Record<MemoryLifecycle | 'total', number> {
        this.expireRecords()
        const stats = { total: this.store.records.length, candidate: 0, verified: 0, canonical: 0, superseded: 0, rejected: 0, expired: 0 }
        for (const record of this.store.records) stats[record.status]++
        return stats
    }
}

let coordinator: MemoryGovernanceCoordinator | null = null

export function getMemoryGovernanceCoordinator(): MemoryGovernanceCoordinator {
    if (!coordinator) coordinator = new MemoryGovernanceCoordinator()
    return coordinator
}

export function setMemoryGovernanceCoordinator(next: MemoryGovernanceCoordinator): void {
    coordinator = next
}
