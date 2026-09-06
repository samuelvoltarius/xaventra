/** Actual local GGUF evaluation. No tools/actions or network download. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { DOCTOR_QUALITY_CASES, judgeDoctorPlan } from './doctor-quality-cases.mjs'
import { DOCTOR_GROUNDING_CASES } from './doctor-grounding-cases.mjs'
const project = process.cwd()
const i = process.argv.indexOf('--model-file')
if (i < 0 || !process.argv[i + 1]) throw new Error('Usage: node scripts/check-doctor-quality.mjs --model-file <pinned GGUF>')
const sourceModel = resolve(process.argv[i + 1])
const qaBase = process.env.XAVENTRA_DOCTOR_QA_DIR || tmpdir()
mkdirSync(qaBase, { recursive: true })
const root = mkdtempSync(join(qaBase, 'xaventra-doctor-quality-'))
const report = { schemaVersion: 1, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    version: JSON.parse(readFileSync('package.json')).version, platform: process.platform,
    scope: 'Actual GGUF diagnosis generation and runtime parser, authored synthetic cases, bounded pattern oracle; not repair execution, full product acceptance or model-training certification',
    generationContract: 'diagnosis-only-info-v1', baselineCases: 14, additionalCases: DOCTOR_GROUNDING_CASES.length,
    budget: { perCaseMaxTokens: 1200, perCaseTimeoutMs: 60000 }, cases: [], status: 'running' }
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
const load = file => import(pathToFileURL(join(project, 'dist', file)).href)
process.chdir(root)
delete process.env.XAVENTRA_DOCTOR_MODEL_MIRROR
delete process.env.GITHUB_TOKEN
writeFileSync('xaventra.config.json', JSON.stringify({ doctorModel: basename(sourceModel) }))
mkdirSync('models')
let engineApi
save()
try {
    const artifacts = await load('llm/doctor-artifacts.js')
    const selected = artifacts.MODEL_REGISTRY.find(m => m.filename === basename(sourceModel))
    if (!selected) throw new Error('Only a pinned catalogue GGUF can be evaluated')
    await artifacts.verifyDoctorArtifact(sourceModel, selected)
    copyFileSync(sourceModel, join('models', selected.filename))
    report.model = { filename: selected.filename, sha256: selected.sha256, sizeBytes: selected.sizeBytes }
    engineApi = await load('llm/llama-engine.js')
    const engine = await engineApi.getLlamaEngine()
    if (!engine) throw new Error('Verified model could not be loaded by native backend')
    report.hardware = engine.hardware
    const contract = await load('intelligence/doctor-contract.js')
    const { buildDiagnosePrompt } = await load('intelligence/doctor-client.js')
    for (const test of [...DOCTOR_QUALITY_CASES, ...DOCTOR_GROUNDING_CASES]) {
        const started = Date.now()
        const result = { id: test.id, schemaValid: false, runtimeAccepted: false, semanticPassed: false, findings: [] }
        try {
            const raw = await engine.complete(buildDiagnosePrompt({ error: test.error, report: test.report }), {
                systemPrompt: contract.DOCTOR_DIAGNOSIS_INSTRUCTIONS, jsonSchema: contract.DOCTOR_DIAGNOSIS_GRAMMAR,
                maxTokens: report.budget.perCaseMaxTokens, temperature: 0.05,
                signal: AbortSignal.timeout(report.budget.perCaseTimeoutMs),
            })
            // Only generated synthetic output; keep local, not in public reports.
            writeFileSync(join(root, `${test.id}.model-output.txt`), raw)
            const value = JSON.parse(raw)
            result.schemaValid = contract.DoctorFixPlanSchema.safeParse(value).success
            result.findings = judgeDoctorPlan(test, value)
            result.semanticPassed = result.findings.length === 0
            try { contract.parseDoctorDiagnosis(raw, { reportedError: test.error, diagnosisOnly: true, report: test.report }); result.runtimeAccepted = true }
            catch { result.findings.push('rejected_by_runtime_validator') }
        } catch { result.findings.push('generation_or_parse_failed') }
        result.durationMs = Date.now() - started
        result.passed = result.schemaValid && result.runtimeAccepted && result.semanticPassed
        report.cases.push(result); save()
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${test.id}: ${result.findings.join(', ') || 'bounded judge passed'}`)
    }
    report.status = 'completed'
    report.summary = { total: report.cases.length, passed: report.cases.filter(c => c.passed).length,
        baselinePassed: report.cases.slice(0, 14).filter(c => c.passed).length,
        additionalPassed: report.cases.slice(14).filter(c => c.passed).length,
        schemaValid: report.cases.filter(c => c.schemaValid).length,
        runtimeAccepted: report.cases.filter(c => c.runtimeAccepted).length,
        semanticPassed: report.cases.filter(c => c.semanticPassed).length,
        meanDurationMs: Math.round(report.cases.reduce((sum, c) => sum + c.durationMs, 0) / report.cases.length) }
    if (report.summary.passed !== report.summary.total) process.exitCode = 1
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1 }
finally { save(); if (engineApi) await engineApi.disposeLlamaEngine(); console.log(`Doctor quality report: ${join(root, 'report.json')}`) }
