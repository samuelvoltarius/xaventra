import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const child = process.argv[2]
const runtime = process.argv[3]

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

if (child === '--phase-one') {
  process.env.NOVA_RUNTIME_ROOT = runtime
  process.env.NOVA_TEST_MODE = '1'
  process.env.NOVA_NO_SIDE_EFFECTS = '1'
  process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
  mkdirSync(runtime, { recursive: true })
  copyFileSync(join(root, 'xaventra.config.example.json'), join(runtime, 'xaventra.config.json'))
  // Default runtime stores are cwd-relative. Move the child into its disposable
  // root before importing the compiled runtime so a prior QA run can never
  // satisfy this run from cached idempotency evidence.
  process.chdir(runtime)
  const [{ runNovaAgent }, { OutcomeLedger, withOutcomeLedger }, registryModule, escalationModule, doctorModule, continuityModule] = await Promise.all([
    import('../dist/agents/nova-runner.js'),
    import('../dist/core/outcome-ledger.js'),
    import('../dist/tools/complete-registry.js'),
    import('../dist/core/tool-failure-escalation.js'),
    import('../dist/doctor/failure-research-coordinator.js'),
    import('../dist/memory/session-summarizer.js'),
  ])
  const registry = registryModule.getToolRegistry()
  const originalHealth = registry.get('health_status')
  const originalBuild = registry.get('build_skill')
  let healthCalls = 0, buildSkillCalls = 0, llmCalls = 0
  registry.register({ ...originalHealth, handler: async () => { healthCalls++; return { success: false, error: 'opaque acceptance failure' } } })
  registry.register({ ...originalBuild, handler: async () => { buildSkillCalls++; return { success: true, output: 'must never execute' } } })
  const storePath = join(runtime, '.nova-data', 'recovery', 'tool-failure-escalations.json')
  const doctorPath = join(runtime, '.nova-data', 'self-doctor', 'failure-research.json')
  escalationModule.setToolFailureEscalationStore(new escalationModule.ToolFailureEscalationStore(storePath))
  doctorModule.setFailureResearchCoordinator(new doctorModule.FailureResearchCoordinator(doctorPath))
  continuityModule.setSessionContinuityStore(new continuityModule.SessionContinuityStore(join(runtime, '.nova-data', 'memory', 'continuity.json')))
  const contract = {
    id: 'acceptance-typed-failure-escalation', version: 1, goal: 'Collect current health evidence', createdAt: new Date().toISOString(),
    expectedArtifacts: [], requiredTests: [],
    successCriteria: [{ id: 'evidence', kind: 'verified_tool', required: true, description: 'Verified health evidence' }],
    allowedChanges: { readOnly: true, allowedPaths: [], allowedTools: ['health_status'], externalSideEffects: false },
    budget: { timeoutMs: 15_000, maxToolCalls: 1, maxOutputTokens: 500 }, approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
  }
  const llm = { modelId: 'scripted-acceptance', complete: async () => {
    llmCalls++
    return { content: '', toolCalls: [{ name: 'health_status', arguments: {} }], usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } }
  } }
  const ledger = new OutcomeLedger(join(runtime, '.nova-data', 'ledger'))
  const result = await withOutcomeLedger(ledger, () => runNovaAgent({
    userId: 'Nova-Autonomy', authUserId: 'Nova-Autonomy', channel: 'internal', conversationId: 'acceptance',
    content: contract.goal, contract, llm, tools: [{ name: 'health_status' }], systemPrompt: 'Acceptance fixture.',
  }))
  const store = new escalationModule.ToolFailureEscalationStore(storePath)
  writeJson(join(runtime, 'phase-one.json'), {
    output: result.content, llmCalls, healthCalls, buildSkillCalls,
    records: store.list(), doctorCases: new doctorModule.FailureResearchCoordinator(doctorPath).list(),
    run: ledger.getRun(contract.id),
  })
  process.exit(0)
}

if (child === '--phase-two') {
  process.env.NOVA_RUNTIME_ROOT = runtime
  process.env.NOVA_TEST_MODE = '1'
  process.env.NOVA_NO_SIDE_EFFECTS = '1'
  process.chdir(runtime)
  const [escalationModule, doctorModule, continuityModule] = await Promise.all([
    import('../dist/core/tool-failure-escalation.js'),
    import('../dist/doctor/failure-research-coordinator.js'),
    import('../dist/memory/session-summarizer.js'),
  ])
  const storePath = join(runtime, '.nova-data', 'recovery', 'tool-failure-escalations.json')
  const store = new escalationModule.ToolFailureEscalationStore(storePath)
  const before = store.list()
  const record = before[0]
  const doctor = new doctorModule.FailureResearchCoordinator(join(runtime, '.nova-data', 'self-doctor', 'failure-research.json'))
  const decision = escalationModule.escalateVerifiedToolFailures({
    principalId: 'Nova-Autonomy', runId: record.runId, request: 'Collect current health evidence',
    observations: [{ callId: record.callId, toolName: record.toolName, args: {}, failure: 'opaque acceptance failure' }],
  }, {
    store,
    doctor,
    continuity: new continuityModule.SessionContinuityStore(join(runtime, '.nova-data', 'memory', 'continuity.json')),
  })
  writeJson(join(runtime, 'phase-two.json'), {
    recordsBefore: before.length,
    recordsAfter: new escalationModule.ToolFailureEscalationStore(storePath).list().length,
    doctorCases: doctor.list().length,
    deduplicated: decision?.deduplicated,
    content: decision?.content,
  })
  process.exit(0)
}

const qaDir = resolve(process.env.XAVENTRA_FAILURE_ESCALATION_QA_DIR || join(root, '.nova-data', 'tool-failure-escalation-qa'))
const reportPath = join(qaDir, 'report.json')
mkdirSync(qaDir, { recursive: true })
const isolated = mkdtempSync(join(qaDir, 'runtime-'))
let report
try {
  const run = phase => spawnSync(process.execPath, [fileURLToPath(import.meta.url), phase, isolated], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NOVA_RUNTIME_ROOT: isolated, NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1' },
  })
  const firstRun = run('--phase-one')
  if (firstRun.status !== 0) throw new Error(`phase one failed: ${firstRun.stderr || firstRun.stdout}`)
  const first = JSON.parse(readFileSync(join(isolated, 'phase-one.json'), 'utf8'))
  const secondRun = run('--phase-two')
  if (secondRun.status !== 0) throw new Error(`phase two failed: ${secondRun.stderr || secondRun.stdout}`)
  const second = JSON.parse(readFileSync(join(isolated, 'phase-two.json'), 'utf8'))
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const sourceDirty = Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim())
  const checks = {
    oneModelTurn: first.llmCalls === 1,
    oneFailedEffect: first.healthCalls === 1,
    noBuildSkillEffect: first.buildSkillCalls === 0,
    deterministicResponse: String(first.output).includes('Doctor-Diagnose'),
    persistedEscalation: first.records.length === 1 && first.records[0].state === 'doctor-queued',
    persistedDoctorCase: first.doctorCases.length === 1,
    canonicalFailure: first.run?.status === 'failed' && first.run?.validation?.success !== true,
    processRestartDedup: second.recordsBefore === 1 && second.recordsAfter === 1 && second.doctorCases === 1 && second.deduplicated === true,
  }
  report = {
    version: 1, evidenceClass: 'actual-two-process-native-runner-plus-persisted-typed-escalation',
    sourceRevision: revision, sourceDirty, checks, passed: Object.values(checks).every(Boolean), finishedAt: new Date().toISOString(),
  }
} catch (error) {
  report = { version: 1, evidenceClass: 'actual-two-process-native-runner-plus-persisted-typed-escalation', passed: false, error: String(error), finishedAt: new Date().toISOString() }
} finally {
  writeJson(reportPath, report)
  rmSync(isolated, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
