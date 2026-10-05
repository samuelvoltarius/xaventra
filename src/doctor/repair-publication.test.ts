import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { beforeAll, it, expect, vi } from 'vitest'
import { RepairPublication, normalizedRepairPatch } from './repair-publication.js'
import { repairHash, signRepairValue, verifyRepairValue } from './repair-activation.js'
import { readPatchSnapshot, createPatchCandidate, patchSnapshotHash, repairDependencyHash } from '../synthesis/patch-sandbox.js'

const keys = () => { const k = generateKeyPairSync('ed25519'); return { private: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), public: k.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
const patchRequest = () => ({ file: 'src/value.ts', description: 'repair', search: 'value = 1', replace: 'value = 2', reproductionTest: 'src/original.test.ts', repairProfileId: 'p' })

// Cause of the former full-suite timeout (INT-11): every fixture spawned ~8
// synchronous git processes (init/add for the input repo, ls-files for the
// snapshot, init/add/commit/ls-files for the enrolled mirror). execFileSync
// blocks the worker, and process creation on Windows under full-suite load
// regularly took several seconds, so the 5 s default was exceeded before the
// code under test even ran. The git-backed input repo and the enrolled store
// are now built ONCE and copied per test (plain file copies, no spawns); each
// test still gets its own independent directories, keys and builder.
let template: { source: string; store: string; baselineHash: string; candidateHash: string }
// A successful publish materializes the candidate mirror with real git
// (init/add/commit/ls-files) inside the code under test; that is the behavior
// being verified, so those two tests get an explicit budget for four blocking
// process spawns under full-suite load instead of the 5 s default.
const GIT_MATERIALIZATION_TIMEOUT_MS = 30_000
beforeAll(() => {
    const root = join(process.cwd(), '.nova-data', `repair-publication-template-${randomUUID()}`), source = join(root, 'input'); mkdirSync(join(source, 'src'), { recursive: true })
    for (const [file, value] of Object.entries({ 'package.json': '{"type":"module"}', 'package-lock.json': '{}', 'tsconfig.json': '{}', 'vitest.config.ts': 'export default {}', 'xaventra.config.example.json': '{}',
        'src/value.ts': 'export const value = 1;', 'src/original.test.ts': 'immutable original oracle' })) writeFileSync(join(source, file), value)
    execFileSync('git', ['init', '-q'], { cwd: source }); execFileSync('git', ['add', '.'], { cwd: source })
    const baseline = readPatchSnapshot(source), candidate = createPatchCandidate(baseline, patchRequest())
    const store = join(root, 'store')
    const enrollKeys = keys()
    new RepairPublication({ root: store, signingPrivateKey: enrollKeys.private, signingPublicKey: enrollKeys.public, receiptPublicKey: enrollKeys.public,
        builder: { build: async () => { throw Error('template never builds') } }, profiles: [] } as any).enroll(source, 'old')
    template = { source, store, baselineHash: patchSnapshotHash(baseline), candidateHash: patchSnapshotHash(candidate) }
}, 60_000) // one-time real git process setup; see comment above
function fixture() {
    const root = join(process.cwd(), '.nova-data', randomUUID()), source = join(root, 'input'), store = join(root, 'store')
    cpSync(template.source, source, { recursive: true }); cpSync(template.store, store, { recursive: true })
    const patch = patchRequest()
    const binding = { proposalId: 'proposal', patchHash: repairHash(normalizedRepairPatch(patch)), baselineHash: template.baselineHash, candidateHash: template.candidateHash, targetId: 'fixture', probeId: 'answer' }
    const release = keys(), controller = keys()
    const builder = { build: vi.fn(async () => ({ imageId: 'sha256:' + 'a'.repeat(64), baseImageId: 'sha256:' + 'b'.repeat(64), compiledHash: 'c'.repeat(64),
        sandbox: { verified: true, buildPassed: true, testsPassed: true, cleanupVerified: true, rollbackPassed: true, recoveryPassed: true, reproductionPassed: true, baselineHash: binding.baselineHash, candidateHash: binding.candidateHash, output: 'explicit fixture adapter' } })) }
    const options = { root: store, signingPrivateKey: release.private, signingPublicKey: release.public, receiptPublicKey: controller.public,
        builder, profiles: [{ id: 'p', file: patch.file, reproductionTest: patch.reproductionTest, targetId: 'fixture', probeId: 'answer' }] }
    const publisher = new RepairPublication(options)
    const index = () => JSON.parse(readFileSync(join(store, 'current.json'), 'utf8'))
    return { root, source, store, patch, binding, builder, publisher, options, index, release, controller }
}
it('publishes a clean source copy and signed artifact without advancing live source; replay does not rebuild', async () => {
    const f = fixture(), signed = await f.publisher.publish(f.binding, f.patch), artifact = verifyRepairValue(signed, f.release.public)
    expect(artifact.sourceHash).toBe(f.binding.candidateHash)
    expect(f.index().sourceHash).toBe(f.binding.baselineHash)
    expect(readFileSync(join(f.source, f.patch.file), 'utf8')).toContain('value = 1')
    const mirror = join(f.store, 'sources', f.binding.candidateHash)
    if (process.platform === 'win32') expect(execFileSync('git', ['config', '--local', 'core.longpaths'], { cwd: mirror, encoding: 'utf8' }).trim()).toBe('true')
    expect(readFileSync(join(mirror, f.patch.reproductionTest), 'utf8')).toBe('immutable original oracle')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: mirror, encoding: 'utf8' }).trim()).toBe('')
    expect(await f.publisher.publish(f.binding, f.patch)).toEqual(signed)
    expect(f.builder.build).toHaveBeenCalledOnce()
}, GIT_MATERIALIZATION_TIMEOUT_MS)
it.each(['patch', 'profile', 'candidate', 'baseline'])('rejects wrong %s before invoking compiler', async kind => {
    const f = fixture()
    const binding = { ...f.binding }, patch = { ...f.patch }
    if (kind === 'patch') patch.replace = 'value = 3'
    if (kind === 'profile') binding.targetId = 'other'
    if (kind === 'candidate') binding.candidateHash = 'd'.repeat(64)
    if (kind === 'baseline') binding.baselineHash = 'd'.repeat(64)
    await expect(f.publisher.publish(binding, patch)).rejects.toThrow()
    expect(f.builder.build).not.toHaveBeenCalled(); expect(f.index().sourceHash).toBe(f.binding.baselineHash)
})
it('retains crash ownership if build output is uncertain; cannot sign invented success', async () => {
    const f = fixture(); f.builder.build.mockRejectedValue(Error('ambiguous engine reply'))
    await expect(f.publisher.publish(f.binding, f.patch)).rejects.toThrow()
    expect(existsSync(join(f.store, 'publication.lock'))).toBe(true)
    await expect(new RepairPublication(f.options).publish(f.binding, f.patch)).rejects.toThrow()
    expect(f.builder.build).toHaveBeenCalledOnce()
})
it('advances source only after independent original-symptom receipt, not signed failed/foreign evidence', async () => {
    const f = fixture(), artifact = verifyRepairValue(await f.publisher.publish(f.binding, f.patch), f.release.public)
    const observation = { probeId: 'answer', targetId: 'fixture', challenge: randomUUID(), observedAt: Date.now(), state: 'fault' as const, fingerprint: 'original', releaseId: 'old' }
    const receipt = { binding: { ...f.binding, attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 }, status: 'resolved' as const,
        releaseId: artifact.releaseId, previousReleaseId: 'old', updatedAt: Date.now(), before: observation,
        after: { ...observation, state: 'healthy' as const, challenge: randomUUID(), releaseId: artifact.releaseId } }
    expect(() => f.publisher.commitSource(signRepairValue(receipt, f.release.private))).toThrow()
    expect(() => f.publisher.commitSource(signRepairValue({ ...receipt, status: 'blocked' }, f.controller.private))).toThrow()
    expect(() => f.publisher.commitSource(signRepairValue({ ...receipt, after: { ...receipt.after, releaseId: 'wrong' } }, f.controller.private))).toThrow()
    f.publisher.commitSource(signRepairValue(receipt, f.controller.private))
    expect(f.index().sourceHash).toBe(f.binding.candidateHash)
    expect(() => f.publisher.commitSource(signRepairValue(receipt, f.controller.private))).not.toThrow()
}, GIT_MATERIALIZATION_TIMEOUT_MS)
it('binds automatic Core/Desktop version bumps while retaining exact dependencies and oracle', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
    const baseline: any = { 'src/v.ts': Buffer.from('old').toString('base64'), 'CHANGELOG.md': Buffer.from('history').toString('base64') }
    for (const file of ['package.json', 'desktop/package.json']) baseline[file] = encode({ name: file === 'package.json' ? '@xaventra/core' : '@xaventra/desktop', version: '2.78.18' })
    for (const file of ['package-lock.json', 'desktop/package-lock.json']) baseline[file] = encode({ version: '2.78.18', packages: { '': { version: '2.78.18' }, 'node_modules/p': { integrity: 'pinned' } } })
    const candidate = createPatchCandidate(baseline, { file: 'src/v.ts', search: 'old', replace: 'new' })
    for (const file of ['package.json', 'desktop/package.json', 'package-lock.json', 'desktop/package-lock.json']) expect(JSON.parse(Buffer.from(candidate[file], 'base64').toString()).version).toBe('2.78.19')
    expect(repairDependencyHash(Buffer.from(candidate['package-lock.json'], 'base64'))).toBe(repairDependencyHash(Buffer.from(baseline['package-lock.json'], 'base64')))
    const changed = JSON.parse(Buffer.from(candidate['package-lock.json'], 'base64').toString()); changed.packages['node_modules/p'].integrity = 'wrong'
    expect(repairDependencyHash(JSON.stringify(changed))).not.toBe(repairDependencyHash(Buffer.from(baseline['package-lock.json'], 'base64')))
})
