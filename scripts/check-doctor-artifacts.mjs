/** Compiled ESM acceptance. All writes in a unique temporary root. No daemon,
 * production config, credentials, or actions. Optional operator mirror download
 * tests real bytes separately; --inference exercises diagnosis only. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, truncateSync, copyFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const source = process.cwd()
const qaDir = process.env.XAVENTRA_DOCTOR_QA_DIR || tmpdir()
mkdirSync(qaDir, { recursive: true })
const root = mkdtempSync(join(qaDir, 'xaventra-doctor-'))
const report = { sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    version: JSON.parse(readFileSync('package.json')).version, platform: process.platform,
    scope: 'Compiled ESM artifact fixtures; not model quality, deployment or installed application acceptance', cases: [], root }
const load = file => import(pathToFileURL(join(source, 'dist', file)).href)
const config = value => writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(value))
async function check(name, fn) {
    try { await fn(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
    catch (error) { report.cases.push({ name, passed: false, error: error.message }); throw error }
}
process.chdir(root)
delete process.env.XAVENTRA_DOCTOR_MODEL_MIRROR
delete process.env.GITHUB_TOKEN
mkdirSync('models')
let server, engine
try {
    const oldName = 'nova-doctor-0.5b-q2k.gguf'
    const path = join(root, 'models', oldName)
    writeFileSync(path, 'GGUF'); truncateSync(path, 338606976)
    config({ doctorModel: 'off' })
    engine = await load('llm/llama-engine.js')
    await check('doctorModel=off in native compiled ESM (exact-size present file)', () => assert.equal(engine.hasLocalModel(), false))
    renameSync(path, path + '.synthetic-fixture')
    const artifacts = await load('llm/doctor-artifacts.js')
    const downloader = await load('llm/download-models.js')
    const bytes = Buffer.from('GGUF-compiled-fixture-not-a-real-model')
    const model = { filename: 'fixture.gguf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sizeMB: 1, minRamGB: 0, quality: 1 }
    server = createServer((_req, res) => res.end(bytes))
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    config({ doctorModelMirror: `http://127.0.0.1:${server.address().port}` })
    await check('configured mirror is read by compiled ESM', async () => {
        await downloader.downloadModel(model)
        assert.deepEqual(readFileSync('models/fixture.gguf'), bytes)
    })
    await check('downloaded artifact is independently SHA-256 verified', () => artifacts.verifyDoctorArtifact('models/fixture.gguf', model))
    await check('invalid replacement preserves old artifact', async () => {
        writeFileSync('models/fixture.gguf', 'old-artifact')
        await assert.rejects(downloader.downloadModel({ ...model, sha256: '0'.repeat(64) }))
        assert.equal(readFileSync('models/fixture.gguf', 'utf8'), 'old-artifact')
    })
    await check('disabled compiled CLI returns failure without download', () => {
        config({ doctorModel: 'off' })
        const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
        assert.throws(() => execFileSync(process.execPath, [join(source, 'dist/llm/download-models.js')], { cwd: root, env, timeout: 10000, stdio: 'pipe' }), e => e.status === 1)
    })
    const mirrorIndex = process.argv.indexOf('--mirror')
    if (mirrorIndex >= 0) {
        const modelIndex = process.argv.indexOf('--model')
        const selected = artifacts.MODEL_REGISTRY.find(m => m.filename === process.argv[modelIndex + 1])
            || artifacts.MODEL_REGISTRY.find(m => m.filename === oldName)
        config({ doctorModelMirror: process.argv[mirrorIndex + 1], doctorModel: selected.filename })
        const importIndex = process.argv.indexOf('--artifact-file')
        if (importIndex >= 0) {
            await check('operator artifact import and full pinned SHA-256', async () => {
                copyFileSync(process.argv[importIndex + 1], join(root, 'models', selected.filename))
                await artifacts.verifyDoctorArtifact(join(root, 'models', selected.filename), selected)
            })
        } else await check('live HTTPS artifact download and full pinned SHA-256', () => downloader.downloadModel(selected, pct => { if (pct % 20 === 0) console.log(`Download ${pct}%`) }))
        await check('live downloaded model selected (not inference proof)', () => assert.equal(engine.hasLocalModel(), true))
        report.liveArtifact = { filename: selected.filename, sizeBytes: selected.sizeBytes, sha256: selected.sha256 }
        if (process.argv.includes('--inference')) {
            const doctor = await load('intelligence/doctor-client.js')
            const loaded = await engine.getLlamaEngine()
            if (loaded) {
                const complete = loaded.complete.bind(loaded)
                loaded.complete = async (...args) => {
                    const raw = await complete(...args)
                    // Synthetic input only. Retain diagnostic output privately,
                    // never include it in public CI artifacts automatically.
                    writeFileSync(join(root, 'synthetic-model-output.txt'), raw)
                    return raw
                }
            }
            await check('actual GGUF Doctor diagnosis: service unreachable, no auto-apply', async () => {
                const result = await doctor.diagnose({ error: 'ECONNREFUSED: connection to a local test service on port 12345 refused.', context: { scope: 'synthetic diagnosis only; no commands may be executed' } })
                report.diagnosis = { fromModel: result.fromModel, confidence: result.confidence, autoApply: result.autoApply }
                assert.equal(result.fromModel, true); assert.equal(result.autoApply, false)
                assert.match(result.diagnosis + ' ' + result.fix, /service|connect|port|dienst|verbind|erreich/i)
                const raw = readFileSync(join(root, 'synthetic-model-output.txt'), 'utf8')
                assert.doesNotMatch(raw, /12346|Google Cloud|DigitalOcean|choose_server_type|port.{0,32}(?:is in use|already in use)/i, 'Doctor must not invent replacement ports, bind conflicts or cloud migrations')
            })
            await engine.disposeLlamaEngine()
        }
    }
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally {
    if (engine) await engine.disposeLlamaEngine()
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`Doctor acceptance report: ${join(root, 'report.json')}`)
}
