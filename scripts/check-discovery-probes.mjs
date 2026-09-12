// Actual HTTP and compiled scanner; disposable local services, not production AI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.cwd()
const load = path => import(pathToFileURL(join(source, 'dist', path)).href)
const base = process.env.XAVENTRA_DISCOVERY_QA_DIR || tmpdir()
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'xaventra-discovery-'))
const report = {
    version: JSON.parse(readFileSync('package.json')).version,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    platform: process.platform,
    scope: 'Compiled scanner, real isolated loopback HTTP; fixture AI and injected retry clock, not production or real-model acceptance',
    cases: [],
}
process.chdir(root)
process.env.NOVA_NO_SIDE_EFFECTS = '1'
process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
delete process.env.XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS
let requests = 0
const server = createServer((req, res) => {
    requests++
    if (req.url === '/stall') { res.writeHead(200); res.write('partial'); return }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/api/ready' }); res.end(); return }
    if (req.url === '/large') { res.end('x'.repeat(256 * 1024 + 1)); return }
    if (req.url === '/html') { res.end('<html>Shop ready=true</html>'); return }
    if (req.url === '/ready') { res.end('true'); return }
    res.writeHead(404); res.end('{"detail":"Not Found"}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`
async function check(name, fn) {
    try { await fn(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
    catch (error) { report.cases.push({ name, passed: false, error: error.message }); process.exitCode = 1 }
}
try {
    const { scanHost, AI_SERVICE_PROBES } = await load('mesh/ai-scanner.js')
    const { DiscoveryProbeClient } = await load('mesh/discovery-probe.js')
    const probe = { ...AI_SERVICE_PROBES.find(p => p.name === 'coqui-xtts'), defaultPort: port }
    await check('known foreign origin receives zero requests through actual scanner', async () => {
        process.env.XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS = origin
        assert.deepEqual(await scanHost('127.0.0.1', 'fixture', 1000, [probe]), [])
        assert.equal(requests, 0)
        delete process.env.XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS
    })
    await check('repeated real scanner invocations send one 404 probe, not one each', async () => {
        for (let i = 0; i < 4; i++) assert.deepEqual(await scanHost('127.0.0.1', 'fixture', 1000, [probe]), [])
        assert.equal(requests, 1)
    })
    await check('fresh process retains negative evidence without touching HTTP service', () => {
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            const { DiscoveryProbeClient } = await import(${JSON.stringify(pathToFileURL(join(source, 'dist/mesh/discovery-probe.js')).href)});
            const client = new DiscoveryProbeClient(${JSON.stringify(join(root, '.nova-data/ai-probe-backoff.json'))});
            let attempts = 0;
            globalThis.fetch = () => { attempts++; throw new Error('unexpected request') };
            assert.equal(await client.probe(${JSON.stringify(origin + '/api/ready')}), null);
            assert.equal(attempts, 0);
        `], { stdio: 'pipe' })
        assert.equal(requests, 1)
    })
    await check('real ready response is found while same-port HTML is rejected and cooled down', async () => {
        const html = { ...probe, healthEndpoint: '/html' }
        assert.deepEqual(await scanHost('127.0.0.1', 'fixture', 1000, [html]), [])
        const before = requests
        assert.deepEqual(await scanHost('127.0.0.1', 'fixture', 1000, [html]), [])
        assert.equal(requests, before)
        const result = await scanHost('127.0.0.1', 'fixture', 1000, [{ ...probe, healthEndpoint: '/ready' }])
        assert.equal(result.length, 1)
        assert.equal(result[0].name, 'coqui-xtts')
    })
    await check('expired negative evidence re-probes real HTTP (injected clock)', async () => {
        let now = Date.now()
        const client = new DiscoveryProbeClient(join(root, 'expiry.json'), () => now)
        await client.probe(origin + '/api/ready')
        const before = requests
        now += 5 * 60_000
        await client.probe(origin + '/api/ready')
        assert.equal(requests, before)
        now += 25 * 60_000
        await client.probe(origin + '/api/ready')
        assert.equal(requests, before + 1)
    })
    await check('headers do not cancel the response-body deadline', async () => {
        const client = new DiscoveryProbeClient(join(root, 'stall.json'))
        const start = Date.now()
        assert.equal(await client.probe(origin + '/stall', 250), null)
        assert.ok(Date.now() - start < 3000)
    })
    await check('oversized body is refused', async () => {
        const client = new DiscoveryProbeClient(join(root, 'large.json'))
        assert.equal(await client.probe(origin + '/large'), null)
    })
    await check('redirect does not reach a second endpoint', async () => {
        const client = new DiscoveryProbeClient(join(root, 'redirect.json'))
        const before = requests
        assert.equal(await client.probe(origin + '/redirect'), null)
        assert.equal(requests, before + 1)
    })
} finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    report.finishedAt = new Date().toISOString()
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`Report: ${join(root, 'report.json')}`)
}
