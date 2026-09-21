import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const localQaRoot = join(root, '.nova-data', 'outcome-router-qa-local')
mkdirSync(localQaRoot, { recursive: true })
const qaDir = process.env.XAVENTRA_OUTCOME_ROUTER_QA_DIR || mkdtempSync(join(localQaRoot, 'run-'))
const phase = process.argv[2]
const sampleFile = join(qaDir, 'samples.json')
const ledgerDir = join(qaDir, 'ledger')

async function modules() {
  const [{ OutcomeRouter }, { OutcomeLedger }, { createTaskContract }] = await Promise.all([
    import('../dist/routing/outcome-router.js'),
    import('../dist/core/outcome-ledger.js'),
    import('../dist/core/task-contract.js'),
  ])
  return { OutcomeRouter, OutcomeLedger, createTaskContract }
}

function sample(index, overrides = {}) {
  return {
    runId: `production-${index}`,
    userId: 'alice',
    channel: 'telegram',
    taskType: 'coding',
    model: 'candidate',
    node: 'spark',
    success: true,
    durationMs: 100 + index,
    costUsd: 0.001,
    validatedAt: new Date(Date.now() + index).toISOString(),
    validationSource: 'nova-execution-kernel',
    evidenceRefs: [`tool-call:call-${index}:read_file`],
    ...overrides,
  }
}

if (phase === 'write') {
  const { OutcomeRouter, OutcomeLedger, createTaskContract } = await modules()
  const ledger = new OutcomeLedger(ledgerDir)
  const router = new OutcomeRouter(ledger, join(qaDir, 'writer-decisions.jsonl'), 'shadow', sampleFile)
  const accepted = Array.from({ length: 20 }, (_, index) => router.recordValidatedSample(sample(index))).filter(Boolean).length
  const belowThreshold = Array.from({ length: 19 }, (_, index) => router.recordValidatedSample(sample(100 + index, { userId: 'charlie' }))).filter(Boolean).length
  const rejected = [
    router.recordValidatedSample(sample(500, { channel: 'benchmark' })),
    router.recordValidatedSample(sample(501, { userId: 'synthetic:fixture' })),
    router.recordValidatedSample(sample(502, { evidenceRefs: ['response', 'current-turn-output-contract'] })),
  ]
  for (let index = 0; index < 20; index++) {
    const contract = createTaskContract(`self asserted ${index}`, { requiresTool: false, kind: 'none' })
    const runId = contract.id
    ledger.start(contract, { channel: 'telegram', userId: 'bob' })
    ledger.recordRoute(runId, { model: 'candidate', node: 'spark', taskType: 'coding' })
    ledger.recordValidation(runId, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(), success: true, awaitingApproval: false, criteria: [], violations: [] })
    ledger.completeValidated(runId, { success: true, durationMs: 1 })
  }
  writeFileSync(join(qaDir, 'write.json'), JSON.stringify({ accepted, belowThreshold, rejected, pid: process.pid }, null, 2))
  process.exit(accepted === 20 && belowThreshold === 19 && rejected.every(value => value === false) ? 0 : 1)
}

if (phase === 'read') {
  const { OutcomeRouter, OutcomeLedger } = await modules()
  const router = new OutcomeRouter(new OutcomeLedger(ledgerDir), join(qaDir, 'reader-decisions.jsonl'), 'active', sampleFile)
  const candidates = [{ model: 'candidate', node: 'spark', baseScore: 100 }]
  const baseline = { model: 'configured', node: 'main' }
  const alice = router.decide('coding', baseline, candidates, { userId: 'alice', channel: 'telegram' })
  const bob = router.decide('coding', baseline, candidates, { userId: 'bob', channel: 'telegram' })
  const charlie = router.decide('coding', baseline, candidates, { userId: 'charlie', channel: 'telegram' })
  const anonymous = router.decide('coding', baseline, candidates)
  const aggregate = router.getTrainingStatus()
  const result = {
    pid: process.pid,
    alice: { selected: alice.selected.model, eligible: alice.activationEligible },
    bob: { selected: bob.selected.model, eligible: bob.activationEligible },
    charlie: { selected: charlie.selected.model, eligible: charlie.activationEligible },
    anonymous: { selected: anonymous.selected.model, eligible: anonymous.activationEligible },
    aggregateActivationClosed: aggregate.cells.every(cell => cell.activationEligible === false),
  }
  writeFileSync(join(qaDir, 'read.json'), JSON.stringify(result, null, 2))
  const passed = result.alice.selected === 'candidate' && result.alice.eligible
    && result.bob.selected === 'configured' && !result.bob.eligible
    && result.charlie.selected === 'configured' && !result.charlie.eligible
    && result.anonymous.selected === 'configured' && !result.anonymous.eligible
    && result.aggregateActivationClosed
  process.exit(passed ? 0 : 1)
}

mkdirSync(qaDir, { recursive: true })
const childEnv = { ...process.env, XAVENTRA_OUTCOME_ROUTER_QA_DIR: qaDir, NODE_ENV: 'production', NOVA_OUTCOME_ROUTER_MIN_SAMPLES: '20', NOVA_OUTCOME_ROUTER_MIN_SUCCESSES: '15', NOVA_OUTCOME_ROUTER_MIN_SUCCESS_RATE: '0.75' }
let error
try {
  execFileSync(process.execPath, [import.meta.filename, 'write'], { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true, timeout: 60_000 })
  execFileSync(process.execPath, [import.meta.filename, 'read'], { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true, timeout: 60_000 })
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught)
}
const report = {
  version: 1,
  sourceRevision: (() => { try { return execFileSync('git', ['-c', `safe.directory=${root}`, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() } catch { return 'unknown' } })(),
  sourceDirty: (() => { try { return Boolean(execFileSync('git', ['-c', `safe.directory=${root}`, 'status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()) } catch { return true } })(),
  processStarts: 2,
  write: (() => { try { return JSON.parse(readFileSync(join(qaDir, 'write.json'), 'utf8')) } catch { return null } })(),
  read: (() => { try { return JSON.parse(readFileSync(join(qaDir, 'read.json'), 'utf8')) } catch { return null } })(),
  error,
  passed: !error,
  finishedAt: new Date().toISOString(),
}
writeFileSync(join(qaDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.passed ? 0 : 1)
