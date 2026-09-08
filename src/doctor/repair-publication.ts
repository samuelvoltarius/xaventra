import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { patchSnapshotHash, readPatchSnapshot, validatePatchSnapshot, createPatchCandidate, type PatchSnapshot, type PatchSandboxResult } from '../synthesis/patch-sandbox.js'
import { repairHash, signRepairValue, verifyRepairValue, type RepairBinding, type RepairReceipt, type SignedRepairValue } from './repair-activation.js'

export interface RepairPatch { file: string; description: string; search: string; replace: string; reason?: string; reproductionTest?: string; repairProfileId?: string }
export function normalizedRepairPatch(p: RepairPatch) {
    return { file: p.file, description: p.description, search: p.search, replace: p.replace, reason: p.reason || '', reproductionTest: p.reproductionTest, repairProfileId: p.repairProfileId }
}
export interface PublishedRepair {
    version: 1; binding: RepairBinding; releaseId: string; previousReleaseId: string
    imageId: string; baseImageId: string; sourceHash: string; compiledHash: string; createdAt: number
}
export interface RepairBuildAdapter {
    /** Operator-installed adapter: compilation/testing must be isolated. */
    build(root: string, patch: RepairPatch, candidate: PatchSnapshot): Promise<{
        imageId: string; baseImageId: string; compiledHash: string; sandbox: PatchSandboxResult
    }>
}
interface SourceIndex { version: 1; sourceHash: string; releaseId: string; receiptHash?: string }
const hashPattern = /^[a-f0-9]{64}$/
function mirror(root: string, hash: string) { if (!hashPattern.test(hash)) throw Error('Invalid source identity'); return join(root, 'sources', hash) }
/** Operator-owned immutable source copies, never a copy of runtime data/secrets.
 * Version directories are complete clean Git snapshots for the existing Doctor
 * source reader. Only a separately signed original-symptom receipt moves index. */
export class RepairPublication {
    constructor(private readonly options: {
        root: string; signingPrivateKey: string; signingPublicKey: string; receiptPublicKey: string
        profiles: readonly { id: string; file: string; reproductionTest: string; targetId: string; probeId: string }[]
        builder: RepairBuildAdapter
    }) { this.options = { ...options, profiles: structuredClone(options.profiles) } }
    private index(): SourceIndex {
        const value = JSON.parse(readFileSync(join(this.options.root, 'current.json'), 'utf8'))
        if (value.version !== 1 || !hashPattern.test(value.sourceHash) || !value.releaseId) throw Error('Invalid source index')
        return value
    }
    private saveSource(files: PatchSnapshot): string {
        validatePatchSnapshot(files)
        const hash = patchSnapshotHash(files), destination = mirror(this.options.root, hash)
        if (existsSync(destination)) {
            if (patchSnapshotHash(readPatchSnapshot(destination)) !== hash) throw Error('Stored source corrupted')
            return hash
        }
        const directory = join(this.options.root, 'sources'); mkdirSync(directory, { recursive: true })
        const staged = mkdtempSync(join(directory, 'preparing-'))
        for (const [file, bytes] of Object.entries(files)) {
            const path = join(staged, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(bytes, 'base64'), { flag: 'wx', mode: 0o444 })
        }
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_AUTHOR_NAME: 'Repair publisher', GIT_AUTHOR_EMAIL: 'repair@example.invalid', GIT_COMMITTER_NAME: 'Repair publisher', GIT_COMMITTER_EMAIL: 'repair@example.invalid' }
        const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'init.templateDir=', '-c', 'commit.gpgsign=false', ...args], { cwd: staged, env, timeout: 30_000, stdio: 'pipe' })
        git(['init', '-q']); git(['add', '--', '.']); git(['commit', '-qm', `Verified source ${hash}`])
        if (patchSnapshotHash(readPatchSnapshot(staged)) !== hash) throw Error('Source materialization mismatch')
        renameSync(staged, destination); return hash
    }
    /** Explicit initial enrollment; refuses overwriting an active source index. */
    enroll(sourceRoot: string, releaseId: string): void {
        if (!releaseId) throw Error('Initial release identity required')
        mkdirSync(this.options.root, { recursive: true })
        const lock = join(this.options.root, 'publication.lock'); mkdirSync(lock)
        try {
            if (existsSync(join(this.options.root, 'current.json'))) throw Error('Source already enrolled')
            const sourceHash = this.saveSource(readPatchSnapshot(sourceRoot))
            atomicWriteJsonSync(join(this.options.root, 'current.json'), { version: 1, sourceHash, releaseId })
        } finally { rmdirSync(lock) }
    }
    async publish(binding: RepairBinding, request: RepairPatch): Promise<SignedRepairValue<PublishedRepair>> {
        const patch = normalizedRepairPatch(request), profile = this.options.profiles.find(p => p.id === patch.repairProfileId)
        if (!profile || profile.file !== patch.file || profile.reproductionTest !== patch.reproductionTest || profile.targetId !== binding.targetId || profile.probeId !== binding.probeId
            || repairHash(patch) !== binding.patchHash || ![binding.baselineHash, binding.candidateHash].every(h => hashPattern.test(h))) throw Error('Publication profile or patch binding mismatch')
        const artifactPath = join(this.options.root, `artifact-${repairHash(binding)}.json`)
        const lock = join(this.options.root, 'publication.lock'); mkdirSync(lock)
        // A crashed build retains its lock/output: never repeat ambiguous Engine operations.
        let completed = false, buildStarted = false
        try {
            const index = this.index()
            if (index.sourceHash !== binding.baselineHash) throw Error('Active source has advanced; regenerate candidate')
            if (existsSync(artifactPath)) {
                const signed = JSON.parse(readFileSync(artifactPath, 'utf8'))
                const prior = verifyRepairValue<PublishedRepair>(signed, this.options.signingPublicKey)
                if (repairHash(prior.binding) !== repairHash(binding)) throw Error('Artifact replay mismatch')
                completed = true; return signed
            }
            const source = mirror(this.options.root, index.sourceHash), baseline = readPatchSnapshot(source)
            if (patchSnapshotHash(baseline) !== binding.baselineHash || !baseline[patch.file] || /\.(test|spec)\./.test(patch.file)) throw Error('Baseline or immutable oracle mismatch')
            const original = Buffer.from(baseline[patch.file], 'base64').toString('utf8')
            if (!patch.search || patch.search === patch.replace || original.split(patch.search).length !== 2) throw Error('Unique exact patch required')
            const candidate = createPatchCandidate(baseline, patch)
            if (patchSnapshotHash(candidate) !== binding.candidateHash) throw Error('Candidate hash mismatch')
            buildStarted = true
            const built = await this.options.builder.build(source, patch, candidate), s = built.sandbox
            if (!s.verified || !s.cleanupVerified || !s.rollbackPassed || !s.recoveryPassed || !s.reproductionPassed
                || s.baselineHash !== binding.baselineHash || s.candidateHash !== binding.candidateHash
                || !/^sha256:[a-f0-9]{64}$/.test(built.imageId) || !/^sha256:[a-f0-9]{64}$/.test(built.baseImageId) || !hashPattern.test(built.compiledHash)) throw Error('Independent isolated build evidence incomplete')
            if (patchSnapshotHash(readPatchSnapshot(source)) !== binding.baselineHash || this.index().sourceHash !== binding.baselineHash) throw Error('Source changed during publication')
            this.saveSource(candidate)
            const signed = signRepairValue<PublishedRepair>({ version: 1, binding, releaseId: `repair-${binding.candidateHash}`, previousReleaseId: index.releaseId,
                imageId: built.imageId, baseImageId: built.baseImageId, sourceHash: binding.candidateHash, compiledHash: built.compiledHash, createdAt: Date.now() }, this.options.signingPrivateKey)
            atomicWriteJsonSync(artifactPath, signed); completed = true; return signed
        } finally { if (completed || !buildStarted) rmdirSync(lock) }
    }
    commitSource(signedReceipt: SignedRepairValue<RepairReceipt>): void {
        const receipt = verifyRepairValue(signedReceipt, this.options.receiptPublicKey)
        const { attemptId: _id, expiresAt: _expiry, ...binding } = receipt.binding
        const artifact = verifyRepairValue<PublishedRepair>(JSON.parse(readFileSync(join(this.options.root, `artifact-${repairHash(binding)}.json`), 'utf8')), this.options.signingPublicKey)
        if (repairHash(artifact.binding) !== repairHash(binding) || receipt.status !== 'resolved'
            || receipt.releaseId !== artifact.releaseId || receipt.previousReleaseId !== artifact.previousReleaseId
            || receipt.before?.state !== 'fault' || receipt.after?.state !== 'healthy'
            || receipt.before.releaseId !== artifact.previousReleaseId || receipt.after.releaseId !== artifact.releaseId
            || [receipt.before, receipt.after].some(o => o.probeId !== binding.probeId || o.targetId !== binding.targetId)
            || receipt.after.challenge === receipt.before.challenge || receipt.after.observedAt < receipt.before.observedAt) throw Error('Original live recovery receipt required to advance source')
        const lock = join(this.options.root, 'publication.lock'); mkdirSync(lock)
        try {
            const index = this.index(), receiptHash = repairHash(signedReceipt)
            const marker = join(this.options.root, `committed-${repairHash(binding)}.json`)
            if (existsSync(marker)) {
                if (JSON.parse(readFileSync(marker, 'utf8')).receiptHash !== receiptHash) throw Error('Source commit receipt conflict')
                return
            }
            if (index.sourceHash === artifact.sourceHash && index.releaseId === artifact.releaseId && index.receiptHash === receiptHash) {
                atomicWriteJsonSync(marker, { receiptHash }); return
            }
            if (index.sourceHash !== binding.baselineHash || index.releaseId !== artifact.previousReleaseId) throw Error('Source index compare-and-swap refused')
            if (patchSnapshotHash(readPatchSnapshot(mirror(this.options.root, artifact.sourceHash))) !== artifact.sourceHash) throw Error('Published source corrupted')
            atomicWriteJsonSync(join(this.options.root, 'current.json'), { version: 1, sourceHash: artifact.sourceHash, releaseId: artifact.releaseId, receiptHash })
            atomicWriteJsonSync(marker, { receiptHash })
        } finally { rmdirSync(lock) }
    }
}
