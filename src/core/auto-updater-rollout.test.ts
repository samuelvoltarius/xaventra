import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)
const behaviour = vi.hoisted(() => ({ tarFails: false, failSsh: null as null | RegExp }))
const fence = vi.hoisted(() => ({ epochs: [] as number[] }))

vi.mock('node:child_process', () => ({
    execFile: (file: string, args: string[], _opts: unknown, callback: (error: Error | null, value?: unknown) => void) => {
        calls.push({ file, args })
        if (file === 'tar') {
            writeFileSync(args[1], 'partial archive')
            if (behaviour.tarFails) return callback(new Error('tar timeout'))
        }
        if (file === 'ssh' && behaviour.failSsh?.test(args.at(-1) || '')) return callback(new Error('remote precondition failed'))
        callback(null, { stdout: '', stderr: '' })
    },
}))
vi.mock('../mesh/leader-election.js', () => ({
    MAIN_SERVICE: 'nova-main',
    getServiceFencingToken: () => ({ epoch: fence.epochs.length > 1 ? fence.epochs.shift()! : fence.epochs[0], token: 't' }),
}))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'main-node', discoverNodes: async () => [] }))
vi.mock('../mesh/mesh-identity.js', () => ({
    MeshIdentity: class { create(input: { payload: unknown }) { return { payload: input.payload } } },
}))
vi.mock('./github-update.js', () => ({ installedUpdateVersion: () => '9.9.9' }))
vi.mock('./release-verifier.js', () => ({ listReleaseFiles: () => [], releaseTreeHash: () => 'a'.repeat(64) }))
vi.mock('../memory/shared-memory.js', () => ({ pushSharedMemory: async () => true, pullSharedMemory: async () => [] }))

import { deployUpdateToAllNodes, getUpdateStatus, startUpdateChecker, stopUpdateChecker, type UpdateNodeConfig } from './auto-updater.js'
import { getNovaDataDir } from './data-root.js'

const node: UpdateNodeConfig = { nodeId: 'node-a', name: 'node-a', host: '10.0.0.2', user: 'nova', path: '/opt/nova', runtime: 'systemd', service: 'nova' }
const releaseId = `9.9.9-${'a'.repeat(16)}`
const stateFile = () => getNovaDataDir('mesh-update-state.json')
const archive = () => getNovaDataDir('release-artifacts', `${releaseId}.tar.gz`)
const sshCommands = () => calls.filter(call => call.file === 'ssh').map(call => call.args.at(-1) || '')

beforeEach(() => {
    calls.length = 0
    behaviour.tarFails = false
    behaviour.failSsh = null
    fence.epochs = [1]
    mkdirSync(join(process.cwd(), 'dist'), { recursive: true })
    writeFileSync(join(process.cwd(), 'dist', 'daemon.js'), '')
    rmSync(stateFile(), { force: true })
    rmSync(getNovaDataDir('release-artifacts'), { recursive: true, force: true })
})
afterEach(() => {
    stopUpdateChecker()
    vi.useRealTimers()
})

describe('mesh rollout failure handling', () => {
    it('marks the checkpoint failed when the rollout aborts after it was written (R2 A4)', async () => {
        fence.epochs = [1, 2]
        expect(await deployUpdateToAllNodes({ enabled: true, notifyOnly: false, nodes: [node] })).toBe(false)
        const state = JSON.parse(readFileSync(stateFile(), 'utf8'))
        expect(state.activeDeployment.phase).toBe('failed')
        expect(getUpdateStatus().running).toBe(false)
    })

    it('reports an orphaned deploying checkpoint instead of blocking silently (R2 A4)', async () => {
        vi.useFakeTimers()
        mkdirSync(getNovaDataDir(), { recursive: true })
        writeFileSync(stateFile(), JSON.stringify({
            observedVersion: '9.9.8', lastRelease: releaseId, receipts: [],
            activeDeployment: { releaseId, version: '9.9.9', phase: 'deploying', nextNodeIndex: 0,
                startedAt: '2026-09-29T00:00:00.000Z', receipts: [], mainLeaseEpoch: 1, sourceNode: 'main-node' },
        }))
        const notify = vi.fn()
        startUpdateChecker({ enabled: true, notifyOnly: false, autoDeployOnVersionChange: true, nodes: [node] }, notify)
        await vi.advanceTimersByTimeAsync(1_500)
        expect(getUpdateStatus().running).toBe(false)
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('unterbrochen'))
        expect(calls).toHaveLength(0)
    })

    it('does not roll back when activation fails its precondition before any change (R2 A5)', async () => {
        behaviour.failSsh = /test ! -e/
        await deployUpdateToAllNodes({ enabled: true, notifyOnly: false, nodes: [node] })
        expect(sshCommands().some(command => command.includes('failed-'))).toBe(false)
        expect(sshCommands().some(command => command.includes(`mv '${node.path}/dist'`))).toBe(false)
        expect(getUpdateStatus().receipts[0]?.status).toBe('failed')
    })

    it('never keeps a half-written release archive for reuse (R2 A11)', async () => {
        behaviour.tarFails = true
        await deployUpdateToAllNodes({ enabled: true, notifyOnly: false, nodes: [node] })
        expect(calls.some(call => call.file === 'tar')).toBe(true)
        expect(existsSync(archive())).toBe(false)
    })

    it('stages releases outside world-writable /tmp (R2 A12)', async () => {
        behaviour.failSsh = /release-verifier/
        await deployUpdateToAllNodes({ enabled: true, notifyOnly: false, nodes: [node] })
        expect(sshCommands().length).toBeGreaterThan(0)
        expect(sshCommands().some(command => command.includes('/tmp/'))).toBe(false)
        expect(calls.filter(call => call.file === 'scp').some(call => call.args.join(' ').includes('/tmp/'))).toBe(false)
    })
})
