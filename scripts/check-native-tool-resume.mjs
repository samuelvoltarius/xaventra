import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const phase = process.argv[2]

async function modules() {
    const [control, kernel, receipts, evidence] = await Promise.all([
        import(pathToFileURL(join(root, 'dist/core/execution-control.js')).href),
        import(pathToFileURL(join(root, 'dist/core/execution-kernel.js')).href),
        import(pathToFileURL(join(root, 'dist/core/native-tool-receipts.js')).href),
        import(pathToFileURL(join(root, 'dist/core/tool-evidence-binding.js')).href),
    ])
    return { ...control, ...kernel, ...receipts, ...evidence }
}

async function runPhase() {
    const dir = process.env.XAVENTRA_NATIVE_RECEIPT_QA_DIR
    if (!dir) throw new Error('XAVENTRA_NATIVE_RECEIPT_QA_DIR is required')
    const { IdempotencyStore, makeIdempotencyKey, ExecutionKernel, NativeToolReceiptStore, evidenceHash } = await modules()
    const idempotencyFile = join(dir, 'idempotency.json')
    const receiptFile = join(dir, 'receipts.json')
    const effectFile = join(dir, 'effect.log')
    const scopeId = 'mission:process-restart:step:1'
    const principalId = 'qa-owner'
    const channel = 'acceptance'
    const evidenceArgs = { path: 'resume.txt' }
    const executionArgs = { ...evidenceArgs, userId: principalId, channel }
    const result = { success: true, path: 'resume.txt', content: 'durable result' }
    const inputHash = evidenceHash(executionArgs)
    const key = makeIdempotencyKey(scopeId, 'read_file', executionArgs)
    const store = new IdempotencyStore(idempotencyFile)
    const kernel = new ExecutionKernel('Lies die Datei resume.txt', { allowedChanges: { allowedTools: ['read_file'] } })
    const receipts = new NativeToolReceiptStore(store, receiptFile)

    if (phase === 'execute') {
        const execution = await store.executeOnce({
            key, runId: scopeId, operation: 'read_file', inputHash,
            execute: async () => { appendFileSync(effectFile, 'effect\n'); return result },
        })
        if (execution.replayed) throw new Error('first execution unexpectedly replayed')
        if (!kernel.verify('read_file', execution.result, { callId: 'native-call-1', arguments: evidenceArgs }).success) {
            throw new Error('first execution did not verify')
        }
        receipts.save({
            scopeId, principalId, channel, contract: kernel.contract,
            idempotencyKey: key, executionInputHash: inputHash,
            evidence: kernel.getVerifiedToolCallEvidence('native-call-1'),
        })
        return
    }

    if (phase === 'resume') {
        const restored = receipts.rehydrate({ scopeId, principalId, channel, kernel })
        if (restored.restored !== 1 || restored.rejected.length) throw new Error(`receipt rehydration failed: ${JSON.stringify(restored)}`)
        if (!kernel.validateCompletion('Die Datei wurde verifiziert.').success) throw new Error('rehydrated kernel did not satisfy completion contract')
        const replay = await store.executeOnce({
            key, runId: scopeId, operation: 'read_file', inputHash,
            execute: async () => { appendFileSync(effectFile, 'duplicate\n'); return result },
        })
        if (!replay.replayed) throw new Error('resume repeated the effect')
        return
    }
    throw new Error(`unknown phase ${phase}`)
}

if (phase) {
    await runPhase()
} else {
    const dir = process.env.XAVENTRA_NATIVE_RECEIPT_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-native-resume-'))
    try {
        const env = { ...process.env, XAVENTRA_NATIVE_RECEIPT_QA_DIR: dir, NOVA_SKIP_MODEL_RESOLVER_INIT: '1' }
        execFileSync(process.execPath, [import.meta.filename, 'execute'], { cwd: root, env, stdio: 'inherit' })
        execFileSync(process.execPath, [import.meta.filename, 'resume'], { cwd: root, env, stdio: 'inherit' })
        const effects = existsSync(join(dir, 'effect.log'))
            ? readFileSync(join(dir, 'effect.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
            : []
        if (effects.length !== 1 || effects[0] !== 'effect') throw new Error(`expected exactly one effect, got ${JSON.stringify(effects)}`)
        console.log(JSON.stringify({ success: true, processStarts: 2, effects: effects.length, rehydrated: true, duplicateEffect: false }))
    } finally {
        if (!process.env.XAVENTRA_NATIVE_RECEIPT_QA_DIR) rmSync(dir, { recursive: true, force: true })
    }
}
