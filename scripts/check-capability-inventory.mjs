// Actual compiled graph -> conversational projection -> setup planner -> restart.
// Enrolled-node/scanner INPUTS are synthetic. No remote scan, model or install.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const resume = process.argv[2] === '--resume'
const source = resume ? resolve(process.argv[3]) : process.cwd()
const load = relative => import(pathToFileURL(join(source, 'dist', relative)).href)
process.env.NOVA_TEST_MODE = '1'
process.env.NOVA_NO_SIDE_EFFECTS = '1'
process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
delete process.env.OPENAI_API_KEY
delete process.env.MINIMAX_API_KEY
let networkAttempts = 0
globalThis.fetch = async () => { networkAttempts++; throw new Error('No networking allowed in fixture inventory acceptance') }

if (resume) {
    const api = await load('mesh/capability-orchestrator.js')
    assert.equal(api.findBestCapability({ capability: 'llm', preferLocal: true, preferQuality: false }), null)
    assert.ok(!api.getCapabilityMap().includes('custom-chat'))
    assert.equal(networkAttempts, 0)
    console.log('PASS fresh process preserves runtime removal')
} else {
    const base = process.env.XAVENTRA_CAPABILITY_QA_DIR || tmpdir()
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'xaventra-capability-'))
    const report = {
        version: JSON.parse(readFileSync('package.json')).version, platform: process.platform,
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
        scope: 'Actual compiled APIs, graph/host metadata persistence and child-process restart; synthetic scanner/enrolled-node input; no live AI software, SSH execution, provider auth, installation or model inference',
        cases: [],
    }
    process.chdir(root)
    async function check(name, fn) {
        try { await fn(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
        catch (error) { report.cases.push({ name, passed: false, error: error.message }); process.exitCode = 1 }
    }
    try {
        const { getCapabilityGraph } = await load('mesh/capability-graph.js')
        const api = await load('mesh/capability-orchestrator.js')
        const graph = getCapabilityGraph()
        const request = { capability: 'llm', preferLocal: true, preferQuality: false }
        await check('empty boot does not invent a device or install command', async () => {
            await api.initCapabilityOrchestrator()
            assert.equal(api.findBestCapability(request), null)
            assert.ok(!api.suggestInstallation('stt').includes('jetson'))
        })
        const now = new Date().toISOString()
        const runtime = { id: 'runtime-chat', name: 'vLLM', type: 'llm', endpoint: 'http://192.0.2.10:8000',
            status: 'running', models: ['custom-chat', 'second-finetune'], capabilities: ['llm'],
            verifiedAt: now, verificationSource: 'probe' }
        await check('post-boot canonical discovery reaches chat and capability routing', () => {
            graph.upsertLocalRuntime('fixture-worker', 'fixture-worker', runtime)
            assert.equal(api.findBestCapability(request)?.nodeName, 'fixture-worker')
            const map = api.getCapabilityMap()
            assert.ok(map.includes('vLLM: custom-chat, second-finetune'))
            assert.ok(!map.includes('Ollama: custom-chat'))
            assert.ok(!api.getMissingCapabilities().includes('llm'))
        })
        await check('installed runtime is inventory, not an available endpoint', () => {
            graph.upsertLocalRuntime('fixture-worker', 'fixture-worker', { ...runtime, id: 'runtime-embed',
                name: 'Ollama', type: 'embeddings', capabilities: ['embedding'], models: ['embed-fixture'],
                endpoint: 'http://192.0.2.10:11434', status: 'installed' })
            assert.ok(api.getCapabilityMap().includes('installed'))
            assert.equal(api.findBestCapability({ ...request, capability: 'embedding' }), null)
            assert.equal(graph.findCandidates({ capability: 'embedding' }).length, 0)
            assert.ok(api.suggestInstallation('embedding').includes('bereits installiert'))
        })
        await check('setup keeps arbitrary model IDs attached to the right endpoint', async () => {
            const { runSelfSetupScan } = await load('core/self-setup-orchestrator.js')
            const state = await runSelfSetupScan({ skipNetwork: true, config: { nodes: [] },
                validation: { valid: true, errors: [], warnings: [] }, environment: { node: 'fixture' },
                voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
                gpu: { probeSkipped: true, activeBackend: 'cpu', bindings: [], errors: {} },
                capabilitySnapshot: graph.getSnapshot() })
            assert.deepEqual(state.llm.localCandidates, runtime.models.map(model => ({ node: 'fixture-worker', model, endpoint: runtime.endpoint })))
        })
        await check('read path does not write the graph or perform network discovery', () => {
            const file = join(root, '.nova-data', 'capability-graph.json')
            const before = statSync(file).mtimeMs
            for (let i = 0; i < 100; i++) { api.getCapabilityMap(); api.findBestCapability(request); api.getMissingCapabilities() }
            assert.equal(statSync(file).mtimeMs, before)
            assert.equal(networkAttempts, 0)
        })
        await check('explicit expiry immediately blocks both candidate APIs', () => {
            graph.upsertLocalRuntime('fixture-worker', 'fixture-worker', { ...runtime, expiresAt: now })
            assert.equal(api.findBestCapability(request), null)
            assert.equal(graph.findCandidates({ type: 'llm' }).length, 0)
        })
        await check('tombstones remove model evidence without a restart', () => {
            graph.merge({ version: 1, updatedAt: now, nodes: [], tombstones: [{ id: runtime.id, deletedAt: now }] })
            assert.ok(!api.getCapabilityMap().includes('custom-chat'))
            assert.equal(api.findBestCapability(request), null)
        })
        await check('fresh compiled process cannot resurrect removed models', () => {
            execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--resume', source], {
                cwd: root, env: process.env, timeout: 30_000, stdio: 'pipe', windowsHide: true,
            })
        })
        const hosts = await load('tools/ssh-tool-hosts.js')
        const host = { name: 'fixture', alias: [], ip: '192.0.2.10', user: 'operator', description: 'fixture', lastSeen: null }
        await check('compiled host writer persists references but never their secret values', () => {
            process.env.XAVENTRA_SSH_FIXTURE = 'synthetic-credential-marker'
            hosts.saveHosts({ hosts: [{ ...host, passwordEnv: 'XAVENTRA_SSH_FIXTURE' }] })
            assert.ok(!readFileSync('.nova-data/hosts.json', 'utf8').includes('synthetic-credential-marker'))
            assert.equal(hosts.resolveHostPassword(hosts.loadHosts().hosts[0]), 'synthetic-credential-marker')
            assert.throws(() => hosts.saveHosts({ hosts: [{ ...host, password: 'synthetic-credential-marker' }] }))
            assert.ok(!hosts.formatKnownHostsContext(hosts.loadHosts()).includes('XAVENTRA_SSH_FIXTURE'))
            delete process.env.XAVENTRA_SSH_FIXTURE
        })
        await check('compiled host writer preserves legacy files without silent credential migration', () => {
            const original = JSON.stringify({ hosts: [{ ...host, password: 'legacy-synthetic-marker' }] })
            writeFileSync('.nova-data/hosts.json', original)
            assert.throws(() => hosts.saveHosts({ hosts: [host] }), /migration/)
            assert.equal(readFileSync('.nova-data/hosts.json', 'utf8'), original)
            const prompt = hosts.formatKnownHostsContext(hosts.loadHosts())
            assert.ok(prompt.includes('keine Freigabe')); assert.ok(!prompt.includes('legacy-synthetic-marker'))
        })
    } catch (error) { report.error = error.message; process.exitCode = 1 }
    finally {
        report.networkAttempts = networkAttempts
        writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
        console.log(`Capability acceptance report: ${join(root, 'report.json')}`)
    }
}
