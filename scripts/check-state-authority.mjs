import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getStateMachine, resetStateMachine } from '../dist/core/state-machine.js'
import { getCoreRuntime } from '../dist/layers/L03-core-runtime.js'
import * as coreRuntimeModule from '../dist/layers/L03-core-runtime.js'

const checks = []
const check = (name, condition, details = {}) => {
  checks.push({ name, passed: Boolean(condition), ...details })
  if (!condition) throw new Error(`State authority acceptance failed: ${name}`)
}

resetStateMachine()
const state = getStateMachine()
const runtime = getCoreRuntime()
check('L03 shares the canonical state-machine instance', runtime.state === state)
check('legacy parallel NovaStateMachine export is absent', !('NovaStateMachine' in coreRuntimeModule))
resetStateMachine()
check('reset preserves the authority object observed by L03', getStateMachine() === state && runtime.state === state)

check('first request admitted', state.beginOperation('telegram:one', 'message:telegram'))
check('overlapping request admitted', state.beginOperation('desktop:two', 'message:desktop'))
check('two active operation leases visible', state.getStateInfo().activeOperations === 2)
check('runtime is busy during overlap', state.getState() === 'thinking')

check('first request completes once', state.completeOperation('telegram:one'))
check('first completion cannot declare idle', state.getState() === 'thinking' && state.getActiveOperationCount() === 1)
check('duplicate completion rejected', !state.completeOperation('telegram:one'))
check('legacy idle transition fenced while sibling active', !state.finish('legacy early completion'))

check('last request completes once', state.completeOperation('desktop:two'))
check('runtime returns idle only after final owner', state.getState() === 'idle' && state.getActiveOperationCount() === 0)

check('failed request admitted', state.beginOperation('telegram:failed'))
check('healthy sibling admitted', state.beginOperation('desktop:healthy'))
check('failure completion recorded', state.completeOperation('telegram:failed', 'scripted failure'))
check('failure does not cancel or idle healthy sibling', state.getState() === 'thinking' && state.hasOperation('desktop:healthy'))
check('healthy sibling completes', state.completeOperation('desktop:healthy'))
const terminalStates = state.getHistory(3).map(item => item.to)
check('terminal failure is reconciled once after drain', JSON.stringify(terminalStates) === JSON.stringify(['thinking', 'error', 'idle']), { terminalStates })

const report = {
  evidenceClass: 'compiled-single-process-overlapping-request-state-authority',
  version: '1',
  sourceRevision: process.env.GITHUB_SHA || null,
  platform: process.platform,
  architecture: process.arch,
  checks,
  passed: checks.every(item => item.passed),
}
const directory = resolve(process.env.XAVENTRA_STATE_QA_DIR || '.nova-data/state-authority-qa')
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
