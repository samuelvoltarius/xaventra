import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const phase = process.argv[2]
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))

async function modules() {
    const names = ['execution-control', 'execution-kernel', 'native-tool-receipts', 'native-tool-takeover', 'tool-evidence-binding']
    const loaded = await Promise.all(names.map(name => import(pathToFileURL(join(root, `dist/core/${name}.js`)).href)))
    return Object.assign({}, ...loaded)
}

async function runPhase() {
    const dir = process.env.XAVENTRA_NATIVE_TAKEOVER_QA_DIR
    if (!dir) throw new Error('XAVENTRA_NATIVE_TAKEOVER_QA_DIR is required')
    const m = await modules()
    const node = phase === 'execute' ? 'node-a' : 'node-b'
    const data = join(dir, node)
    const scopeId = 'mission:process-takeover:step:1'; const principalId = 'qa-owner'; const channel = 'acceptance'
    const args = { path: 'takeover.txt', userId: principalId, channel }
    const inputHash = m.evidenceHash(args); const key = m.makeIdempotencyKey(scopeId, 'read_file', args)
    const result = { success: true, path: 'takeover.txt', content: 'durable peer result' }
    const store = new m.IdempotencyStore(join(data, 'idempotency.json'))
    const receipts = new m.NativeToolReceiptStore(store, join(data, 'receipts.json'))
    const kernel = new m.ExecutionKernel('Lies takeover.txt', { allowedChanges: { allowedTools: ['read_file'] } })
    const authority = { async assertCurrent(candidate) {
        const current = readJson(join(dir, 'authority.json'))
        if (JSON.stringify(candidate) !== JSON.stringify(current)) throw new Error('stale fence rejected')
    } }
    const transport = {
        async write(id, payload) { writeJson(join(dir, 'checkpoint.json'), { id, timestamp: Date.now(), payload }); return true },
        async read() { return existsSync(join(dir, 'checkpoint.json')) ? [readJson(join(dir, 'checkpoint.json'))] : [] },
    }
    const fence = phase === 'execute'
        ? { missionId: 'process-takeover', epoch: 1, token: 'node-a-token' }
        : { missionId: 'process-takeover', epoch: 2, token: 'node-b-token' }

    if (phase === 'execute') {
        const execution = await store.executeOnce({ key, runId: scopeId, operation: 'read_file', inputHash, execute: async () => { appendFileSync(join(dir, 'effect.log'), 'effect\n'); return result } })
        kernel.verify('read_file', execution.result, { callId: 'call-1', arguments: { path: 'takeover.txt' } })
        receipts.save({ scopeId, principalId, channel, contract: kernel.contract, idempotencyKey: key, executionInputHash: inputHash, evidence: kernel.getVerifiedToolCallEvidence('call-1') })
        if (!await m.publishNativeToolCheckpoint({ fence, scopeId, principalId, channel, kernel, idempotency: store, receipts, authority, transport })) throw new Error('checkpoint publication failed')
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
        let rejected = false
        try {
            await m.hydrateNativeToolCheckpoint({ fence: { missionId: 'process-takeover', epoch: 1, token: 'node-a-token' }, scopeId, principalId, channel, kernel, idempotency: store, receipts, authority, transport })
        } catch { rejected = true }
        if (!rejected) throw new Error('stale predecessor was admitted')
        return
    }
    throw new Error(`unknown phase ${phase}`)
}

if (phase) await runPhase()
else {
    const dir = process.env.XAVENTRA_NATIVE_TAKEOVER_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-native-takeover-'))
    mkdirSync(dir, { recursive: true })
    const report = { success: false, platform: process.platform, evidenceClass: 'three real node processes with a shared file-backed fixture authority; not production coordinator or network-partition proof', processStarts: 3, effects: 0, staleWriterRejected: false, duplicateEffect: true, error: undefined }
    try {
        const env = { ...process.env, XAVENTRA_NATIVE_TAKEOVER_QA_DIR: dir, NOVA_SKIP_MODEL_RESOLVER_INIT: '1' }
        writeJson(join(dir, 'authority.json'), { missionId: 'process-takeover', epoch: 1, token: 'node-a-token' })
        execFileSync(process.execPath, [import.meta.filename, 'execute'], { cwd: root, env, stdio: 'inherit' })
        writeJson(join(dir, 'authority.json'), { missionId: 'process-takeover', epoch: 2, token: 'node-b-token' })
        execFileSync(process.execPath, [import.meta.filename, 'resume'], { cwd: root, env, stdio: 'inherit' })
        execFileSync(process.execPath, [import.meta.filename, 'stale'], { cwd: root, env, stdio: 'inherit' })
        const effects = readFileSync(join(dir, 'effect.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
        report.effects = effects.length; report.duplicateEffect = effects.length !== 1; report.staleWriterRejected = true
        report.success = effects.length === 1 && effects[0] === 'effect'
        writeJson(join(dir, 'report.json'), report)
        if (!report.success) throw new Error(`unexpected effects: ${JSON.stringify(effects)}`)
        console.log(JSON.stringify(report))
    } catch (error) {
        report.error = String(error)
        writeJson(join(dir, 'report.json'), report)
        throw error
    } finally {
        if (!process.env.XAVENTRA_NATIVE_TAKEOVER_QA_DIR) rmSync(dir, { recursive: true, force: true })
    }
}
