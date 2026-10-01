/**
 * One-time migration of the old parallel memory stores into memory
 * governance (the single memory authority). Runs at daemon start; every old
 * file is renamed to `<file>.migriert` afterwards (never deleted), so a second
 * start finds nothing and the data stays inspectable.
 *
 *   .nova-learning/corrections.json      L7 CorrectionLearner → correction memory (governance)
 *   .nova-data/self-rules.json           L20 self-rules → per-principal instruction (governance)
 *   .nova-memory/memory.json             local keyword memory → candidates (user statements only)
 *   .nova-vector-memory/index.json       vector memory → candidates (user statements only)
 *   .nova-data/mesh-memory/*.json        mesh-memory-sync pool → renamed (L22 replicates governance)
 *   .nova-data/causal-memory.json        causal chains → renamed (derived from the outcome ledger)
 *
 * Old conversation snippets only ever become `candidate` records: they are
 * not recalled until the owner approves them (/memory review). Secrets are
 * rejected by governance itself.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getRuntimeRoot } from '../core/data-root.js'
import { principalScope } from '../users/principal-id.js'
import { recordUserCorrectionMemory } from './correction-memory.js'
import { getMemoryGovernanceCoordinator, type MemoryGovernanceCoordinator } from './memory-governance.js'
import { isDurableMemoryCandidate } from './memory-quality.js'

export interface LegacyMigrationReport {
    corrections: number
    selfRules: number
    localMemory: number
    vectorMemory: number
    /** Old files that were renamed to `.migriert`. */
    renamed: string[]
}

const MAX_ENTRIES_PER_FILE = 1_000
/** Test pollution that once landed in self-rules.json (see scripts/quarantine-test-learning-data.mjs). */
const TEST_RULE = /test pattern xyz|always do x for test/i
const NO_OWNER = new Set(['', 'legacy', 'system', 'unknown'])

function readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
}

function retire(path: string, report: LegacyMigrationReport): void {
    let target = `${path}.migriert`
    if (existsSync(target)) target = `${path}.migriert-${Date.now()}`
    renameSync(path, target)
    report.renamed.push(path)
}

/** Conversation entries of the old local/vector stores: { userId: [{ role, content, ... }] }. */
function proposeConversationCandidates(data: unknown, source: string, governance: MemoryGovernanceCoordinator): number {
    let proposed = 0
    if (!data || typeof data !== 'object') return 0
    for (const [userId, entries] of Object.entries(data as Record<string, unknown>)) {
        if (!Array.isArray(entries) || NO_OWNER.has(String(userId).trim())) continue
        for (const entry of entries.slice(-MAX_ENTRIES_PER_FILE)) {
            if (entry?.role !== 'user' || !isDurableMemoryCandidate(entry?.content)) continue
            const record = governance.propose({
                content: entry.content,
                kind: 'context',
                scope: principalScope(String(entry.userId || userId)),
                source,
                evidence: 'model_inference',
                confidence: 0.5,
                timestamp: Number(entry.timestamp) || undefined,
            })
            if (record) proposed++
        }
    }
    return proposed
}

export async function migrateLegacyMemoryStores(options: { root?: string; governance?: MemoryGovernanceCoordinator } = {}): Promise<LegacyMigrationReport> {
    const root = options.root || getRuntimeRoot()
    const governance = options.governance || getMemoryGovernanceCoordinator()
    const report: LegacyMigrationReport = { corrections: 0, selfRules: 0, localMemory: 0, vectorMemory: 0, renamed: [] }

    const corrections = join(root, '.nova-learning', 'corrections.json')
    if (existsSync(corrections)) {
        const list = readJson(corrections)
        for (const item of Array.isArray(list) ? list.slice(-MAX_ENTRIES_PER_FILE) : []) {
            const userId = String(item?.userId || '').trim()
            if (NO_OWNER.has(userId) || typeof item?.correctedResponse !== 'string') continue
            const record = await recordUserCorrectionMemory({
                scope: principalScope(userId),
                message: item.correctedResponse,
                priorAssistantResponse: typeof item.originalResponse === 'string' ? item.originalResponse : undefined,
                sessionId: `legacy-correction:${String(item.id || '').slice(0, 64)}`,
            }, governance)
            if (record) report.corrections++
        }
        retire(corrections, report)
    }

    const selfRules = join(root, '.nova-data', 'self-rules.json')
    if (existsSync(selfRules)) {
        const list = readJson(selfRules)
        for (const rule of Array.isArray(list) ? list.slice(-MAX_ENTRIES_PER_FILE) : []) {
            const userId = String(rule?.userId || '').trim()
            const text = String(rule?.rule || '').trim()
            // Correction rules were only ever applied to their own principal;
            // rules without one were never injected and stay archived.
            if (NO_OWNER.has(userId) || !text || TEST_RULE.test(`${rule?.pattern || ''} ${text}`)) continue
            const record = await governance.record({
                content: `Gelernte Regel: ${text}`,
                kind: 'instruction',
                scope: principalScope(userId),
                source: 'migration:L20-self-rules',
                evidence: 'distillation',
                confidence: Math.max(0, Math.min(1, Number(rule?.confidence) || 0)),
                timestamp: Number(rule?.createdAt) || undefined,
            })
            if (record) report.selfRules++
        }
        retire(selfRules, report)
    }

    const local = join(root, '.nova-memory', 'memory.json')
    if (existsSync(local)) {
        report.localMemory = proposeConversationCandidates(readJson(local), 'migration:local-memory', governance)
        retire(local, report)
    }

    const vector = join(root, '.nova-vector-memory', 'index.json')
    if (existsSync(vector)) {
        report.vectorMemory = proposeConversationCandidates(readJson(vector), 'migration:vector-memory', governance)
        retire(vector, report)
    }

    for (const path of [
        join(root, '.nova-data', 'mesh-memory', 'shared.json'),
        join(root, '.nova-data', 'mesh-memory', 'sync-log.json'),
        join(root, '.nova-data', 'causal-memory.json'),
    ]) {
        if (existsSync(path)) retire(path, report)
    }
    return report
}
