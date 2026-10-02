/**
 * 2.84.0 Punkt 5: EIN Messrouter. Der Multi-Router misst nur echte Owner-Läufe
 * (dieselbe Regel wie der Validator-Bug-Finder, `ownerKernelRun`); der
 * Schatten-OutcomeRouter entscheidet nichts mehr und schreibt kein Schatten-Log.
 * `getTrainingStatus()` bleibt (Desktop, src/desktop/model-control.ts).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getNovaDataDir } from '../core/data-root.js'
import { buildModelRegistry, measurementsFromLedgerRuns, type LedgerRunLike } from './model-registry.js'
import { getOutcomeRouter, OutcomeRouter } from './outcome-router.js'

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
function run(index: number, who: { userId: string; channel: string }, success: boolean): LedgerRunLike {
    const runId = `run-${who.channel}-${index}`
    return {
        runId, status: success ? 'completed' : 'failed', model: 'qwen-spark', node: 'spark',
        startedAt: at(10), updatedAt: at(9), userId: who.userId, channel: who.channel, contract: { id: runId },
        validation: { success, validator: 'nova-execution-kernel', awaitingApproval: false },
        events: [{ type: 'route.selected', payload: { modelClass: 'general', taskType: 'recherche' } }],
    }
}
const OWNER = { userId: 'owner@example.com', channel: 'telegram' }
const AUTONOMY = { userId: 'Nova-Autonomy', channel: 'internal' }
const BENCH = { userId: 'benchmark:routing', channel: 'benchmark' }

describe('Punkt 5: der Multi-Router misst nur echte Owner-Läufe', () => {
    it('10 gescheiterte Autonomie-/interne Läufe + 5 Owner-Erfolge → samples 5, successRate 1', () => {
        const runs = [
            ...Array.from({ length: 10 }, (_, i) => run(i, AUTONOMY, false)),
            ...Array.from({ length: 5 }, (_, i) => run(i, OWNER, true)),
        ]
        const cells = measurementsFromLedgerRuns(runs)
        expect(cells).toHaveLength(1)
        expect(cells[0].measurement).toMatchObject({ samples: 5, successes: 5, successRate: 1, source: 'ledger' })
        const registry = buildModelRegistry({ knownNodes: ['spark'], vllm: [{ node: 'spark', baseUrl: 'http://127.0.0.1:8000', models: ['qwen-spark'] }], ledgerRuns: runs })
        expect(registry.endpoints[0].measurements[0]).toMatchObject({ samples: 5, successRate: 1 })
    })

    it('Benchmark-Läufe zählen nicht', () => {
        const runs = [...Array.from({ length: 6 }, (_, i) => run(i, BENCH, false)), run(1, OWNER, true)]
        expect(measurementsFromLedgerRuns(runs)[0].measurement).toMatchObject({ samples: 1, successRate: 1 })
        expect(measurementsFromLedgerRuns(Array.from({ length: 6 }, (_, i) => run(i, BENCH, true)))).toEqual([])
    })

    it('Gegenprobe: ein gescheiterter Owner-Lauf zählt weiter als Fehlschlag; Läufe ohne Kernel-Urteil zählen nicht', () => {
        const unvalidated = { ...run(9, OWNER, false), validation: undefined }
        const cells = measurementsFromLedgerRuns([run(1, OWNER, true), run(2, OWNER, false), unvalidated])
        expect(cells[0].measurement).toMatchObject({ samples: 2, successes: 1, successRate: 0.5 })
    })
})

describe('Punkt 5: kein Schatten-Router mehr', () => {
    const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

    it('Runner und Agents-Backend rufen keinen Schatten-Entscheid mehr auf', () => {
        for (const file of ['agents/nova-runner.ts', 'agents/openai-agents-backend.ts']) {
            expect(source(file)).not.toMatch(/getOutcomeRouter\(\)\.decide\(|shadowRoute|shadowRecommendation/)
        }
        expect(source('routing/outcome-router.ts')).not.toMatch(/NOVA_OUTCOME_ROUTER_MODE|appendFileSync|decide\(/)
    })

    it('OutcomeRouter ist nur noch Proben-Speicher: kein decide, kein Schatten-Log; getTrainingStatus liefert ein Objekt', () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-messrouter-'))
        const router = new OutcomeRouter(undefined, join(dir, 'shadow.jsonl'), 'shadow', join(dir, 'samples.json'))
        expect((router as unknown as Record<string, unknown>).decide).toBeUndefined()
        expect(router.recordValidatedSample({
            runId: 'r1', userId: 'owner@example.com', channel: 'telegram', taskType: 'recherche', model: 'qwen-spark', node: 'spark',
            success: true, durationMs: 100, costUsd: 0, validatedAt: new Date().toISOString(), validationSource: 'nova-execution-kernel',
            evidenceRefs: ['tool-call:c1:web_search'],
        })).toBe(true)
        expect(existsSync(join(dir, 'shadow.jsonl'))).toBe(false)
        const status = router.getTrainingStatus()
        expect(status).toMatchObject({ mode: 'shadow', scope: 'aggregate-observability' })
        expect(status.cells[0]).toMatchObject({ taskType: 'recherche', samples: 1 })
        expect(getOutcomeRouter().getTrainingStatus()).toEqual(expect.objectContaining({ cells: expect.any(Array) }))
    })

    it('ein altes Schatten-Log wird beim Start einmal *.migriert umbenannt, nicht gelöscht', async () => {
        const { migrateShadowDecisionLog } = await import('./outcome-router.js')
        const file = getNovaDataDir('outcome-router-shadow.jsonl')
        writeFileSync(file, '{"mode":"shadow"}\n')
        expect(migrateShadowDecisionLog()).toBe(true)
        expect(existsSync(file)).toBe(false)
        expect(readFileSync(`${file}.migriert`, 'utf8')).toContain('shadow')
        expect(migrateShadowDecisionLog()).toBe(false)
    })
})
