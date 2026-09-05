import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MemoryGovernanceCoordinator } from './memory-governance.js'

function coordinator(): MemoryGovernanceCoordinator {
    return new MemoryGovernanceCoordinator(join(process.cwd(), '.nova-test-tmp', `governance-${randomUUID()}`))
}

describe('memory governance', () => {
    it('keeps model inferences as candidates and out of prompt context', () => {
        const governance = coordinator()
        const record = governance.propose({
            content: 'Der Benutzer bevorzugt vermutlich dauerhaft ein dunkles Farbschema.',
            kind: 'preference', scope: 'user:1', source: 'llm', evidence: 'model_inference', confidence: 0.6,
        })

        expect(record?.status).toBe('candidate')
        expect(governance.getContextForPrompt('user:1', 'Farbschema')).toBe('')
    })

    it('treats an explicit operator memory instruction as canonical', () => {
        const governance = coordinator()
        const record = governance.propose({
            content: 'Preference: Nova soll auf dem Spark immer vLLM verwenden.',
            kind: 'preference', scope: 'user:1', source: 'telegram:42',
            evidence: 'explicit_user_instruction', confidence: 0.95, verified: true,
        })

        expect(record?.status).toBe('canonical')
        expect(governance.getContextForPrompt('user:1', 'Spark vLLM')).toContain('KANONISCH')
    })

    it('promotes repeated independent distillation evidence', () => {
        const governance = coordinator()
        const proposal = (source: string) => ({
            content: 'Sample entwickelt Nova als verteiltes Agentensystem mit mehreren Nodes.',
            kind: 'project' as const, scope: 'global', source,
            evidence: 'distillation' as const, confidence: 0.85, verified: true,
        })

        expect(governance.propose(proposal('distiller:2026-07-16'))?.status).toBe('verified')
        const promoted = governance.propose(proposal('distiller:2026-07-17'))
        expect(promoted?.status).toBe('canonical')
        expect(promoted?.confirmations).toBe(2)
    })

    it('supersedes an older conflicting statement with a correction', () => {
        const governance = coordinator()
        const old = governance.propose({
            content: 'Der Spark verwendet Ollama als lokalen Modellserver.',
            kind: 'context', scope: 'global', source: 'session:old', evidence: 'user_statement',
            confidence: 0.9, verified: true, subject: 'Spark', predicate: 'model_runtime', value: 'Ollama', timestamp: 10,
        })!
        const current = governance.propose({
            content: 'Der Spark verwendet vLLM als lokalen Modellserver.',
            kind: 'context', scope: 'global', source: 'operator', evidence: 'correction',
            confidence: 1, verified: true, subject: 'Spark', predicate: 'model_runtime', value: 'vLLM', timestamp: 20,
        })!

        expect(governance.list().find(item => item.id === old.id)?.status).toBe('superseded')
        expect(current.status).toBe('canonical')
        expect(current.supersedes).toBe(old.id)
    })

    it('expires operational truth after its TTL', () => {
        const governance = coordinator()
        const record = governance.propose({
            content: 'Verifiziertes Ergebnis von mesh_status: Spark ist online und vLLM antwortet.',
            kind: 'operational', scope: 'global', source: 'tool:mesh_status',
            evidence: 'verified_tool_result', confidence: 1, verified: true, timestamp: 1000, ttlMs: 10,
        })!

        expect(governance.isRecallable(record.id, 1005)).toBe(true)
        expect(governance.isRecallable(record.id, 1011)).toBe(false)
        expect(governance.list().find(item => item.id === record.id)?.status).toBe('expired')
    })

    it('recovers the latest catalog from the append-only audit if stores are corrupt', () => {
        const root = join(process.cwd(), '.nova-test-tmp', `governance-recovery-${randomUUID()}`)
        mkdirSync(root, { recursive: true })
        const governance = new MemoryGovernanceCoordinator(root)
        const first = governance.propose({
            content: 'Sample entwickelt Nova als verteiltes Agentensystem.', kind: 'project',
            scope: 'user:sample', source: 'operator', evidence: 'manual', confidence: 1,
        })!
        const second = governance.propose({
            content: 'Nova verwendet auf dem Spark vLLM für lokale Modelle.', kind: 'context',
            scope: 'user:sample', source: 'operator', evidence: 'manual', confidence: 1,
        })!
        writeFileSync(join(root, 'records.json'), '{broken')
        writeFileSync(join(root, 'records.json.bak'), '{also-broken')

        const recovered = new MemoryGovernanceCoordinator(root)
        expect(recovered.get(first.id)?.content).toContain('verteiltes Agentensystem')
        expect(recovered.get(second.id)?.content).toContain('vLLM')
        expect(readFileSync(join(root, 'audit.jsonl'), 'utf-8')).toContain(second.id)
    })

    it('rescopes legacy records without changing their stable identity', () => {
        const governance = coordinator()
        const record = governance.propose({
            content: 'Sample bevorzugt lokale Modelle für private Workloads.', kind: 'preference',
            scope: 'global', source: 'legacy', evidence: 'manual', confidence: 1,
        })!
        governance.rescope(record.id, 'user:sample', 'migration:test')
        expect(governance.get(record.id)?.scope).toBe('user:sample')
        expect(governance.getContextForPrompt('global', 'lokale Modelle')).toBe('')
        expect(governance.getContextForPrompt('user:sample', 'lokale Modelle')).toContain('KANONISCH')
    })

    it('replicates canonical records and their later tombstones, never candidates', async () => {
        const source = coordinator()
        const target = coordinator()
        const canonical = source.propose({
            content: 'Spark verwendet vLLM als Modellserver.', kind: 'context', scope: 'global',
            source: 'tool:runtime', evidence: 'verified_tool_result', confidence: 1, verified: true,
            subject: 'spark', predicate: 'runtime', value: 'vllm',
        })!
        source.propose({
            content: 'Das Modell vermutet eine unbestätigte Präferenz für gelbe Ausgaben.',
            kind: 'preference', scope: 'user:sample', source: 'llm', evidence: 'model_inference', confidence: 0.5,
        })

        await target.mergeReplicationSnapshot(source.getReplicationSnapshot(), 'spark')
        expect(target.get(canonical.id)?.status).toBe('canonical')
        expect(target.getStats().candidate).toBe(0)

        source.reject(canonical.id, 'operator')
        const tombstone = source.get(canonical.id)!
        tombstone.updatedAt += 10
        await target.mergeReplicationSnapshot(source.getReplicationSnapshot(), 'spark')
        expect(target.get(canonical.id)?.status).toBe('rejected')
        expect(target.getContextForPrompt('global', 'Spark vLLM')).toBe('')
    })

    it('can validate replication without projecting into canonical memory backends', async () => {
        const source = coordinator()
        const target = coordinator()
        const canonical = source.propose({
            content: 'Der isolierte Benchmark verwendet nur seine Registry.',
            kind: 'context', scope: 'benchmark:test', source: 'benchmark',
            evidence: 'verified_tool_result', confidence: 1, verified: true,
        })!
        const publish = vi.spyOn(target, 'publish')
        const retract = vi.spyOn(target, 'retractProjections')

        await target.mergeReplicationSnapshot(
            source.getReplicationSnapshot(),
            'benchmark-source',
            { projectBackends: false },
        )
        expect(target.get(canonical.id)?.status).toBe('canonical')
        expect(target.get(canonical.id)?.backends).toEqual({})
        expect(publish).not.toHaveBeenCalled()
        expect(retract).not.toHaveBeenCalled()

        source.reject(canonical.id, 'benchmark-operator')
        const tombstone = source.get(canonical.id)!
        tombstone.updatedAt += 10
        await target.mergeReplicationSnapshot(
            source.getReplicationSnapshot(),
            'benchmark-source',
            { projectBackends: false },
        )
        expect(target.get(canonical.id)?.status).toBe('rejected')
        expect(publish).not.toHaveBeenCalled()
        expect(retract).not.toHaveBeenCalled()
    })
})
