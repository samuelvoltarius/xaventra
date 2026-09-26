import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const phase = process.argv[2]
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))
const runChild = (name, env) => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, name], { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveChild() : reject(new Error(`${name} failed (${code ?? signal})`)))
})

async function Coordinator() {
    return (await import(pathToFileURL(join(root, 'dist/memory/memory-governance.js')).href)).MemoryGovernanceCoordinator
}

async function runPhase() {
    const dir = process.env.XAVENTRA_MEMORY_QA_DIR
    if (!dir) throw new Error('XAVENTRA_MEMORY_QA_DIR is required')
    const MemoryGovernanceCoordinator = await Coordinator()
    const leaderDir = join(dir, 'leader')
    const successorDir = join(dir, 'successor')
    const partitionedDir = join(dir, 'partitioned')
    mkdirSync(leaderDir, { recursive: true })

    if (phase === 'terminal-seed' || phase === 'terminal-replay') {
        const dirs = [join(dir, 'terminal-a'), join(dir, 'terminal-b')]
        const nodes = dirs.map(path => new MemoryGovernanceCoordinator(path))
        if (phase === 'terminal-seed') {
            const record = nodes[0].propose({ content: 'A scoped preference for offline processing.',
                kind: 'preference', scope: 'user:terminal', source: 'operator', evidence: 'manual', confidence: 1 })
            nodes[0].reject(record.id, 'operator')
            const timestamp = nodes[0].get(record.id).updatedAt
            await new Promise(resolve => setTimeout(resolve, 20))
            assert.equal(await nodes[1].mergeReplicationSnapshot(nodes[0].getReplicationSnapshot(), 'a'), 1)
            assert.equal(nodes[1].get(record.id).updatedAt, timestamp)
            writeJson(join(dir, 'terminal-audits.json'), dirs.map(path => readFileSync(join(path, 'audit.jsonl'), 'utf8')))
        } else {
            for (let round = 0; round < 5; round++) {
                assert.equal(await nodes[0].mergeReplicationSnapshot(nodes[1].getReplicationSnapshot(), 'b'), 0)
                assert.equal(await nodes[1].mergeReplicationSnapshot(nodes[0].getReplicationSnapshot(), 'a'), 0)
            }
            assert.deepEqual(dirs.map(path => readFileSync(join(path, 'audit.jsonl'), 'utf8')), readJson(join(dir, 'terminal-audits.json')))
        }
        return
    }

    if (phase === 'seed') {
        const leader = new MemoryGovernanceCoordinator(leaderDir)
        const alice = leader.propose({
            content: 'Alice verwendet für das Projekt den Codenamen Amber.', kind: 'project', scope: 'user:alice',
            source: 'alice', evidence: 'explicit_user_instruction', confidence: 1, verified: true,
            subject: 'project', predicate: 'codename', value: 'Amber', timestamp: 10,
        })
        const bob = leader.propose({
            content: 'Bob verwendet für sein Projekt den Codenamen Birch.', kind: 'project', scope: 'user:bob',
            source: 'bob', evidence: 'explicit_user_instruction', confidence: 1, verified: true,
            subject: 'project', predicate: 'codename', value: 'Birch', timestamp: 10,
        })
        assert.ok(alice && bob)
        writeJson(join(dir, 'ids.json'), { alice: alice.id, bob: bob.id })
        return
    }
    if (phase === 'correct') {
        const leader = new MemoryGovernanceCoordinator(leaderDir)
        const ids = readJson(join(dir, 'ids.json'))
        const old = leader.get(ids.alice)
        assert.ok(old)
        const corrected = leader.propose({
            content: 'Korrektur: Alice verwendet für das Projekt den Codenamen Blue.', kind: 'project', scope: 'user:alice',
            source: 'alice', evidence: 'correction', confidence: 1, verified: true,
            subject: 'project', predicate: 'codename', value: 'Blue', replacesContent: old.content, timestamp: 20,
        })
        assert.ok(corrected)
        assert.match(leader.getContextForPrompt('user:alice', 'Codename'), /Blue/)
        assert.doesNotMatch(leader.getContextForPrompt('user:alice', 'Codename'), /Amber/)
        assert.match(leader.getContextForPrompt('user:bob', 'Codename'), /Birch/)
        writeJson(join(dir, 'ids.json'), { ...ids, corrected: corrected.id })
        writeJson(join(dir, 'stale-snapshot.json'), leader.getReplicationSnapshot())
        return
    }
    if (phase === 'reset') {
        const leader = new MemoryGovernanceCoordinator(leaderDir)
        const activeAlice = leader.list({ scope: 'user:alice' })
            .filter(record => record.status === 'verified' || record.status === 'canonical')
        assert.equal(activeAlice.length, 1)
        for (const record of activeAlice) await leader.rejectAndRetract(record.id, 'user-reset:alice')
        assert.equal(leader.getContextForPrompt('user:alice', 'Codename'), '')
        assert.match(leader.getContextForPrompt('user:bob', 'Codename'), /Birch/)
        writeJson(join(dir, 'reset-snapshot.json'), leader.getReplicationSnapshot())
        return
    }
    if (phase === 'takeover') {
        const successor = new MemoryGovernanceCoordinator(successorDir)
        const partitioned = new MemoryGovernanceCoordinator(partitionedDir)
        const reset = readJson(join(dir, 'reset-snapshot.json'))
        const stale = readJson(join(dir, 'stale-snapshot.json'))
        await successor.mergeReplicationSnapshot(reset, 'leader', { projectBackends: false })
        await successor.mergeReplicationSnapshot(
            stale.map(record => ({ ...record, updatedAt: record.updatedAt + 10_000_000 })),
            'clock-skewed-stale-node', { projectBackends: false },
        )
        await partitioned.mergeReplicationSnapshot(stale, 'leader-before-reset', { projectBackends: false })
        const corrected = stale.find(record => record.id === readJson(join(dir, 'ids.json')).corrected)
        const disconnected = partitioned.propose({
            content: 'Korrektur: Alice verwendet für das Projekt den Codenamen Green.', kind: 'project', scope: 'user:alice',
            source: 'partitioned-alice', evidence: 'correction', confidence: 1, verified: true,
            subject: 'project', predicate: 'codename', value: 'Green', replacesContent: corrected.content, timestamp: 30,
        })
        assert.ok(disconnected)
        await successor.mergeReplicationSnapshot(partitioned.getReplicationSnapshot(), 'partitioned-node', { projectBackends: false })
        assert.equal(successor.getContextForPrompt('user:alice', 'Codename'), '')
        assert.match(successor.getContextForPrompt('user:bob', 'Codename'), /Birch/)
        assert.equal(successor.get(disconnected.id), undefined)
        const reentry = successor.propose({
            content: 'Merke dir: Alice verwendet jetzt wieder den Codenamen Purple.', kind: 'project', scope: 'user:alice',
            source: 'alice-after-reset', evidence: 'explicit_user_instruction', confidence: 1, verified: true,
            subject: 'project', predicate: 'codename', value: 'Purple', timestamp: 40,
        })
        assert.ok(reentry)
        writeJson(join(dir, 'ids.json'), { ...readJson(join(dir, 'ids.json')), disconnected: disconnected.id, reentry: reentry.id })
        return
    }
    if (phase === 'verify') {
        const successor = new MemoryGovernanceCoordinator(successorDir)
        const ids = readJson(join(dir, 'ids.json'))
        const aliceContext = successor.getContextForPrompt('user:alice', 'Codename')
        const bobContext = successor.getContextForPrompt('user:bob', 'Codename')
        assert.match(aliceContext, /Purple/)
        assert.doesNotMatch(aliceContext, /Amber|Blue|Green/)
        assert.match(bobContext, /Birch/)
        assert.equal(successor.get(ids.disconnected), undefined)
        assert.equal(successor.get(ids.corrected)?.status, 'rejected')
        return
    }
    throw new Error(`unknown phase ${phase}`)
}

if (phase) await runPhase()
else {
    const dir = process.env.XAVENTRA_MEMORY_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-memory-convergence-'))
    mkdirSync(dir, { recursive: true })
    const report = {
        success: false, platform: process.platform, processStarts: 7,
        evidenceClass: 'seven isolated Node process starts with independent governed-memory stores; no production state, physical host or live channel',
        terminalReplayAuditStable: false,
        correctionSurvivedRestart: false, resetSurvivedRestart: false, userIsolation: false,
        staleWriterRejected: false, disconnectedCorrectionRejected: false, deliberateReentrySurvivedRestart: false,
        error: undefined,
    }
    try {
        const env = { ...process.env, XAVENTRA_MEMORY_QA_DIR: dir, NOVA_NO_SIDE_EFFECTS: '1', NOVA_TEST_MODE: '1' }
        for (const name of ['seed', 'correct', 'reset', 'takeover', 'verify', 'terminal-seed', 'terminal-replay']) await runChild(name, env)
        Object.assign(report, {
            success: true, terminalReplayAuditStable: true, correctionSurvivedRestart: true, resetSurvivedRestart: true, userIsolation: true,
            staleWriterRejected: true, disconnectedCorrectionRejected: true, deliberateReentrySurvivedRestart: true,
        })
        writeJson(join(dir, 'report.json'), report)
        console.log(JSON.stringify(report))
    } catch (error) {
        report.error = String(error)
        writeJson(join(dir, 'report.json'), report)
        throw error
    } finally {
        if (!process.env.XAVENTRA_MEMORY_QA_DIR) rmSync(dir, { recursive: true, force: true })
    }
}
