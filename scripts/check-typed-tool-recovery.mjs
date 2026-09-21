import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const qaDir = process.env.XAVENTRA_TYPED_RECOVERY_QA_DIR || join(root, '.nova-data', 'typed-recovery-qa-local')
mkdirSync(qaDir, { recursive: true })

const [{ ExecutionKernel }, { recoverTransientReadOnlyTool }] = await Promise.all([
  import('../dist/core/execution-kernel.js'),
  import('../dist/core/typed-tool-recovery.js'),
])

let recoverableRequests = 0
let persistentRequests = 0
const server = createServer((request, response) => {
  if (request.url === '/recoverable') {
    recoverableRequests++
    response.statusCode = recoverableRequests === 1 ? 503 : 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(recoverableRequests === 1
      ? { success: false, error: 'HTTP 503 service unavailable' }
      : { success: true, output: 'healthy' }))
    return
  }
  if (request.url === '/persistent') {
    persistentRequests++
    response.statusCode = 503
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ success: false, error: 'HTTP 503 service unavailable' }))
    return
  }
  response.statusCode = 404
  response.end()
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}`

async function actualProbe(path) {
  const response = await fetch(`${baseUrl}${path}`)
  return response.json()
}

function kernel(toolName) {
  return new ExecutionKernel('Read a health signal', {
    allowedChanges: { readOnly: true, externalSideEffects: false, allowedTools: [toolName] },
    budget: { timeoutMs: 10_000, maxToolCalls: 3 },
  })
}

let report
try {
  const recoverableKernel = kernel('health_status')
  const firstRecoverable = await actualProbe('/recoverable')
  const recovered = await recoverTransientReadOnlyTool({
    toolName: 'health_status',
    args: {},
    failure: firstRecoverable,
    kernel: recoverableKernel,
    nextCallId: () => 'recoverable-retry-1',
    execute: async () => actualProbe('/recoverable'),
  })

  const persistentKernel = kernel('health_status')
  const firstPersistent = await actualProbe('/persistent')
  const boundedFailure = await recoverTransientReadOnlyTool({
    toolName: 'health_status',
    args: {},
    failure: firstPersistent,
    kernel: persistentKernel,
    nextCallId: () => 'persistent-retry-1',
    execute: async () => actualProbe('/persistent'),
  })

  let mutationRetries = 0
  const mutationBlocked = await recoverTransientReadOnlyTool({
    toolName: 'run_command',
    args: { command: 'untrusted and never executed' },
    failure: { success: false, error: 'HTTP 503 service unavailable' },
    kernel: kernel('run_command'),
    nextCallId: () => 'must-not-run',
    execute: async () => { mutationRetries++; return { success: true } },
  })

  let unknownRetries = 0
  const unknownBlocked = await recoverTransientReadOnlyTool({
    toolName: 'health_status',
    args: {},
    failure: { success: false, error: 'unexpected invariant' },
    kernel: kernel('health_status'),
    nextCallId: () => 'must-not-run',
    execute: async () => { unknownRetries++; return { success: true } },
  })

  const passed = recoverableRequests === 2
    && recovered.success === true
    && recovered.reason === 'retry-verified'
    && Boolean(recoverableKernel.getVerifiedToolCallEvidence('recoverable-retry-1'))
    && persistentRequests === 2
    && boundedFailure.attempted === true
    && boundedFailure.success === false
    && boundedFailure.executions.length === 1
    && mutationRetries === 0
    && mutationBlocked.attempted === false
    && unknownRetries === 0
    && unknownBlocked.attempted === false

  report = {
    version: 1,
    evidenceClass: 'actual-loopback-http-plus-compiled-execution-kernel',
    sourceRevision: (() => { try { return execFileSync('git', ['-c', `safe.directory=${root}`, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() } catch { return 'unknown' } })(),
    sourceDirty: (() => { try { return Boolean(execFileSync('git', ['-c', `safe.directory=${root}`, 'status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()) } catch { return true } })(),
    recoverable: { requests: recoverableRequests, attempted: recovered.attempted, success: recovered.success, reason: recovered.reason, receiptVerified: Boolean(recoverableKernel.getVerifiedToolCallEvidence('recoverable-retry-1')) },
    persistent: { requests: persistentRequests, attempted: boundedFailure.attempted, success: boundedFailure.success, retries: boundedFailure.executions.length },
    unsafeMutation: { retries: mutationRetries, attempted: mutationBlocked.attempted },
    unknownFailure: { retries: unknownRetries, attempted: unknownBlocked.attempted },
    passed,
    finishedAt: new Date().toISOString(),
  }
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
}

writeFileSync(join(qaDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report?.passed ? 0 : 1)
