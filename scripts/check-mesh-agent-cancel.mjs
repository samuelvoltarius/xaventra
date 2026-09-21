import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = resolve(import.meta.dirname, '..')
const phase = process.argv[2]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2))
    renameSync(temporary, file)
}
const waitFor = async (file, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(file) && Date.now() < deadline) await sleep(20)
    if (!existsSync(file)) throw new Error(`timed out waiting for ${file}`)
}
const reservePort = () => new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server.close(error => error ? reject(error) : resolvePort(port))
    })
})
const runChild = (childPhase, cwd, env) => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, childPhase], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveChild({ stdout, stderr }) : reject(new Error(`${childPhase} exited ${code}: ${stdout}\n${stderr}`)))
})

async function child() {
    const root = process.env.XAVENTRA_MESH_AGENT_QA_DIR
    const runtime = await import(pathToFileURL(join(repository, 'dist/mesh/mesh-transport-runtime.js')).href)
    if (phase === 'target') {
        const started = join(root, 'target-started.json')
        const aborted = join(root, 'target-aborted.json')
        const lateEffect = join(root, 'late-effect.txt')
        runtime.initMeshTransportRuntime(async (_channel, userId, _content, _reply, _image, execution) => {
            writeJson(started, { userId, allowedTools: execution?.allowedTools, requestId: execution?.requestId })
            await new Promise((resolveRun, rejectRun) => {
                const timer = setTimeout(() => {
                    writeFileSync(lateEffect, 'unsafe late effect')
                    resolveRun()
                }, 500)
                execution?.abortSignal.addEventListener('abort', () => {
                    clearTimeout(timer)
                    writeJson(aborted, { requestId: execution.requestId })
                    rejectRun(new Error('AbortError: governed mesh cancellation'))
                }, { once: true })
            })
        })
        writeJson(join(root, 'target-ready.json'), { ready: true })
        await waitFor(join(root, 'source-done.json'), 20_000)
        await runtime.stopMeshTransportRuntime()
        return
    }
    if (phase === 'source') {
        runtime.initMeshTransportRuntime()
        const unsafe = await runtime.sendAgentRequest('target-node', 'unsafe request', {
            userId: 'qa-owner', allowedTools: ['run_command'], idempotencyKey: 'unsafe-agent-request', budget: { timeoutMs: 2000 },
        })
        const sent = await runtime.sendAgentRequest('target-node', 'read the fixture', {
            userId: 'qa-owner', allowedTools: ['read_file'], idempotencyKey: 'mesh-agent-cancel-1', budget: { timeoutMs: 5000 },
        })
        await waitFor(join(root, 'target-started.json'))
        const cancel = await runtime.cancelMeshRun('target-node', sent.requestId, 'timeout')
        const result = await runtime.waitForMeshRunResult(sent.requestId, 5000)
        const replay = await runtime.sendAgentRequest('target-node', 'read the fixture', {
            userId: 'qa-owner', allowedTools: ['read_file'], idempotencyKey: 'mesh-agent-cancel-1', budget: { timeoutMs: 5000 },
        })
        const replayResult = await runtime.waitForMeshRunResult(replay.requestId, 5000)
        await sleep(650)
        writeJson(join(root, 'source-result.json'), { unsafe, sent, cancel, result, replay, replayResult })
        writeJson(join(root, 'source-done.json'), { done: true })
        await runtime.stopMeshTransportRuntime()
        return
    }
    throw new Error(`unknown child phase ${phase}`)
}

async function parent() {
    const root = resolve(process.env.XAVENTRA_MESH_AGENT_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-mesh-agent-')))
    mkdirSync(root, { recursive: true })
    const sourceDir = join(root, 'source')
    const targetDir = join(root, 'target')
    mkdirSync(sourceDir, { recursive: true }); mkdirSync(targetDir, { recursive: true })
    const [{ MeshIdentity }, sourcePort, targetPort] = await Promise.all([
        import(pathToFileURL(join(repository, 'dist/mesh/mesh-identity.js')).href), reservePort(), reservePort(),
    ])
    const sourceIdentity = new MeshIdentity('source-node', join(sourceDir, '.nova-data', 'mesh-identity'))
    const targetIdentity = new MeshIdentity('target-node', join(targetDir, '.nova-data', 'mesh-identity'))
    const peer = (nodeId, port, publicKey) => ({ nodeId, url: `ws://127.0.0.1:${port}`, transport: 'direct', publicKey, roles: ['system'], allowedTools: ['read_file'] })
    const config = (port, peers) => ({
        mesh: { mode: 'direct', security: { allowTofu: false, allowedTools: ['read_file'] }, direct: { enabled: true, listenHost: '127.0.0.1', port, peers } },
    })
    writeJson(join(sourceDir, 'xaventra.config.json'), config(sourcePort, [peer('target-node', targetPort, targetIdentity.publicKey)]))
    writeJson(join(targetDir, 'xaventra.config.json'), config(targetPort, [peer('source-node', sourcePort, sourceIdentity.publicKey)]))
    const common = { ...process.env, XAVENTRA_MESH_AGENT_QA_DIR: root, NOVA_SKIP_MODEL_RESOLVER_INIT: '1' }
    const report = { success: false, platform: process.platform, evidenceClass: 'two actual Node processes over authenticated direct WebSocket mesh on loopback; not physical-host or production proof', checks: [], error: undefined }
    try {
        const target = runChild('target', targetDir, { ...common, NOVA_NODE_ID: 'target-node', NOVA_RUNTIME_ROOT: targetDir, NOVA_MESH_DIRECT_PORT: String(targetPort) })
        await waitFor(join(root, 'target-ready.json'))
        await runChild('source', sourceDir, { ...common, NOVA_NODE_ID: 'source-node', NOVA_RUNTIME_ROOT: sourceDir, NOVA_MESH_DIRECT_PORT: String(sourcePort) })
        await target
        const source = readJson(join(root, 'source-result.json'))
        const started = readJson(join(root, 'target-started.json'))
        const abortedPath = join(root, 'target-aborted.json')
        const aborted = existsSync(abortedPath) ? readJson(abortedPath) : {}
        report.checks = [
            { id: 'unsafe-tool-request-rejected', passed: source.unsafe.ack.status === 'rejected' },
            { id: 'typed-agent-request-delivered', passed: source.sent.ack.status === 'delivered' },
            { id: 'typed-cancel-delivered', passed: source.cancel.status === 'delivered' },
            { id: 'remote-abort-observed', passed: source.result?.success === false && /cancel|abort/i.test(source.result?.error || '') && aborted.requestId === source.sent.requestId },
            { id: 'principal-and-tool-scope-preserved', passed: started.userId === 'qa-owner' && JSON.stringify(started.allowedTools) === JSON.stringify(['read_file']) },
            { id: 'idempotent-replay-correlated', passed: source.replayResult?.requestId === source.replay.requestId && source.replayResult?.success === false },
            { id: 'late-effect-prevented', passed: !existsSync(join(root, 'late-effect.txt')) },
        ]
        report.success = report.checks.every(check => check.passed)
        writeJson(join(root, 'report.json'), report)
        console.log(JSON.stringify(report, null, 2))
        if (!report.success) throw new Error('mesh agent cancellation acceptance failed')
    } catch (error) {
        report.error = String(error)
        writeJson(join(root, 'report.json'), report)
        if (!existsSync(join(root, 'source-done.json'))) writeJson(join(root, 'source-done.json'), { done: true, failed: true })
        throw error
    } finally {
        if (!process.env.XAVENTRA_MESH_AGENT_QA_DIR) rmSync(root, { recursive: true, force: true })
    }
}

if (phase) await child()
else await parent()
