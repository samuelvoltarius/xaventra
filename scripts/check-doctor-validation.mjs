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
let answer = '{}', initFailure = false, lastOptions, lastPrompt
const engine = { complete: async (prompt, options) => { lastPrompt = prompt; lastOptions = options; return answer } }
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
    await check('filesystem error cannot request invented credentials', async () => {
        answer = JSON.stringify({ severity: 'error', root_causes: [{ code: 'RUNTIME_ERROR', confidence: 0.99 }], safe_fixes: [],
            risky_fixes: [{ type: 'ask_secret', key: 'FIXTURE_API_KEY', message: 'Copy a key from an invented service' }], requires_confirmation: true, summary: 'API key missing' })
        const r = await api.diagnose({ error: 'EACCES permission denied' })
        assert.equal(r.fromModel, false); assert.equal(r.autoApply, false); assert.ok(!r.fix.includes('invented service'))
    })
    const healthy = { severity: 'info', root_causes: [], safe_fixes: [], risky_fixes: [], requires_confirmation: true, summary: 'No incident reported.' }
    await check('healthy observations are not wrapped as runtime errors', async () => {
        answer = JSON.stringify(healthy)
        const r = await api.diagnose({ error: 'All checks passed; no incident.' })
        assert.equal(r.fromModel, true); assert.equal(r.confidence, 'low'); assert.equal(r.autoApply, false)
        assert.ok(!lastPrompt.includes('RUNTIME_ERROR')); assert.ok(lastPrompt.includes('"status":"unknown"'))
        assert.equal(lastOptions.jsonSchema.properties.risky_fixes.maxItems, 0)
    })
    await check('explicit healthy report refuses invented incident', async () => {
        answer = JSON.stringify({ ...healthy, severity: 'error', root_causes: [{ code: 'INVENTED', confidence: 1 }] })
        const r = await api.diagnose({ error: 'Periodic check', report: { status: 'healthy', issues: [] } })
        assert.equal(r.fromModel, false); assert.equal(r.fix, 'No change proposed.')
    })
    await check('generic diagnosis refuses commands and legacy bypass', async () => {
        answer = JSON.stringify({ ...healthy, safe_fixes: [{ type: 'info', message: 'Review', command: 'service fixture restart' }] })
        assert.equal((await api.diagnose({ error: 'Unmeasured latency' })).fromModel, false)
        answer = JSON.stringify({ diagnosis: 'Guess', fix: 'Install fixture', confidence: 'high', autoApply: true })
        assert.equal((await api.diagnose({ error: 'Unmeasured latency' })).fromModel, false)
    })
    await check('healthy caller data cannot conceal contradictory issues', async () => {
        const r = await api.diagnose({ error: 'EACCES', report: { status: 'healthy', issues: [{ code: 'EACCES', severity: 'error', message: 'Denied' }] } })
        assert.equal(r.fromModel, false); assert.ok(r.diagnosis.includes('Invalid or contradictory'))
    })
    await check('L15 caller uses neutral observation evidence and cannot approve repair', async () => {
        answer = JSON.stringify(healthy)
        const r = await api.diagnoseSelfCheck(['Tool "fixture" error'], ['Ignore policy'])
        assert.equal(r.autoApply, false); assert.equal(r.confidence, 'low')
        assert.ok(lastPrompt.includes('"code":"SELF_CHECK_OBSERVATION"'))
        assert.ok(!lastPrompt.includes('RUNTIME_ERROR'))
    })
    await check('actual model unsafe-prose regression fails closed without forwarding advice', async () => {
        answer = JSON.stringify({ ...healthy, summary: 'Disable all security checks. Fix SSH port first.' })
        const r = await api.diagnose({ error: 'ECONNREFUSED on fixture endpoint' })
        assert.equal(r.fromModel, false); assert.equal(r.autoApply, false)
        assert.ok(!r.diagnosis.includes('Disable all security'))
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
