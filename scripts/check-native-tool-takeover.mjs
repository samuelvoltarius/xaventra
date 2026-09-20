import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const phase = process.argv[2]
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const runChild = (args, env) => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveChild() : reject(new Error(`child failed (${code ?? signal})`)))
})

async function modules() {
    const core = ['execution-control', 'execution-kernel', 'native-tool-receipts', 'native-tool-takeover', 'tool-evidence-binding']
    const mesh = ['witness-quorum', 'witness-checkpoint-transport', 'quorum-witness']
    const loaded = await Promise.all([...core.map(name => `core/${name}`), ...mesh.map(name => `mesh/${name}`)]
        .map(name => import(pathToFileURL(join(root, `dist/${name}.js`)).href)))
    return Object.assign({}, ...loaded)
}

async function runPhase() {
    const dir = process.env.XAVENTRA_NATIVE_TAKEOVER_QA_DIR
    if (!dir) throw new Error('XAVENTRA_NATIVE_TAKEOVER_QA_DIR is required')
    const m = await modules(); const config = JSON.parse(process.env.XAVENTRA_WITNESS_CONFIG)
    const node = phase === 'execute' ? 'node-a' : phase === 'resume' ? 'node-b' : 'node-a'
    const data = join(dir, node); mkdirSync(data, { recursive: true })
    const missionId = 'process-takeover'; const service = `mission:${missionId}`
    const scopeId = 'mission:process-takeover:step:1'; const principalId = 'qa-owner'; const channel = 'acceptance'
    const args = { path: 'takeover.txt', userId: principalId, channel }
    const inputHash = m.evidenceHash(args); const key = m.makeIdempotencyKey(scopeId, 'read_file', args)
    const result = { success: true, path: 'takeover.txt', content: 'durable peer result' }
    const store = new m.IdempotencyStore(join(data, 'idempotency.json'))
    const receipts = new m.NativeToolReceiptStore(store, join(data, 'receipts.json'))
    const kernel = new m.ExecutionKernel('Lies takeover.txt', { allowedChanges: { allowedTools: ['read_file'] } })
    const lease = phase === 'stale' ? readJson(join(dir, 'old-fence.json'))
        : await m.acquireWitnessQuorumLease(service, 2000, config, node)
    if (phase !== 'stale' && !lease.leader) throw new Error(`${node} failed to acquire mission authority: ${lease.reason}`)
    const fence = phase === 'stale' ? lease : { missionId, epoch: lease.epoch, token: lease.fencingToken }
    if (phase !== 'stale') writeJson(join(dir, phase === 'execute' ? 'old-fence.json' : 'new-fence.json'), fence)
    const authority = { async assertCurrent(candidate) {
        if (candidate.missionId !== fence.missionId || candidate.epoch !== fence.epoch || candidate.token !== fence.token) throw new Error('local fence mismatch')
    } }
    const transport = m.createWitnessCheckpointTransport(config, node)

    if (phase === 'execute') {
        const execution = await store.executeOnce({ key, runId: scopeId, operation: 'read_file', inputHash, execute: async () => { appendFileSync(join(dir, 'effect.log'), 'effect\n'); return result } })
        kernel.verify('read_file', execution.result, { callId: 'call-1', arguments: { path: 'takeover.txt' } })
        receipts.save({ scopeId, principalId, channel, contract: kernel.contract, idempotencyKey: key, executionInputHash: inputHash, evidence: kernel.getVerifiedToolCallEvidence('call-1') })
        if (!await m.publishNativeToolCheckpoint({ fence, scopeId, principalId, channel, kernel, idempotency: store, receipts, authority, transport })) throw new Error('quorum checkpoint publication failed')
        return
    }
    if (phase === 'resume') {
        const restored = await m.hydrateNativeToolCheckpoint({ fence, scopeId, principalId, channel, kernel, idempotency: store, receipts, authority, transport })
        if (restored.imported !== 1 || restored.restored !== 1 || restored.rejected.length) throw new Error(`takeover failed: ${JSON.stringify(restored)}`)
        const replay = await store.executeOnce({ key, runId: scopeId, operation: 'read_file', inputHash, execute: async () => { appendFileSync(join(dir, 'effect.log'), 'duplicate\n'); return result } })
        if (!replay.replayed) throw new Error('successor repeated effect')
        return
    }
    if (phase === 'stale') {
        const payload = { version: 1, missionId, scopeId, principalId, channel, contractFingerprint: m.taskContractFingerprint(kernel.contract), sourceEpoch: fence.epoch, records: [], receipts: [], savedAt: new Date().toISOString() }
        if (await transport.write('stale-external-write', payload, fence)) throw new Error('stale predecessor external write was admitted')
        return
    }
    throw new Error(`unknown phase ${phase}`)
}

if (phase) await runPhase()
else {
    const dir = process.env.XAVENTRA_NATIVE_TAKEOVER_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-native-takeover-'))
    mkdirSync(dir, { recursive: true })
    const report = { success: false, platform: process.platform, evidenceClass: 'three authenticated HTTP witness services with independent durable state plus two isolated Xaventra node processes; not production network or physical-host proof', nodeProcessStarts: 3, witnessServices: 3, effects: 0, staleWriterRejected: false, duplicateEffect: true, error: undefined }
    const m = await modules(); const witnesses = []
    try {
        const endpoints = []
        for (let index = 0; index < 3; index++) {
            const id = `acceptance-w${index + 1}`; const secret = `acceptance-secret-${id}-long`
            const instance = m.createQuorumWitnessServer({ witnessId: id, secret, stateFile: join(dir, `${id}.json`) })
            witnesses.push(instance); endpoints.push({ id, secret, url: `http://127.0.0.1:${await instance.listen()}` })
        }
        const config = { mode: 'witness', witnesses: endpoints, timeoutMs: 1000 }
        const env = { ...process.env, XAVENTRA_NATIVE_TAKEOVER_QA_DIR: dir, XAVENTRA_WITNESS_CONFIG: JSON.stringify(config), NOVA_SKIP_MODEL_RESOLVER_INIT: '1' }
        await runChild([import.meta.filename, 'execute'], env)
        await sleep(2100)
        await runChild([import.meta.filename, 'resume'], env)
        await runChild([import.meta.filename, 'stale'], env)
        const effects = readFileSync(join(dir, 'effect.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
        report.effects = effects.length; report.duplicateEffect = effects.length !== 1; report.staleWriterRejected = true
        report.success = effects.length === 1 && effects[0] === 'effect'
        writeJson(join(dir, 'report.json'), report)
        if (!report.success) throw new Error(`unexpected effects: ${JSON.stringify(effects)}`)
        console.log(JSON.stringify(report))
    } catch (error) {
        report.error = String(error); writeJson(join(dir, 'report.json'), report); throw error
    } finally {
        await Promise.all(witnesses.map(instance => new Promise(resolve => instance.server.close(resolve))))
        if (!process.env.XAVENTRA_NATIVE_TAKEOVER_QA_DIR) rmSync(dir, { recursive: true, force: true })
    }
}
