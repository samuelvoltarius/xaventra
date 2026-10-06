import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    executeGitRequest, importResult, listMeshRepos, newWorkId, prepareDelivery, publishRepo, repoHead, resultBranch,
    validateGitReceipt, validGitRequest, workPathFor, type GitReceipt,
} from './mesh-git.js'

// Mesh-Git (2.88): a task continues on another node with exactly the same
// repository state, and the result comes back as its own branch on the Main.
// Real git, two separate runtime roots (Main and worker), no network.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
}).trim()

let mainRoot = ''
let workerRoot = ''
let source = ''
const asMain = () => vi.stubEnv('NOVA_RUNTIME_ROOT', mainRoot)
const asWorker = () => vi.stubEnv('NOVA_RUNTIME_ROOT', workerRoot)

beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'mesh-git-main-'))
    workerRoot = mkdtempSync(join(tmpdir(), 'mesh-git-worker-'))
    source = mkdtempSync(join(tmpdir(), 'mesh-git-src-'))
    git(source, 'init', '-q', '-b', 'main')
    writeFileSync(join(source, 'README.md'), '# Demo\n')
    writeFileSync(join(source, 'app.txt'), 'version 1\n')
    git(source, 'add', '-A')
    git(source, 'commit', '-q', '-m', 'start')
})
afterEach(() => { vi.unstubAllEnvs() })

async function deliverToWorker(repo = 'demo') {
    asMain()
    const published = await publishRepo(source, repo)
    const workId = newWorkId()
    const delivery = await prepareDelivery(repo, published.commit, workId)
    expect(validGitRequest(delivery)).toBe(true)
    asWorker()
    const receipt = await executeGitRequest(delivery)
    return { published, workId, delivery, receipt }
}

describe('Mesh-Git round trip', { timeout: 30_000 }, () => {
    it('publishes a local repo as the mesh target and delivers exactly that commit to a node', async () => {
        const { published, workId, receipt } = await deliverToWorker()
        expect(published.commit).toBe(git(source, 'rev-parse', 'HEAD'))
        expect(receipt).toEqual({ operation: 'deliver', workId, commit: published.commit, path: workPathFor(workId) })
        const dir = join(workerRoot, 'mesh-work', workId)
        expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('version 1\n')
        expect(git(dir, 'rev-parse', 'HEAD')).toBe(published.commit)
        asMain()
        expect(await listMeshRepos()).toEqual([{ repo: 'demo', branches: ['main'] }])
    })

    it('brings the node result back as its own branch, main untouched', async () => {
        const { published, workId } = await deliverToWorker()
        const dir = join(workerRoot, 'mesh-work', workId)
        writeFileSync(join(dir, 'app.txt'), 'version 2\n')
        writeFileSync(join(dir, 'NEU.md'), 'neu\n')
        const collect = { operation: 'collect' as const, repo: 'demo', workId, base: published.commit }
        const raw = await executeGitRequest(collect)
        const receipt = validateGitReceipt(collect, raw) as Extract<GitReceipt, { operation: 'collect' }>
        expect(receipt.changedFiles).toBe(2)
        asMain()
        const imported = await importResult('demo', 'GPU Box', receipt)
        expect(imported.branch).toBe(`mesh/gpu-box/${workId}`)
        const bare = join(mainRoot, '.nova-data', 'mesh-git', 'demo.git')
        expect(git(bare, 'show', `${imported.branch}:app.txt`)).toBe('version 2')
        expect(git(bare, 'rev-parse', `${imported.branch}~1`)).toBe(published.commit)
        expect(await repoHead('demo')).toBe(published.commit)
        // Release removes the work directory on the node.
        asWorker()
        expect(await executeGitRequest({ operation: 'release', repo: 'demo', workId })).toEqual({ operation: 'release', workId, released: true })
        expect(existsSync(dir)).toBe(false)
    })

    it('reports "no change" without a bundle when the node changed nothing', async () => {
        const { published, workId } = await deliverToWorker()
        const raw = await executeGitRequest({ operation: 'collect', repo: 'demo', workId, base: published.commit })
        expect(raw).toEqual({ operation: 'collect', workId, base: published.commit, head: published.commit, changedFiles: 0 })
        asMain()
        expect(await importResult('demo', 'node-a', raw as any)).toEqual({ branch: null, head: published.commit, changedFiles: 0 })
    })

    it('never sends a secret back and never imports one', async () => {
        const { published, workId } = await deliverToWorker()
        const dir = join(workerRoot, 'mesh-work', workId)
        writeFileSync(join(dir, 'config.txt'), 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n')
        await expect(executeGitRequest({ operation: 'collect', repo: 'demo', workId, base: published.commit })).rejects.toThrow(/Geheimnis/)
    })

    it('refuses a tampered bundle and a result that is not built on the delivered state', async () => {
        const { published, workId, delivery } = await deliverToWorker()
        asWorker()
        const tampered = { ...delivery, workId: newWorkId(), sha256: 'a'.repeat(64) }
        await expect(executeGitRequest(tampered)).rejects.toThrow(/Prüfsumme|ungültig|stimmt nicht/)
        const dir = join(workerRoot, 'mesh-work', workId)
        writeFileSync(join(dir, 'app.txt'), 'version 2\n')
        const raw = await executeGitRequest({ operation: 'collect', repo: 'demo', workId, base: published.commit }) as Extract<GitReceipt, { operation: 'collect' }>
        asMain()
        // Same bundle, but a different head claimed in the receipt: the Main refuses it.
        const wrongHead = raw.head.replace(/.$/, c => c === '0' ? '1' : '0')
        await expect(importResult('demo', 'node-a', { ...raw, head: wrongHead })).rejects.toThrow(/stimmt nicht/)
        expect(await importResult('demo', 'node-a', raw)).toMatchObject({ changedFiles: 1 })
    })
})

describe('Mesh-Git contract', () => {
    const commit = 'a'.repeat(40)
    it('accepts only the three typed operations with safe names', () => {
        expect(validGitRequest({ operation: 'release', repo: 'demo', workId: 'w-12345678' })).toBe(true)
        expect(validGitRequest({ operation: 'release', repo: '../etc', workId: 'w-12345678' })).toBe(false)
        expect(validGitRequest({ operation: 'release', repo: 'demo', workId: '--upload-pack=x' })).toBe(false)
        expect(validGitRequest({ operation: 'collect', repo: 'demo', workId: 'w-12345678', base: 'main' })).toBe(false)
        expect(validGitRequest({ operation: 'collect', repo: 'demo', workId: 'w-12345678', base: commit, extra: 1 })).toBe(false)
        expect(validGitRequest({ operation: 'push', repo: 'demo', workId: 'w-12345678' })).toBe(false)
        expect(validGitRequest({ operation: 'deliver', repo: 'demo', workId: 'w-12345678', commit, bundle: 'not base64!', sha256: 'b'.repeat(64) })).toBe(false)
    })

    it('binds receipts to the request', () => {
        const request = { operation: 'deliver' as const, repo: 'demo', workId: 'w-12345678', commit, bundle: 'AAAA', sha256: 'b'.repeat(64) }
        expect(() => validateGitReceipt(request, { operation: 'deliver', workId: 'w-12345678', commit, path: '/etc' })).toThrow()
        expect(() => validateGitReceipt(request, { operation: 'deliver', workId: 'w-other000', commit, path: workPathFor('w-other000') })).toThrow()
        expect(validateGitReceipt(request, { operation: 'deliver', workId: 'w-12345678', commit, path: workPathFor('w-12345678') })).toMatchObject({ path: 'mesh-work/w-12345678' })
    })

    it('names result branches from the node id, safely', () => {
        expect(resultBranch('GPU Box #1', 'w-12345678')).toBe('mesh/gpu-box-1/w-12345678')
        expect(resultBranch('../../x', 'w-12345678')).toBe('mesh/x/w-12345678')
    })
})

describe('Mesh-Git over the signed mesh path', () => {
    it('only privileged, typed, addressed git requests pass the mesh policy', async () => {
        const { MeshIdentity } = await import('./mesh-identity.js')
        const { MeshPolicy } = await import('./mesh-policy.js')
        const main = new MeshIdentity('main-a', mkdtempSync(join(tmpdir(), 'mesh-git-id-')))
        const peer = { nodeId: 'main-a', transport: 'direct' as const, status: 'online' as const, publicKey: main.publicKey, roles: ['system' as const, 'worker' as const] }
        const policy = new MeshPolicy({ mode: 'direct', peers: [peer] }, 'worker-b')
        const release = { operation: 'release', repo: 'demo', workId: 'w-12345678' }
        const ok = main.create({ kind: 'git.request', targetNode: 'worker-b', principal: { id: 'node:main-a', role: 'system' }, payload: release })
        expect(policy.verify(ok)).toEqual({ accepted: true })
        const asWorkerRole = main.create({ kind: 'git.request', targetNode: 'worker-b', principal: { id: 'node:main-a', role: 'worker' }, payload: release })
        expect(policy.verify(asWorkerRole)).toMatchObject({ accepted: false, reason: 'request_role_not_allowed' })
        const bad = main.create({ kind: 'git.request', targetNode: 'worker-b', principal: { id: 'node:main-a', role: 'system' }, payload: { operation: 'push', repo: 'demo', workId: 'w-12345678' } })
        expect(policy.verify(bad)).toMatchObject({ accepted: false, reason: 'invalid_git_request' })
    })
})
