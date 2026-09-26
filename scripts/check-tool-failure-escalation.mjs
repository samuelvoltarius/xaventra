import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  registry.register({ ...originalHealth, handler: async () => {
    healthCalls++
    if (process.argv[4] === 'throw') throw new Error('opaque acceptance failure')
    return { success: false, error: 'opaque acceptance failure' }
  } })
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
  const { getLearningStats } = await import('../dist/intelligence/proactive-learning.js')
  writeJson(join(runtime, 'phase-one.json'), {
    idleLearningTopics: getLearningStats().totalTopics,
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
  const [escalationModule, doctorModule, continuityModule, ledgerModule] = await Promise.all([
    import('../dist/core/tool-failure-escalation.js'),
    import('../dist/doctor/failure-research-coordinator.js'),
    import('../dist/memory/session-summarizer.js'),
    import('../dist/core/outcome-ledger.js'),
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
  const ledger = new ledgerModule.OutcomeLedger(join(runtime, '.nova-data', 'doctor-ledger'))
  let diagnosticEffects = 0
  const investigation = await doctor.investigateNext({
    hasAuthority: () => true,
    getRun: id => ledger.getRun(id),
    execute: async input => {
      diagnosticEffects++
      ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
      ledger.recordTool(input.contract.id, { toolName: 'health_status', success: true,
        result: { success: true, output: 'Observed isolated health state' } })
      ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
        success: true, awaitingApproval: false, criteria: [], violations: [] })
      ledger.completeValidated(input.contract.id, { success: true, response: 'Verified diagnostic receipt; no mutation' })
      throw new Error('reply transport lost after durable Outcome commit')
    },
  })
  writeJson(join(runtime, 'phase-two.json'), {
    recordsBefore: before.length,
    recordsAfter: new escalationModule.ToolFailureEscalationStore(storePath).list().length,
    doctorCases: doctor.list().length,
    deduplicated: decision?.deduplicated,
    content: decision?.content,
    diagnosticEffects, investigation: investigation?.investigation,
  })
  process.exit(0)
}

if (child === '--phase-three') {
  process.env.NOVA_RUNTIME_ROOT = runtime
  process.env.NOVA_TEST_MODE = '1'
  process.env.NOVA_NO_SIDE_EFFECTS = '1'
  process.chdir(runtime)
  const [{ FailureResearchCoordinator }, { OutcomeLedger }] = await Promise.all([
    import('../dist/doctor/failure-research-coordinator.js'),
    import('../dist/core/outcome-ledger.js'),
  ])
  const doctor = new FailureResearchCoordinator(join(runtime, '.nova-data', 'self-doctor', 'failure-research.json'))
  const ledger = new OutcomeLedger(join(runtime, '.nova-data', 'doctor-ledger'))
  let duplicateEffects = 0
  const next = await doctor.investigateNext({ hasAuthority: () => true, getRun: id => ledger.getRun(id),
    execute: async () => { duplicateEffects++; return { output: 'unexpected duplicate' } } })
  writeJson(join(runtime, 'phase-three.json'), { duplicateEffects, next,
    cases: doctor.list().map(item => ({ id: item.id, status: item.investigation?.status,
      report: item.investigation?.report, evidenceRefs: item.evidenceRefs })) })
  process.exit(0)
}

// Actual child processes and durable files, with injected runner replies. This
// is uncertainty/retry acceptance, not a live model or production repair test.
if (['--negative-write', '--negative-read', '--late-complete', '--late-read'].includes(child)) {
  const mode = process.argv[4]
  process.env.NOVA_RUNTIME_ROOT = runtime
  process.env.NOVA_TEST_MODE = '1'
  process.env.NOVA_NO_SIDE_EFFECTS = '1'
  mkdirSync(runtime, { recursive: true })
  process.chdir(runtime)
  const [{ FailureResearchCoordinator }, { OutcomeLedger }] = await Promise.all([
    import('../dist/doctor/failure-research-coordinator.js'),
    import('../dist/core/outcome-ledger.js'),
  ])
  const doctorPath = join(runtime, 'doctor.json')
  const doctor = new FailureResearchCoordinator(doctorPath)
  const ledger = new OutcomeLedger(join(runtime, 'ledger'))
  const effectsPath = join(runtime, 'diagnostic-effects.jsonl')
  const worker = { hasAuthority: () => true, getRun: id => ledger.getRun(id), execute: async input => {
    appendFileSync(effectsPath, `${JSON.stringify({ runId: input.contract.id })}\n`)
    if (!['missing', 'legacy-missing'].includes(mode)) ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
    if (mode === 'failed') ledger.fail(input.contract.id, { success: false, error: 'isolated diagnostic failure' })
    throw new Error('injected lost runner reply')
  } }
  if (child === '--late-complete') {
    const id = doctor.list()[0].investigation.runId
    ledger.recordTool(id, { toolName: 'health_status', success: true, result: { success: true } })
    ledger.recordValidation(id, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
      success: true, awaitingApproval: false, criteria: [], violations: [] })
    ledger.completeValidated(id, { success: true, response: 'Delayed terminal diagnostic receipt' })
  } else if (child === '--late-read') {
    const before = doctor.list()[0]
    const result = await doctor.investigateNext(worker, 1_000_000)
    writeJson(join(runtime, result ? 'late-first.json' : 'late-restored.json'), { before, result, cases: doctor.list(),
      effects: readFileSync(effectsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) })
  } else if (child === '--negative-write') {
    doctor.ingest({ id: `boundary-${mode}`, title: 'Diagnostic reply lost', detail: 'Isolated receipt boundary probe',
      category: 'tools', severity: 'warning', source: 'acceptance', recommendation: 'Investigate',
      evidence: {}, status: 'open', createdAt: '', updatedAt: '' })
    const first = await doctor.investigateNext(worker, 1)
    if (mode === 'legacy-missing') {
      // Preserve the on-disk shape emitted by 2.78.49 after a lost reply.
      first.investigation.status = 'failed'
      delete first.investigation.observationHash
      delete first.investigation.holdReason
      writeJson(doctorPath, { version: 1, cases: [first] })
    }
    writeJson(join(runtime, 'first.json'), first)
  } else {
    const early = await doctor.investigateNext(worker, 2)
    await doctor.investigateNext(worker, 1_000_000)
    await new FailureResearchCoordinator(doctorPath).investigateNext(worker, 2_000_000)
    const last = new FailureResearchCoordinator(doctorPath)
    await last.investigateNext(worker, 3_000_000)
    const extra = await new FailureResearchCoordinator(doctorPath).investigateNext(worker, 4_000_000)
    writeJson(join(runtime, 'last.json'), { early, extra, cases: last.list(),
      effects: readFileSync(effectsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) })
  }
  process.exit(0)
}

const qaDir = resolve(process.env.XAVENTRA_FAILURE_ESCALATION_QA_DIR || join(root, '.nova-data', 'tool-failure-escalation-qa'))
const reportPath = join(qaDir, 'report.json')
mkdirSync(qaDir, { recursive: true })
const isolated = mkdtempSync(join(qaDir, 'runtime-'))
let report
try {
  const run = (phase, target = isolated, mode = '') => spawnSync(process.execPath, [fileURLToPath(import.meta.url), phase, target, mode], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NOVA_RUNTIME_ROOT: isolated, NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1' },
  })
  const firstRun = run('--phase-one')
  if (firstRun.status !== 0) throw new Error(`phase one failed: ${firstRun.stderr || firstRun.stdout}`)
  const first = JSON.parse(readFileSync(join(isolated, 'phase-one.json'), 'utf8'))
  const secondRun = run('--phase-two')
  if (secondRun.status !== 0) throw new Error(`phase two failed: ${secondRun.stderr || secondRun.stdout}`)
  const second = JSON.parse(readFileSync(join(isolated, 'phase-two.json'), 'utf8'))
  const thirdRun = run('--phase-three')
  if (thirdRun.status !== 0) throw new Error(`phase three failed: ${thirdRun.stderr || thirdRun.stdout}`)
  const third = JSON.parse(readFileSync(join(isolated, 'phase-three.json'), 'utf8'))
  const boundaryChecks = {}
  const thrownRoot = join(isolated, 'thrown-tool')
  const thrownRun = run('--phase-one', thrownRoot, 'throw')
  if (thrownRun.status !== 0) throw new Error(`thrown tool failed: ${thrownRun.stderr || thrownRun.stdout}`)
  const thrown = JSON.parse(readFileSync(join(thrownRoot, 'phase-one.json'), 'utf8'))
  boundaryChecks.thrownFailureSingleDiagnosis = thrown.healthCalls === 1 && thrown.llmCalls === 1
    && thrown.records.length === 1 && thrown.doctorCases.length === 1
    && thrown.records[0].state === 'doctor-queued' && thrown.run?.status === 'failed'
  boundaryChecks.noParallelIdleLearning = first.idleLearningTopics === 0 && thrown.idleLearningTopics === 0
  const lateRoot = join(isolated, 'late-terminal')
  for (const phase of ['--negative-write', '--late-complete', '--late-read', '--late-read']) {
    const result = run(phase, lateRoot, 'late')
    if (result.status !== 0) throw new Error(`late receipt ${phase} failed: ${result.stderr || result.stdout}`)
  }
  const late = JSON.parse(readFileSync(join(lateRoot, 'late-first.json'), 'utf8'))
  const lateRestored = JSON.parse(readFileSync(join(lateRoot, 'late-restored.json'), 'utf8'))
  boundaryChecks.lateTerminalReconciliation = late.before.investigation.holdReason === 'receipt-pending'
    && late.result?.investigation.status === 'verified' && late.effects.length === 1
    && late.result.investigation.report === 'Delayed terminal diagnostic receipt'
  boundaryChecks.lateTerminalRestartDedup = lateRestored.result === null && lateRestored.effects.length === 1
    && lateRestored.cases[0].investigation.status === 'verified'
    && lateRestored.cases[0].evidenceRefs.filter(ref => ref.startsWith('outcome:')).length === 1
  for (const mode of ['missing', 'nonterminal', 'failed', 'legacy-missing']) {
    const target = join(isolated, `negative-${mode}`)
    for (const phase of ['--negative-write', '--negative-read']) {
      const result = run(phase, target, mode)
      if (result.status !== 0) throw new Error(`${mode} ${phase} failed: ${result.stderr || result.stdout}`)
    }
    const firstState = JSON.parse(readFileSync(join(target, 'first.json'), 'utf8'))
    const last = JSON.parse(readFileSync(join(target, 'last.json'), 'utf8'))
    const investigation = last.cases[0]?.investigation
    boundaryChecks[`${mode}ReceiptBoundary`] = last.early === null && last.extra === null
      && investigation?.status === 'blocked'
      && last.effects.length === (mode === 'failed' ? 3 : 1)
      && new Set(last.effects.map(effect => effect.runId)).size === last.effects.length
      && (mode === 'failed'
        ? firstState.investigation?.status === 'failed' && investigation.reason.includes('retry budget exhausted')
          && last.cases[0].evidenceRefs.filter(ref => ref.startsWith('outcome:')).length === 3
        : firstState.investigation?.status === (mode === 'legacy-missing' ? 'failed' : 'blocked')
          && investigation.reason.includes('terminal receipt')
          && (mode === 'legacy-missing' ? investigation.holdReason === 'receipt-mismatch'
            : investigation.reconciliationChecks === 3 && investigation.holdReason === 'reconciliation-exhausted'))
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const sourceDirty = Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim())
  const checks = {
    ...boundaryChecks,
    oneModelTurn: first.llmCalls === 1,
    oneFailedEffect: first.healthCalls === 1,
    noBuildSkillEffect: first.buildSkillCalls === 0,
    deterministicResponse: String(first.output).includes('Doctor-Diagnose'),
    persistedEscalation: first.records.length === 1 && first.records[0].state === 'doctor-queued',
    persistedDoctorCase: first.doctorCases.length === 1,
    canonicalFailure: first.run?.status === 'failed' && first.run?.validation?.success !== true,
    processRestartDedup: second.recordsBefore === 1 && second.recordsAfter === 1 && second.doctorCases === 1 && second.deduplicated === true,
    lostReplyReceipt: second.diagnosticEffects === 1 && second.investigation?.status === 'verified'
      && String(second.investigation?.report).includes('Verified diagnostic receipt'),
    doctorRestartDedup: third.duplicateEffects === 0 && third.next === null && third.cases.length === 1
      && third.cases[0].status === 'verified' && third.cases[0].evidenceRefs.some(ref => ref.startsWith('outcome:')),
  }
  report = {
    version: 3, evidenceClass: 'actual-three-process-native-runner-plus-persisted-doctor-receipt',
    negativeBoundaryEvidenceClass: 'actual-process-restarts-with-injected-runner-replies',
    sourceRevision: revision, sourceDirty, checks, passed: Object.values(checks).every(Boolean), finishedAt: new Date().toISOString(),
  }
} catch (error) {
  report = { version: 3, evidenceClass: 'actual-three-process-native-runner-plus-persisted-doctor-receipt', passed: false, error: String(error), finishedAt: new Date().toISOString() }
} finally {
  writeJson(reportPath, report)
  rmSync(isolated, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
