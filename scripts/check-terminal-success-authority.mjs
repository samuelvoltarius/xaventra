import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OutcomeLedger } from '../dist/core/outcome-ledger.js'
import { createTaskContract, validateTaskCompletion } from '../dist/core/task-contract.js'

const root = mkdtempSync(join(tmpdir(), 'xaventra-completion-authority-'))
const checks = []
const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) })

try {
    const ledger = new OutcomeLedger(join(root, 'ledger'), false)
    const contract = createTaskContract('Return a grounded response', { requiresTool: false, kind: 'none' })
    ledger.start(contract, { channel: 'acceptance', userId: 'disposable-owner', backend: 'native' })

    check('unvalidated success rejected', ledger.completeValidated(contract.id, { success: true }) === false)
    check('run remains non-terminal after rejection', ledger.getRun(contract.id)?.status === 'running')

    ledger.recordValidation(contract.id, {
        validator: 'model-self-check', validatedAt: new Date().toISOString(), success: true,
        awaitingApproval: false, criteria: [], violations: [],
    })
    check('spoofed validator rejected', ledger.completeValidated(contract.id, { success: true }) === false)

    const validation = validateTaskCompletion(contract, { response: 'Grounded response.' })
    ledger.recordValidation(contract.id, validation)
    check('canonical validation accepted', validation.validator === 'nova-execution-kernel' && validation.success)
    check('validated success committed exactly once', ledger.completeValidated(contract.id, { success: true }) === true)
    check('duplicate terminal success rejected', ledger.completeValidated(contract.id, { success: true }) === false)
    check('committed run is completed', ledger.getRun(contract.id)?.status === 'completed')

    const imported = new OutcomeLedger(join(root, 'imported'), false)
    imported.importEvent({
        version: 1, eventId: 'terminal-only', runId: 'foreign-run', type: 'run.completed',
        timestamp: new Date().toISOString(), payload: { success: true, sourceNode: 'foreign-worker' },
    })
    check('unvalidated imported success fails closed', imported.getRun('foreign-run')?.status === 'failed')
    check('unvalidated imported success is invalidated', imported.getRun('foreign-run')?.invalidated === true)

    const report = {
        evidenceClass: 'compiled-disposable-terminal-success-authority',
        version: '1', platform: process.platform, architecture: process.arch,
        checks, passed: checks.every(item => item.passed),
    }
    if (process.env.XAVENTRA_COMPLETION_QA_DIR) {
        mkdirSync(process.env.XAVENTRA_COMPLETION_QA_DIR, { recursive: true })
        writeFileSync(join(process.env.XAVENTRA_COMPLETION_QA_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log(JSON.stringify(report, null, 2))
    if (!report.passed) process.exitCode = 1
} finally {
    rmSync(root, { recursive: true, force: true })
}
