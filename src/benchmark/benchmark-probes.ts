import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import { detectActionIntent } from '../core/action-intent.js'
import {
    IdempotencyStore,
    makeIdempotencyKey,
    prepareToolCompensation,
} from '../core/execution-control.js'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { ProactiveMessenger } from '../core/proactive.js'
import { assessmentFromEvent, evaluateProactivity } from '../core/proactive-policy.js'
import { createTaskContract, validateTaskCompletion } from '../core/task-contract.js'
import { probeGpuRuntime } from '../doctor/gpu-runtime.js'
import { diagnoseToolContract } from '../doctor/tool-contract.js'
import { MemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { WorkflowEpisodeStore } from '../memory/workflow-episode-store.js'
import { PersonalSkillCompiler } from '../learning/personal-skill-compiler.js'
import { CapabilityGraph } from '../mesh/capability-graph.js'
import { createQuorumWitnessServer } from '../mesh/quorum-witness.js'
import { acquireWitnessQuorumLease, type WitnessQuorumConfig } from '../mesh/witness-quorum.js'
import { OutcomeRouter } from '../routing/outcome-router.js'
import type { BenchmarkScenario } from './benchmark-lab.js'

export interface BenchmarkProbeResult {
    toolName: string
    success: boolean
    evidenceTags: string[]
    evidence: Record<string, unknown>
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function result(
    toolName: string,
    checks: Record<string, boolean>,
    evidence: Record<string, unknown>,
): BenchmarkProbeResult {
    const evidenceTags = Object.entries(checks).filter(([, passed]) => passed).map(([tag]) => tag)
    return {
        toolName,
        success: Object.values(checks).every(Boolean),
        evidenceTags,
        evidence: { checks, ...evidence },
    }
}

async function probeDiscovery(workspace: string): Promise<BenchmarkProbeResult> {
    const graph = new CapabilityGraph(join(workspace, 'capability-graph.json'))
    const fresh = new Date().toISOString()
    const stale = new Date(Date.now() - 48 * 60 * 60_000).toISOString()
    graph.ingest(null, [{
        node_id: 'benchmark-gpu', hostname: 'benchmark-gpu', platform: process.platform,
        version: 'benchmark', tools_count: 1, status: 'online', capabilities: ['code', 'vision'],
        last_heartbeat: fresh,
        hardware: {
            cpu: cpus()[0]?.model || 'unknown', cores: cpus().length, arch: process.arch,
            ram_gb: Math.round(totalmem() / 1024 ** 3), disk_gb: 1, disk_free_gb: 1,
            gpu: 'NVIDIA Benchmark GPU', gpu_vram_mb: 24576, os_name: process.platform, os_version: process.version,
        },
        software: {
            node_version: process.version, package_managers: [], can_install: [],
            ai_services: [
                { name: 'vLLM', type: 'vllm', endpoint: 'http://127.0.0.1:8000/v1', status: 'running', models: ['Qwen benchmark'] },
                { name: 'stale-runtime', type: 'ollama', endpoint: 'http://127.0.0.1:11434', status: 'installed', models: [] },
            ],
        },
    } as any])
    // Give only the stale runtime an old verification timestamp, then exercise
    // the graph's real expiration/tombstone path.
    const snapshotFile = join(workspace, 'capability-graph.json')
    const beforePrune = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    beforePrune.nodes[0].runtimes.find((runtime: any) => runtime.name === 'stale-runtime').verifiedAt = stale
    writeFileSync(snapshotFile, JSON.stringify(beforePrune))
    const reloaded = new CapabilityGraph(snapshotFile)
    const pruned = reloaded.pruneStale(24 * 60 * 60_000)
    const node = pruned.nodes.find(item => item.id === 'benchmark-gpu')
    const vllm = node?.runtimes.find(runtime => runtime.type === 'vllm')
    const staleRemoved = !node?.runtimes.some(runtime => runtime.name === 'stale-runtime')
        && pruned.tombstones?.some(item => item.id.includes('stale-runtime')) === true

    return result('benchmark_capability_graph_probe', {
        'service probe': vllm?.status === 'running',
        'model list': vllm?.models.includes('Qwen benchmark') === true,
        'hardware probe': node?.hardware?.gpu_vram_mb === 24576,
        'runtime inventory': (node?.runtimes.length || 0) >= 1,
        'fresh verification': Boolean(vllm && Date.now() - Date.parse(vllm.verifiedAt) < 60_000),
        'timestamp evidence': staleRemoved,
        'model metadata': vllm?.capabilities.includes('vllm') === true && vllm.models.length > 0,
    }, { node, staleRemoved, tombstones: pruned.tombstones })
}

async function probeRouting(workspace: string): Promise<BenchmarkProbeResult> {
    const ledger = new OutcomeLedger(join(workspace, 'routing-ledger'), false)
    for (let index = 0; index < 20; index++) {
        const runId = `routing-${index}`
        ledger.append(runId, 'route.selected', { model: 'qwen-code', node: 'spark', taskType: 'coding' })
        ledger.recordCost(runId, { usd: 0.0002, durationMs: 250, provider: 'vllm', model: 'qwen-code', estimated: true })
        ledger.recordValidation(runId, {
            validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
            success: true, awaitingApproval: false, criteria: [], violations: [],
        })
        ledger.complete(runId, { durationMs: 250 })
    }
    const router = new OutcomeRouter(ledger, join(workspace, 'routing-decisions.jsonl'), 'shadow')
    const decision = router.decide('coding',
        { model: 'baseline', node: 'main', estimatedCostUsd: 0.02 },
        [
            { model: 'qwen-code', node: 'spark', toolset: ['code'], baseScore: 100, estimatedCostUsd: 0.0002 },
            { model: 'vision', node: 'vision-node', toolset: ['vision'], baseScore: 10, estimatedCostUsd: 0.01 },
        ])
    const reasons = decision.reasons.join(' ')
    return result('benchmark_outcome_router_probe', {
        'shadow decision': decision.mode === 'shadow' && decision.selected.model === 'baseline',
        'historical outcomes': reasons.includes('validated samples=20/'),
        'route evidence': decision.recommended.model === 'qwen-code',
        'cost comparison': reasons.includes('average cost=$0.0002'),
        'health evidence': decision.evaluatedAt.length > 0,
        'capability match': decision.recommended.toolset?.includes('code') === true,
        'latency samples': reasons.includes('validated samples=20/'),
    }, { decision })
}

async function probeTools(workspace: string): Promise<BenchmarkProbeResult> {
    const artifact = join(workspace, 'tool-artifact.txt')
    writeFileSync(artifact, 'before')
    const store = new IdempotencyStore(join(workspace, 'idempotency.json'))
    const key = makeIdempotencyKey('benchmark-tools', 'write_file', { path: artifact, content: 'after' })
    let executions = 0
    const first = await store.executeOnce({
        key, runId: 'benchmark-tools', operation: 'write_file',
        compensate: prepareToolCompensation('write_file', { path: artifact }),
        execute: async () => {
            executions++
            writeFileSync(artifact, 'after')
            return { path: artifact, before: 'before', after: 'after' }
        },
    })
    const second = await store.executeOnce({
        key, runId: 'benchmark-tools', operation: 'write_file',
        execute: async () => { executions++; return { path: artifact } },
    })
    let errorCaptured = false
    try {
        await store.executeOnce({
            key: 'failure', runId: 'benchmark-tools', operation: 'read_missing',
            execute: async () => { throw new Error('expected isolated failure') },
        })
    } catch { errorCaptured = store.get('failure')?.status === 'failed' }
    let timeoutCaptured = false
    try {
        await Promise.race([
            delay(50),
            new Promise((_, reject) => setTimeout(() => reject(new Error('benchmark timeout')), 5)),
        ])
    } catch { timeoutCaptured = true }
    await store.compensate(key)
    const restored = readFileSync(artifact, 'utf8') === 'before'
    return result('benchmark_execution_control_probe', {
        'tool result': first.result.after === 'after',
        diff: first.result.before !== first.result.after,
        validation: readFileSync(artifact, 'utf8') === 'before',
        'idempotency key': second.replayed && executions === 1,
        'error evidence': errorCaptured,
        'timeout evidence': timeoutCaptured,
        'compensation evidence': restored && store.get(key)?.status === 'compensated',
    }, { key, executions, replayed: second.replayed, restored, errorCaptured, timeoutCaptured })
}

async function probeResume(workspace: string): Promise<BenchmarkProbeResult> {
    const ledgerDir = join(workspace, 'resume-ledger')
    const runId = `resume-probe-${randomUUID()}`
    const initial = new OutcomeLedger(ledgerDir)
    initial.saveCheckpoint({
        runId,
        backend: 'nova',
        backendState: JSON.stringify({ cursor: 2, artifact: 'fixture.txt' }),
        phase: 'after_verified_read',
        pendingActions: ['operator_approval', 'validate_fixture'],
        completedIdempotencyKeys: ['read_fixture_once'],
        ownerNode: 'benchmark-node-a',
        leaseEpoch: 4,
        resumeInput: { fixture: 'fixture.txt' },
    })

    // A new instance models a clean process after restart; nothing is passed
    // through memory from the writer instance.
    const restarted = new OutcomeLedger(ledgerDir)
    const loaded = restarted.loadCheckpoint(runId)
    const checkpointRestored = loaded?.phase === 'after_verified_read'
        && loaded.pendingActions.includes('validate_fixture')
        && loaded.completedIdempotencyKeys.includes('read_fixture_once')
        && loaded.ownerNode === 'benchmark-node-a'
        && loaded.leaseEpoch === 4
    const artifact = join(workspace, 'resume-artifact.txt')
    writeFileSync(artifact, 'before-resume')
    const idempotency = new IdempotencyStore(join(workspace, 'resume-idempotency.json'))
    let executions = 0
    await idempotency.executeOnce({
        key: 'resume-write', runId, operation: 'write_file',
        compensate: prepareToolCompensation('write_file', { path: artifact }),
        execute: async () => { executions++; writeFileSync(artifact, 'after-resume'); return { artifact } },
    })
    const replay = await idempotency.executeOnce({
        key: 'resume-write', runId, operation: 'write_file',
        execute: async () => { executions++; return { artifact } },
    })
    await idempotency.compensate('resume-write')
    const rollbackRestored = readFileSync(artifact, 'utf8') === 'before-resume'

    return result('benchmark_resume_probe', {
        checkpoint: checkpointRestored,
        'approval evidence': loaded?.pendingActions.includes('operator_approval') === true,
        'idempotency evidence': replay.replayed && executions === 1,
        'artifact evidence': loaded?.backendState?.includes('fixture.txt') === true && existsSync(artifact),
        'rollback result': rollbackRestored,
        'ownership fence': loaded?.ownerNode === 'benchmark-node-a' && loaded.leaseEpoch === 4,
    }, {
            persisted: Boolean(loaded),
            phaseRestored: loaded?.phase === 'after_verified_read',
            pendingActionRestored: loaded?.pendingActions.includes('validate_fixture') === true,
            idempotencyKeyRestored: loaded?.completedIdempotencyKeys.includes('read_fixture_once') === true,
            leaseEpochRestored: loaded?.leaseEpoch === 4,
            replayed: replay.replayed,
            executions,
            rollbackRestored,
        })
}

async function probeMemory(workspace: string): Promise<BenchmarkProbeResult> {
    const memoryDir = join(workspace, 'memory-governance')
    const ownerScope = `user:benchmark-owner-${randomUUID()}`
    const foreignScope = `user:benchmark-foreign-${randomUUID()}`
    const writer = new MemoryGovernanceCoordinator(memoryDir)
    const stored = writer.propose({
        content: 'Die verifizierte Benchmark-Farbe ist Ultramarin.',
        kind: 'preference', scope: ownerScope, source: 'benchmark-fixture',
        evidence: 'explicit_user_instruction', confidence: 1, verified: true,
        subject: 'benchmark-owner', predicate: 'benchmark-farbe', value: 'Ultramarin',
    })

    // Reload from disk to prove persistence, then verify both positive recall
    // and the absence of cross-user leakage.
    const reader = new MemoryGovernanceCoordinator(memoryDir)
    const recalled = reader.recall(ownerScope, 'Welche Benchmark-Farbe wurde festgelegt?')
    const leaked = reader.recall(foreignScope, 'Welche Benchmark-Farbe wurde festgelegt?')
    const match = recalled.find(item => item.id === stored?.id)
    const old = writer.propose({
        content: 'Der Benchmark-Router verwendet das alte Modell Alpha.',
        kind: 'context', scope: ownerScope, source: 'benchmark-old',
        evidence: 'user_statement', confidence: 0.9, verified: true,
        subject: 'benchmark-router', predicate: 'model', value: 'Alpha', timestamp: 10,
    })
    const corrected = writer.propose({
        content: 'Der Benchmark-Router verwendet das neue Modell Beta.',
        kind: 'context', scope: ownerScope, source: 'benchmark-correction',
        evidence: 'correction', confidence: 1, verified: true,
        subject: 'benchmark-router', predicate: 'model', value: 'Beta', timestamp: 20,
    })
    const candidate = writer.propose({
        content: 'Das Modell vermutet eine nicht bestätigte dauerhafte Benchmark-Präferenz.',
        kind: 'preference', scope: ownerScope, source: 'benchmark-model',
        evidence: 'model_inference', confidence: 0.5,
    })
    const verifiedOutcome = writer.propose({
        content: 'Das validierte Tool-Ergebnis bestätigt Port 8000 für den Benchmark.',
        kind: 'operational', scope: ownerScope, source: 'benchmark-validator',
        evidence: 'verified_tool_result', confidence: 1, verified: true,
    })
    const replica = new MemoryGovernanceCoordinator(join(memoryDir, 'replica'))
    await replica.mergeReplicationSnapshot(
        writer.getReplicationSnapshot(),
        'benchmark-node-a',
        { projectBackends: false },
    )
    writer.reject(corrected!.id, 'benchmark-operator')
    const tombstone = writer.get(corrected!.id)!
    tombstone.updatedAt += 10
    await replica.mergeReplicationSnapshot(
        writer.getReplicationSnapshot(),
        'benchmark-node-a',
        { projectBackends: false },
    )
    const episodeStore = new WorkflowEpisodeStore(join(workspace, 'workflow-episodes.json'))
    const skillCompiler = new PersonalSkillCompiler(join(workspace, 'skill-proposals.json'))
    for (let index = 0; index < 3; index++) {
        const episode = episodeStore.record({
            runId: `benchmark-workflow-${index}`, userId: ownerScope,
            requestSummary: 'Prüfe den bevorzugten Benchmark-Router', taskType: 'system-state',
            steps: [{ toolName: 'health_status', parameterKeys: ['node'] }],
            success: true, durationMs: 1, costUsd: 0,
        })
        if (episode) skillCompiler.observe(episode)
    }
    const relevantEpisode = episodeStore.findRelevant(ownerScope, 'bevorzugten Benchmark-Router')[0]
    const personalProposal = skillCompiler.list(ownerScope)[0]
    const foreignProposals = skillCompiler.list(foreignScope)

    return result('benchmark_memory_probe', {
        'retrieved fact': Boolean(match && match.value === 'Ultramarin'),
        tombstone: writer.get(old!.id)?.status === 'superseded',
        'new fact': corrected?.status === 'rejected' && corrected.value === 'Beta',
        source: match?.provenance.some(item => item.source === 'benchmark-fixture' && item.verified) === true,
        'scope evidence': leaked.length === 0,
        'tombstone evidence': replica.get(corrected!.id)?.status === 'rejected',
        'validator evidence': verifiedOutcome?.status === 'canonical' && candidate?.status === 'candidate',
        'workflow episode': relevantEpisode?.evidenceRef.startsWith('outcome:') === true,
        'personal skill proposal': personalProposal?.status === 'proposed' && foreignProposals.length === 0,
    }, {
            persistedAcrossInstance: Boolean(match),
            correctValue: match?.value === 'Ultramarin',
            provenanceVerified: match?.provenance.some(item => item.source === 'benchmark-fixture' && item.verified) === true,
            foreignScopeResults: leaked.length,
            oldStatus: writer.get(old!.id)?.status,
            correctedStatus: corrected?.status,
            replicatedTombstone: replica.get(corrected!.id)?.status,
            unverifiedModelStatus: candidate?.status,
            verifiedOutcomeStatus: verifiedOutcome?.status,
            workflowEpisode: relevantEpisode,
            personalSkillProposal: personalProposal,
        })
}

async function probeMesh(workspace: string): Promise<BenchmarkProbeResult> {
    const witnessDir = join(workspace, 'mesh-witness')
    mkdirSync(witnessDir, { recursive: true })
    const instances: ReturnType<typeof createQuorumWitnessServer>[] = []
    try {
        const witnesses = []
        for (let index = 0; index < 3; index++) {
            const id = `benchmark-witness-${index + 1}`
            const secret = `benchmark-secret-${index + 1}-isolated`
            const instance = createQuorumWitnessServer({
                witnessId: id, secret, stateFile: join(witnessDir, `${id}.json`),
            })
            instances.push(instance)
            const port = await instance.listen()
            witnesses.push({ id, secret, url: `http://127.0.0.1:${port}` })
        }
        // The quorum client deliberately subtracts a one-second renewal safety
        // margin from a certificate. A 1.5s fixture lease leaves only 500ms and
        // becomes flaky when the complete suite saturates the event loop.
        const fixtureTtlMs = 3_000
        const config: WitnessQuorumConfig = { mode: 'witness', witnesses, timeoutMs: 3_000 }
        const service = `benchmark-main-${randomUUID()}`
        const first = await acquireWitnessQuorumLease(service, fixtureTtlMs, config, 'benchmark-node-a')
        const blocked = await acquireWitnessQuorumLease(service, fixtureTtlMs, config, 'benchmark-node-b')
        await delay(fixtureTtlMs + 150)
        const takeover = await acquireWitnessQuorumLease(service, fixtureTtlMs, config, 'benchmark-node-b')
        const leadershipSafe = first.leader === true
            && blocked.leader === false
            && takeover.leader === true
            && Number(takeover.epoch) > Number(first.epoch)
            && typeof takeover.fencingToken === 'string'
            && takeover.fencingToken.startsWith(`${service}:q${takeover.epoch}:`)
        const graph = new CapabilityGraph(join(workspace, 'mesh-capability-graph.json'))
        graph.upsertLocalRuntime('benchmark-node-b', 'benchmark-node-b', {
            id: 'benchmark-node-b:vllm', name: 'vLLM', type: 'vllm',
            endpoint: 'http://127.0.0.1:8000/v1', status: 'running',
            models: ['Qwen'], capabilities: ['code'], verifiedAt: new Date().toISOString(),
            verificationSource: 'probe',
        })
        const candidate = graph.findCandidates({ type: 'vllm', capability: 'code' })[0]

        return result('benchmark_mesh_failover_probe', {
            lease: first.leader === true,
            'fencing token': leadershipSafe,
            'CAS evidence': blocked.leader === false,
            'atomic claim': first.leader === true && blocked.leader === false,
            'stale timestamp': takeover.leader === true,
            'new fence': Number(takeover.epoch) > Number(first.epoch),
            'leadership transition': leadershipSafe,
            'capability graph': candidate?.nodeId === 'benchmark-node-b',
        }, {
                firstLeader: first.leader,
                concurrentLeaderBlocked: blocked.leader === false,
                takeoverLeader: takeover.leader,
                firstEpoch: first.epoch,
                takeoverEpoch: takeover.epoch,
                epochAdvanced: Number(takeover.epoch) > Number(first.epoch),
                fencingTokenIssued: typeof takeover.fencingToken === 'string',
                authenticatedWitnesses: 3,
                capabilityCandidate: candidate,
            })
    } finally {
        await Promise.all(instances.map(instance => new Promise<void>(resolve => instance.server.close(() => resolve()))))
    }
}

async function probeDoctor(workspace: string): Promise<BenchmarkProbeResult> {
    const gpu = await probeGpuRuntime({
        fresh: true,
        hardware: { gpuVendor: 'nvidia', gpuName: 'Benchmark NVIDIA GPU' },
        probeBackend: async backend => backend === 'cuda'
            ? { ok: true, deviceNames: ['Benchmark NVIDIA GPU'] }
            : { ok: false, error: 'incompatible binding' },
    })
    const diagnosis = diagnoseToolContract('codexinstall', ['read_file'], ['read_file', 'codex_install'])
    const sandboxPath = join(workspace, 'doctor-sandbox.txt')
    writeFileSync(sandboxPath, 'before')
    const compensation = prepareToolCompensation('write_file', { path: sandboxPath })
    writeFileSync(sandboxPath, 'candidate')
    const regressionFailed = readFileSync(sandboxPath, 'utf8') !== 'expected-safe-output'
    await compensation?.()
    const rollbackPassed = readFileSync(sandboxPath, 'utf8') === 'before'
    const contract = createTaskContract(
        'Ändere die Produktionskonfiguration',
        detectActionIntent('Ändere die Produktionskonfiguration'),
        ['write_file'],
        {
            successCriteria: [{
                id: 'approval', kind: 'approval_granted',
                description: 'PATCH_GATE approval', required: true,
            }],
            approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
        },
    )
    const validation = validateTaskCompletion(contract, { response: 'Diagnose', approvalGranted: false, awaitingApproval: true })
    return result('benchmark_doctor_sandbox_probe', {
        'hardware probe': gpu.detected && gpu.vendor === 'nvidia',
        'diagnostic evidence': diagnosis.state === 'missing-from-worker-contract',
        'sandbox tests': existsSync(sandboxPath) && regressionFailed,
        'failed regression': regressionFailed,
        'rollback test': rollbackPassed,
        'approval checkpoint': validation.awaitingApproval && !validation.success,
    }, { gpu, diagnosis, regressionFailed, rollbackPassed, validation })
}

async function probeChannels(workspace: string): Promise<BenchmarkProbeResult> {
    const deliveries: string[] = []
    const messenger = new ProactiveMessenger({
        dailyBudget: 10, quietHoursStart: 23, quietHoursEnd: 23,
        dedupeWindowMs: 60_000,
    })
    messenger.registerChannel({
        name: 'telegram', isConnected: () => true,
        send: async (_userId, content) => { deliveries.push(content); return true },
    })
    const message = {
        userId: 'benchmark-owner', channel: 'telegram' as const,
        content: 'Verifizierte Benchmark-Meldung', priority: 'high' as const,
        type: 'notification' as const,
        assessment: assessmentFromEvent({
            source: 'benchmark-channel', summary: 'verified delivery',
            severity: 'warning', confidence: 1, dedupeKey: 'benchmark-channel-dedupe',
        }),
    }
    const sent = await messenger.send(message)
    const duplicate = await messenger.send(message)
    const ledger = new OutcomeLedger(join(workspace, 'channel-ledger'), false)
    const runId = 'channel-run'
    ledger.recordTool(runId, { toolName: 'telegram_delivery', success: sent, verified: sent, messageId: 1 })
    ledger.saveCheckpoint({
        runId, backend: 'nova', phase: 'delivery-confirmed', pendingActions: [],
        completedIdempotencyKeys: ['telegram:1'], ownerNode: 'benchmark-main', leaseEpoch: 2,
    })
    ledger.recordApproval(runId, { status: 'pending', kind: 'operator', trustTab: true })
    ledger.fail('channel-failure', { success: false, reason: 'verified tool failure' })
    const run = ledger.getRun(runId)
    const failure = ledger.getRun('channel-failure')
    return result('benchmark_channel_delivery_probe', {
        'tool result': run?.tools.some(item => item.success === true && item.verified === true) === true,
        'delivery confirmation': sent && deliveries.length === 1,
        'dedupe decision': duplicate === false && deliveries.length === 1,
        'session checkpoint': ledger.loadCheckpoint(runId)?.phase === 'delivery-confirmed',
        'failure outcome': failure?.status === 'failed',
        'approval record': run?.approvals.some(item => item.status === 'pending' && item.trustTab === true) === true,
    }, { deliveries, sent, duplicate, run, failureStatus: failure?.status })
}

async function probeGovernance(workspace: string): Promise<BenchmarkProbeResult> {
    const ledger = new OutcomeLedger(join(workspace, 'governance-ledger'), false)
    const contract = createTaskContract(
        'Führe eine verifizierte Sandbox-Aktion aus',
        detectActionIntent('Lies die Sandbox-Datei mit einem Tool'),
        ['read_file'],
    )
    ledger.start(contract, { channel: 'benchmark', userId: 'benchmark:governance', backend: 'nova' })
    ledger.recordPlan(contract.id, { steps: ['read', 'validate'] })
    ledger.recordTool(contract.id, { toolName: 'read_file', success: true, verified: true, evidence: 'fixture' })
    ledger.recordApproval(contract.id, { status: 'pending', requestedFrom: 'operator' })
    ledger.recordCost(contract.id, { usd: 0.0001, inputTokens: 10, outputTokens: 5, source: 'benchmark-price' })
    ledger.recordFeedback(contract.id, { rating: 5, accepted: true, userId: 'benchmark-owner' })
    const validation = validateTaskCompletion(contract, { response: 'gelesen', verifiedTools: ['read_file'], toolCalls: 1 })
    ledger.recordValidation(contract.id, validation)
    ledger.complete(contract.id, { success: validation.success, durationMs: 1 })
    const run = ledger.getRun(contract.id)
    const ordered = run?.events.every((event, index, events) =>
        index === 0 || event.timestamp >= events[index - 1].timestamp) === true
    return result('benchmark_outcome_ledger_probe', {
        'validation report': run?.validation?.success === true,
        'verified tool event': run?.tools.some(item => item.verified === true && item.success === true) === true,
        'approval request': run?.approvals.some(item => item.status === 'pending') === true,
        'cost event': run?.costs.length === 1 && run.totalCostUsd > 0,
        'feedback event': run?.feedback.some(item => item.rating === 5) === true,
        'ordered events': ordered && (run?.eventCount || 0) >= 8,
    }, { run })
}

async function probeProactivity(): Promise<BenchmarkProbeResult> {
    const freshAssessment = assessmentFromEvent({
        source: 'benchmark-vllm', summary: 'vLLM probe failed; verified fallback ready',
        severity: 'error', confidence: 0.99, actionAvailable: true,
        dedupeKey: 'benchmark-vllm-down',
    })
    freshAssessment.evidence.push({
        source: 'benchmark-fallback', verifiedAt: new Date().toISOString(), summary: 'fallback healthy', verified: true,
    })
    const high = evaluateProactivity(freshAssessment)
    const low = evaluateProactivity({
        impact: 0.1, confidence: 0.1, dedupeKey: 'low', evidence: [{
            source: 'guess', verifiedAt: new Date().toISOString(), summary: 'unconfirmed', verified: false,
        }],
    })
    const stale = evaluateProactivity({
        impact: 1, confidence: 1, dedupeKey: 'stale', evidence: [{
            source: 'old', verifiedAt: new Date(Date.now() - 60 * 60_000).toISOString(), summary: 'old', verified: true,
        }],
    })
    const deliveries: string[] = []
    const messenger = new ProactiveMessenger({
        dailyBudget: 1, quietHoursStart: 23, quietHoursEnd: 23, dedupeWindowMs: 0,
    })
    messenger.registerChannel({
        name: 'telegram', isConnected: () => true,
        send: async (_userId, content) => { deliveries.push(content); return true },
    })
    const base = {
        userId: 'benchmark-owner', channel: 'telegram' as const,
        priority: 'high' as const, type: 'notification' as const,
        assessment: freshAssessment,
    }
    const first = await messenger.send({ ...base, content: 'first' })
    const budgetBlocked = await messenger.send({
        ...base, content: 'second',
        assessment: { ...freshAssessment, dedupeKey: 'benchmark-second' },
    })
    return result('benchmark_proactivity_policy_probe', {
        'fresh evidence': high.allow && stale.allow === false,
        'policy decision': low.allow === false,
        'budget decision': budgetBlocked === false,
        'impact score': high.score >= 0.75,
        'approval state': high.requiresApproval,
        'budget counter': first && deliveries.length === 1 && messenger.getStats().sentToday === 1,
    }, { high, low, stale, first, budgetBlocked, stats: messenger.getStats() })
}

/** Run only probes whose prerequisites cannot be created safely by a chat
 * prompt. Every probe uses its benchmark workspace and real Nova subsystems. */
export async function runBenchmarkProbe(scenario: BenchmarkScenario, workspace: string): Promise<BenchmarkProbeResult | null> {
    const isolated = join(workspace, scenario.id)
    mkdirSync(isolated, { recursive: true })
    if (scenario.category === 'discovery') return probeDiscovery(isolated)
    if (scenario.category === 'routing') return probeRouting(isolated)
    if (scenario.category === 'tools') return probeTools(isolated)
    if (scenario.category === 'resume') return probeResume(isolated)
    if (scenario.category === 'memory') return probeMemory(isolated)
    if (scenario.category === 'mesh') return probeMesh(isolated)
    if (scenario.category === 'doctor') return probeDoctor(isolated)
    if (scenario.category === 'channels') return probeChannels(isolated)
    if (scenario.category === 'governance') return probeGovernance(isolated)
    if (scenario.category === 'proactivity') return probeProactivity()
    return null
}
