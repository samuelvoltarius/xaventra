import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDelegatedFence, getFenceHighWater, observeFenceEpoch, parseFenceToken } from './fence-highwater.js'
import { FenceError, resetFenceStateForTests, runFencedTool, runWithDelegatedFence } from './fence.js'
import { verifyDelegatedEnvelopeFence } from './mesh-transport-runtime.js'
import { fenceEpochGuardCommand } from '../core/auto-updater.js'
import { MeshIdentity } from './mesh-identity.js'
import { listReleaseFiles, releaseTreeHash, verifyReleaseDirectory, type NovaReleaseManifest } from '../core/release-verifier.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let runtimeRoot = ''

beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'nova-highwater-'))
    mkdirSync(join(runtimeRoot, '.nova-data'), { recursive: true })
    vi.stubEnv('NOVA_RUNTIME_ROOT', runtimeRoot)
    // No coordinator configured on this worker unless a test says so.
    writeFileSync(join(runtimeRoot, 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'ha' } }))
    vi.spyOn(process, 'cwd').mockReturnValue(runtimeRoot)
    resetFenceStateForTests()
})
afterEach(() => { resetFenceStateForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const fence = (epoch: number, node = 'spark') => ({ service: 'nova-main', epoch, token: `nova-main:${epoch}:${node}`, sourceNode: node })

describe('CL-07 (e) workers reject delegated work from a stale Main', () => {
    it('keeps a persisted, only rising high-water mark per service', () => {
        expect(observeFenceEpoch('nova-main', 5)).toEqual({ accepted: true, highWater: 5 })
        expect(observeFenceEpoch('nova-main', 5).accepted).toBe(true)
        expect(observeFenceEpoch('nova-main', 4)).toEqual({ accepted: false, highWater: 5 })
        expect(observeFenceEpoch('nova-main', 9).accepted).toBe(true)
        expect(getFenceHighWater('nova-main')).toBe(9)
        // Survives a restart: the mark lives on disk, not in memory.
        const persisted = JSON.parse(readFileSync(join(runtimeRoot, '.nova-data', 'fence-highwater.json'), 'utf8'))
        expect(persisted).toEqual({ 'nova-main': 9 })
        expect(observeFenceEpoch('nova-main', 8).accepted).toBe(false)
        expect(getFenceHighWater('telegram')).toBe(0)
    })

    it('refuses a smaller epoch after a newer Main was seen', async () => {
        expect((await checkDelegatedFence(fence(20, 'nas'))).ok).toBe(true)
        const stale = await checkDelegatedFence(fence(19, 'spark'))
        expect(stale.ok).toBe(false)
        expect(stale.reason).toContain('stale epoch 19 < high-water 20')
    })

    it('rejects a token that does not belong to the sending node or epoch', async () => {
        expect((await checkDelegatedFence({ ...fence(3), sourceNode: 'other-node' })).ok).toBe(false)
        expect((await checkDelegatedFence({ ...fence(3), epoch: 4 })).ok).toBe(false)
        expect(parseFenceToken('nova-main:q12:nas')).toEqual({ service: 'nova-main', epoch: 12, nodeId: 'nas' })
    })

    it('confirms the fence live where the worker can reach the coordinator', async () => {
        writeFileSync(join(runtimeRoot, 'xaventra.config.json'), JSON.stringify({ supabase: { meshUrl: 'https://coord.test/rest/v1', meshKey: 'k' }, mesh: { mode: 'ha' } }))
        let current = 30
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toContain('/rpc/nova_check_fence')
            const body = JSON.parse(String(init?.body))
            expect(body.p_holder_instance_id).toBeNull()
            return json({ valid: body.p_epoch === current, epoch: current })
        }))
        expect((await checkDelegatedFence(fence(30), { live: true })).ok).toBe(true)
        current = 31
        expect((await checkDelegatedFence(fence(30), { live: true })).ok).toBe(false)
    })

    it('refuses an envelope without a Main fence', async () => {
        const verdict = await verifyDelegatedEnvelopeFence({ sourceNode: 'spark', kind: 'tool.request' } as any, false)
        expect(verdict.ok).toBe(false)
    })

    it('enforce: a tool delegated under a stale epoch is blocked, the current epoch runs', async () => {
        vi.stubEnv('NOVA_FENCING_MODE', 'enforce')
        observeFenceEpoch('nova-main', 40)
        const handler = vi.fn(async () => 'ran')
        await expect(runWithDelegatedFence(fence(39), () => runFencedTool('ha_call_service', handler))).rejects.toBeInstanceOf(FenceError)
        expect(handler).not.toHaveBeenCalled()
        expect(await runWithDelegatedFence(fence(40), () => runFencedTool('ha_call_service', handler))).toBe('ran')
    })
})

describe('CL-07 update fencing on the target host', () => {
    it('builds a flock compare-and-set before any mv/restart', () => {
        const command = fenceEpochGuardCommand('/opt/nova', 42)
        expect(command).toContain("flock -w 30 9")
        expect(command).toContain('-le 42 ]')
        expect(command).toContain('exit 97')
        expect(command).toContain("/opt/nova/.nova-update/fence-epoch")
        expect(() => fenceEpochGuardCommand('/opt/nova', 0)).toThrow()
        expect(() => fenceEpochGuardCommand("/opt/nova'; rm -rf /", 3)).toThrow()
    })

    it('refuses a release signed under an epoch older than the one the node already accepted', () => {
        const base = mkdtempSync(join(tmpdir(), 'nova-release-epoch-'))
        const root = join(base, 'dist')
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, 'daemon.js'), 'console.log("nova")')
        const identity = new MeshIdentity('nova-main-epoch', join(base, 'identity'))
        const files = listReleaseFiles(root)
        const payload: NovaReleaseManifest = {
            schemaVersion: 1, releaseId: '1.0.0-epoch', version: '1.0.0', createdAt: new Date().toISOString(),
            sourceNode: identity.nodeId, files, treeHash: releaseTreeHash(files), mainLeaseEpoch: 7, fenceService: 'nova-main',
        }
        const envelope = identity.create({ kind: 'update.release', targetNode: '*', payload, principal: { id: 'node:nova-main-epoch', role: 'system' } })
        expect(verifyReleaseDirectory(envelope, root, [identity.publicKey], 7)).toEqual({ valid: true })
        expect(verifyReleaseDirectory(envelope, root, [identity.publicKey], 8).reason).toContain('older than accepted epoch 8')
    })
})
