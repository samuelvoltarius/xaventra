import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Usage } from '@openai/agents'

process.env.NOVA_SKIP_MODEL_RESOLVER_INIT ||= '1'

const root = resolve(import.meta.dirname, '..')
const phase = process.argv[2]
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))
const runChild = (childPhase, env) => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, childPhase], { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveChild() : reject(new Error(`${childPhase} failed (${code ?? signal})`)))
})

async function modules() {
    const names = [
        'agents/openai-agents-backend', 'core/execution-control', 'core/native-tool-receipts',
        'core/outcome-ledger', 'core/task-contract', 'core/tool-evidence-binding',
        'mesh/quorum-witness', 'mesh/witness-checkpoint-transport', 'mesh/witness-quorum',
    ]
    const loaded = await Promise.all(names.map(name => import(pathToFileURL(join(root, `dist/${name}.js`)).href)))
    return Object.assign({}, ...loaded)
}

class ExecuteModel {
    calls = 0
    async getResponse() {
        this.calls++
        return {
            usage: new Usage({ requests: 1 }),
            output: this.calls === 1
                ? [{ type: 'function_call', callId: 'read-1', name: 'echo_tool', arguments: '{"value":"durable"}', status: 'completed' }]
                : [{ type: 'function_call', callId: 'write-1', name: 'write_gate', arguments: '{"value":"approved"}', status: 'completed' }],
        }
    }
    async *getStreamedResponse() { throw new Error('not used') }
}

class ResumeModel {
    async getResponse() {
        return {
            usage: new Usage({ requests: 1 }),
            output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Both verified tools completed.' }] }],
        }
    }
    async *getStreamedResponse() { throw new Error('not used') }
}

function tools(effectFile) {
    return [
        {
            name: 'echo_tool', description: 'Durable read evidence', category: 'other',
            parameters: [{ name: 'value', type: 'string', description: 'Value', required: true }],
            handler: async params => {
                appendFileSync(effectFile, 'echo\n')
                return { success: true, output: params.value }
            },
        },
        {
            name: 'write_gate', description: 'Approval-gated write evidence', category: 'other',
            parameters: [{ name: 'value', type: 'string', description: 'Value', required: true }],
            handler: async params => {
                appendFileSync(effectFile, 'write\n')
                return { success: true, output: params.value }
            },
        },
    ]
}

function exportLedger(ledgerDir, ledger, runId) {
    const events = readdirSync(ledgerDir).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
        .flatMap(file => readFileSync(join(ledgerDir, file), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)))
        .filter(event => event.runId === runId)
    return { events, checkpoint: ledger.loadCheckpoint(runId) }
}

async function childPhase() {
    const dir = process.env.XAVENTRA_AGENTS_TAKEOVER_QA_DIR
    if (!dir) throw new Error('XAVENTRA_AGENTS_TAKEOVER_QA_DIR is required')
    const config = JSON.parse(process.env.XAVENTRA_WITNESS_CONFIG)
    const m = await modules()
    const missionId = 'agents-sdk-process-takeover'
    const service = `mission:${missionId}`
    const scopeId = 'mission:agents-sdk-process-takeover:step:1'
    const principalId = 'qa-owner'
    const channel = 'acceptance'
    const nodeId = phase === 'execute' ? 'agents-node-a' : 'agents-node-b'
    const nodeDir = join(dir, nodeId)
    mkdirSync(nodeDir, { recursive: true })

    if (phase === 'stale') {
        const oldFence = readJson(join(dir, 'old-fence.json'))
        const transport = m.createWitnessCheckpointTransport(config, 'agents-node-a')
        const payload = {
            version: 1, missionId, scopeId, principalId, channel, contractFingerprint: 'stale',
            sourceEpoch: oldFence.epoch, records: [], receipts: [], savedAt: new Date().toISOString(),
        }
        if (await transport.write('stale-agents-sdk-write', payload, oldFence)) throw new Error('stale predecessor checkpoint write was admitted')
        return
    }

    const lease = await m.acquireWitnessQuorumLease(service, 4000, config, nodeId)
    if (!lease.leader) throw new Error(`${nodeId} failed to acquire mission authority: ${lease.reason}`)
    const fence = { missionId, epoch: lease.epoch, token: lease.fencingToken }
    writeJson(join(dir, phase === 'execute' ? 'old-fence.json' : 'new-fence.json'), fence)
    const authority = {
        async assertCurrent(candidate) {
            if (candidate.missionId !== missionId || candidate.epoch !== fence.epoch || candidate.token !== fence.token) throw new Error('local fence mismatch')
            const current = await m.acquireWitnessQuorumLease(service, 4000, config, nodeId)
            if (!current.leader || current.epoch !== candidate.epoch) throw new Error('witness quorum rejected current mission authority')
        },
    }
    const transport = m.createWitnessCheckpointTransport(config, nodeId)
    const idempotency = new m.IdempotencyStore(join(nodeDir, 'idempotency.json'))
    const receipts = new m.NativeToolReceiptStore(idempotency, join(nodeDir, 'receipts.json'))
    const ledger = new m.OutcomeLedger(join(nodeDir, 'ledger'))
    const effectFile = join(dir, 'effects.log')

    if (phase === 'execute') {
        const contract = m.createTaskContract('Run both verified tools', { requiresTool: true, kind: 'generic-action' }, ['echo_tool', 'write_gate'])
        const content = `[NOVA_MISSION_KEY:${scopeId}] [NOVA_MISSION_FENCE:${missionId}:${fence.epoch}:${fence.token}] ${contract.goal}`
        const model = new ExecuteModel()
        const backend = new m.OpenAIAgentsBackend({
            modelProvider: { getModel: () => model }, maxTurns: 4, ledger,
            idempotencyStore: idempotency, receiptStore: receipts,
            checkpointAuthority: authority, checkpointTransport: transport,
        })
        const result = await backend.run({ contract, userId: principalId, channel, content, tools: tools(effectFile) })
        if (result.status !== 'interrupted' || !result.checkpoint) throw new Error(`expected durable interruption: ${JSON.stringify(result)}`)
        const exported = exportLedger(join(nodeDir, 'ledger'), ledger, contract.id)
        if (exported.checkpoint?.completedIdempotencyKeys?.length !== 1) throw new Error('approval checkpoint omitted completed receipt key')
        writeJson(join(dir, 'handoff.json'), { contract, serializedState: result.checkpoint, exported })
        return
    }

    if (phase === 'resume') {
        const handoff = readJson(join(dir, 'handoff.json'))
        ledger.importEvents(handoff.exported.events)
        if (!handoff.exported.checkpoint || !ledger.importCheckpoint(handoff.exported.checkpoint)) throw new Error('successor could not import SDK checkpoint')
        const content = `[NOVA_MISSION_KEY:${scopeId}] [NOVA_MISSION_FENCE:${missionId}:${fence.epoch}:${fence.token}] ${handoff.contract.goal}`
        const backend = new m.OpenAIAgentsBackend({
            modelProvider: { getModel: () => new ResumeModel() }, maxTurns: 4, ledger,
            idempotencyStore: idempotency, receiptStore: receipts,
            checkpointAuthority: authority, checkpointTransport: transport,
        })
        const result = await backend.resumeWithDecision(
            { contract: handoff.contract, userId: principalId, channel, content, tools: tools(effectFile) },
            handoff.serializedState,
            'approve',
        )
        if (result.status !== 'completed') throw new Error(`successor resume failed: ${JSON.stringify(result)}`)
        const echoArgs = { value: 'durable' }
        const echoKey = m.makeIdempotencyKey(scopeId, 'echo_tool', echoArgs)
        const replay = await idempotency.executeOnce({
            key: echoKey, runId: scopeId, operation: 'echo_tool', inputHash: m.evidenceHash(echoArgs),
            execute: async () => { appendFileSync(effectFile, 'duplicate\n'); return { success: true } },
        })
        if (!replay.replayed) throw new Error('successor did not retain predecessor idempotency result')
        const completed = ledger.getRun(handoff.contract.id)
        if (completed?.status !== 'completed' || completed.validation?.validator !== 'nova-execution-kernel') throw new Error('successor lacks canonical terminal validation')
        writeJson(join(dir, 'successor.json'), { restoredReceipts: receipts.exportScope(scopeId).length, phase: ledger.loadCheckpoint(handoff.contract.id)?.phase })
        return
    }
    throw new Error(`unknown phase ${phase}`)
}

if (phase) await childPhase()
else {
    const dir = process.env.XAVENTRA_AGENTS_TAKEOVER_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-agents-takeover-'))
    mkdirSync(dir, { recursive: true })
    const report = {
        success: false, platform: process.platform,
        evidenceClass: 'two isolated Xaventra Agents-SDK node processes plus three authenticated durable witness services; not production network or physical-host proof',
        nodeProcessStarts: 3, witnessServices: 3, effects: 0, duplicateEffect: true,
        predecessorReceiptRestored: false, approvalCheckpointImported: false,
        canonicalCompletion: false, staleWriterRejected: false, error: undefined,
    }
    const m = await modules()
    const witnesses = []
    try {
        const endpoints = []
        for (let index = 0; index < 3; index++) {
            const id = `agents-w${index + 1}`
            const secret = `agents-acceptance-secret-${id}`
            const instance = m.createQuorumWitnessServer({ witnessId: id, secret, stateFile: join(dir, `${id}.json`) })
            witnesses.push(instance)
            endpoints.push({ id, secret, url: `http://127.0.0.1:${await instance.listen()}` })
        }
        const config = { mode: 'witness', witnesses: endpoints, timeoutMs: 1000 }
        const env = { ...process.env, XAVENTRA_AGENTS_TAKEOVER_QA_DIR: dir, XAVENTRA_WITNESS_CONFIG: JSON.stringify(config), NOVA_SKIP_MODEL_RESOLVER_INIT: '1' }
        await runChild('execute', env)
        await sleep(4100)
        await runChild('resume', env)
        await runChild('stale', env)
        const effects = readFileSync(join(dir, 'effects.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
        const successor = readJson(join(dir, 'successor.json'))
        report.effects = effects.length
        report.duplicateEffect = effects.length !== 2 || effects[0] !== 'echo' || effects[1] !== 'write'
        report.predecessorReceiptRestored = successor.restoredReceipts === 2
        report.approvalCheckpointImported = successor.phase === 'completed'
        report.canonicalCompletion = successor.phase === 'completed'
        report.staleWriterRejected = true
        report.success = !report.duplicateEffect && report.predecessorReceiptRestored
            && report.approvalCheckpointImported && report.canonicalCompletion && report.staleWriterRejected
        writeJson(join(dir, 'report.json'), report)
        if (!report.success) throw new Error(`Agents SDK takeover checks failed: ${JSON.stringify(report)}`)
        console.log(JSON.stringify(report))
    } catch (error) {
        report.error = String(error)
        writeJson(join(dir, 'report.json'), report)
        throw error
    } finally {
        await Promise.all(witnesses.map(instance => new Promise(resolveClose => instance.server.close(resolveClose))))
        if (!process.env.XAVENTRA_AGENTS_TAKEOVER_QA_DIR) rmSync(dir, { recursive: true, force: true })
    }
}
