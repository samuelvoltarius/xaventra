/** Actual compiled Doctor API in an isolated VM module graph. The engine alone
 * is scripted: this proves wrapper validation, never native/model quality. */
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
if (!vm.SourceTextModule) throw new Error('Run with node --experimental-vm-modules scripts/check-doctor-validation.mjs')
const project = process.cwd(), base = process.env.XAVENTRA_DOCTOR_QA_DIR || tmpdir()
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'xaventra-doctor-validation-'))
const report = { sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    version: JSON.parse(readFileSync('package.json')).version, platform: process.platform,
    scope: 'Actual compiled Doctor API, scripted engine, isolated filesystem; no native inference or model-quality claim', cases: [] }
process.chdir(root)
const context = vm.createContext({ console, process, AbortSignal, Buffer, setTimeout, clearTimeout })
let answer = '{}', initFailure = false, lastOptions
const engine = { complete: async (_prompt, options) => { lastOptions = options; return answer } }
const cache = new Map()
function synthetic(identifier, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context, identifier })
    return module
}
async function linker(specifier, referencing) {
    if (specifier.endsWith('/llama-engine.js')) {
        if (!cache.has('scripted-engine')) cache.set('scripted-engine', synthetic('scripted-engine', {
            hasLocalModel: () => true,
            getLlamaEngine: async () => { if (initFailure) throw new Error('synthetic engine failure'); return engine },
        }))
        return cache.get('scripted-engine')
    }
    const id = specifier.startsWith('.') ? new URL(specifier, referencing.identifier).href : specifier
    if (cache.has(id)) return cache.get(id)
    const module = id.startsWith('file:')
        ? new vm.SourceTextModule(readFileSync(fileURLToPath(id), 'utf8'), { context, identifier: id })
        : synthetic(id, await import(id))
    cache.set(id, module)
    return module
}
const entry = pathToFileURL(join(project, 'dist/intelligence/doctor-client.js')).href
const module = new vm.SourceTextModule(readFileSync(fileURLToPath(entry), 'utf8'), { context, identifier: entry })
async function check(name, fn) {
    try { await fn(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`) }
    catch (error) { report.cases.push({ name, passed: false, error: error.message }); process.exitCode = 1 }
}
try {
    await module.link(linker); await module.evaluate()
    const api = module.namespace
    await check('empty review is unverified, not clean', async () => { const r = await api.reviewCode('fixture'); assert.equal(r.severity, 'warning'); assert.equal(r.verified, false) })
    await check('empty fix is absent', async () => assert.equal(await api.generateFix('fixture', 'error'), null))
    await check('contradictory review is rejected', async () => {
        answer = JSON.stringify({ issues: ['Bug'], suggestions: [], security: [], severity: 'ok' })
        assert.equal((await api.reviewCode('fixture')).fromModel, false)
    })
    await check('valid review remains advisory and carries its finding', async () => {
        answer = JSON.stringify({ issues: ['Fixture finding'], suggestions: [], security: [], severity: 'warning' })
        const r = await api.reviewCode('fixture'); assert.equal(r.fromModel, true); assert.equal(r.issues[0], 'Fixture finding'); assert.equal(r.verified, false)
        assert.ok(lastOptions.signal); assert.ok(lastOptions.jsonSchema)
    })
    await check('valid fix cannot grant model approval', async () => {
        answer = JSON.stringify({ fixedCode: 'return 2', explanation: 'Proposed change', safe: true })
        const r = await api.generateFix('return 1', 'fixture'); assert.equal(r.safe, false); assert.equal(r.fixedCode, 'return 2')
        assert.ok(lastOptions.signal); assert.ok(lastOptions.jsonSchema)
    })
    await check('initialization rejection returns diagnosis fallback', async () => {
        initFailure = true
        const r = await api.diagnose({ error: 'ECONNREFUSED synthetic failure' }); assert.equal(r.fromModel, false); assert.equal(r.autoApply, false)
    })
    await check('initialization rejection does not crash review/fix APIs', async () => {
        assert.equal((await api.reviewCode('fixture')).severity, 'warning'); assert.equal(await api.generateFix('fixture', 'error'), null)
    })
    await check('telemetry does not retain raw error data', async () => {
        const canary = 'synthetic-private-error-marker'
        await api.diagnose({ error: canary })
        const events = readFileSync('.nova-data/doctor-telemetry/usage.jsonl', 'utf8')
        assert.ok(!events.includes(canary)); assert.ok(!events.includes('errorPrefix')); assert.ok(events.includes('unverified'))
    })
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally { writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(`Doctor validation report: ${join(root, 'report.json')}`) }
