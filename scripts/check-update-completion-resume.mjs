// Real child-process restart + durable filesystem fixture; NOT systemd or production proof.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { UpdateActivationController } from '../src/core/update-activation.ts'
import { signRepairValue } from '../src/doctor/repair-activation.ts'

if (process.argv[2] === 'child') {
    const root = process.argv[3], mode = process.argv[4]
    const signed = JSON.parse(readFileSync(join(root, 'ticket.json'), 'utf8'))
    const { attemptId, expiresAt, ...binding } = signed.payload
    const state = join(root, 'runtime.json')
    const read = () => JSON.parse(readFileSync(state, 'utf8'))
    const driver = {
        hasAuthority: async () => true, // Explicit fixture authority only.
        prepare: async () => ({ releaseId: 'new', previousReleaseId: 'old', binding }),
        beginMaintenance: async () => {},
        currentRelease: async () => read().release,
        activate: async () => writeFileSync(state, JSON.stringify({ release: 'new', activations: read().activations + 1 })),
        rollback: async () => { throw Error('Unexpected fixture rollback') },
    }
    const controller = new UpdateActivationController(root, readFileSync(join(root, 'public.pem'), 'utf8'), driver,
        async release => release, async () => { if (mode === 'interrupt') process.exit(23) })
    assert.equal((await controller.deploy(signed, {})).status, 'installed')
} else {
    const root = mkdtempSync(join(tmpdir(), 'xaventra-update-resume-'))
    const keys = generateKeyPairSync('ed25519')
    const ticket = { proposalId: 'upstream-fixture', targetId: 'fixture', probeId: 'fixture',
        patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64),
        attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 120_000 }
    writeFileSync(join(root, 'public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }))
    writeFileSync(join(root, 'ticket.json'), JSON.stringify(signRepairValue(ticket, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())))
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({ release: 'old', activations: 0 }))
    const run = mode => execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'child', root, mode], { timeout: 20_000, stdio: 'pipe' })
    let exit
    try { run('interrupt') } catch (error) { exit = error.status }
    assert.equal(exit, 23)
    assert.equal(existsSync(join(root, 'activation.lock')), true)
    run('resume')
    assert.equal(existsSync(join(root, 'activation.lock')), false)
    run('replay')
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')), { release: 'new', activations: 1 })
    const report = { evidenceClass: 'real-child-process-restart-filesystem-fixture-not-native-or-production',
        interruptedExit: exit, processes: 3, activations: 1, lockReleased: true, root }
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
}
