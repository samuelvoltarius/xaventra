import { describe, expect, it } from 'vitest'
import {
    failedReleaseNotificationKey,
    buildScpArgs,
    canResumeReleaseCheckpoint,
    derivePersistedUpdateStatus,
    obsoleteDockerReleaseTags,
    recoverConfiguredDockerImageCommand,
    validateUpdateNode,
    type NodeUpdateReceipt,
    type UpdateNodeConfig,
} from './auto-updater.js'

const validNode: UpdateNodeConfig = {
    nodeId: 'nova-spark', name: 'gpu-main', host: '100.64.0.10', user: 'xaventra', port: 22,
    path: '/home/xaventra/nova-core', runtime: 'docker-compose', service: 'nova-spark',
    composePath: '/home/xaventra/nova-runtime', image: 'nova-spark:2.61.0',
}

describe('mesh release node profiles', () => {
    it('accepts the typed Spark Docker profile', () => {
        expect(validateUpdateNode(validNode)).toEqual([])
    })

    it('rejects traversal and shell-like values before SSH execution', () => {
        expect(validateUpdateNode({ ...validNode, path: '/home/nova/../root', service: 'nova; reboot' })).toEqual([
            'invalid path', 'invalid service',
        ])
    })

    it('uses explicitly configured legacy SCP without weakening strict host-key checks', () => {
        const args = buildScpArgs({ ...validNode, scpLegacy: true }, ['/tmp/release.tar.gz'], '/tmp/stage/release.tar.gz')
        expect(args[0]).toBe('-O')
        expect(args).toContain('StrictHostKeyChecking=yes')
        expect(args).toContain('UpdateHostKeys=no')
        expect(args.at(-1)).toBe('xaventra@100.64.0.10:/tmp/stage/release.tar.gz')
    })

    it('rejects an untyped legacy-SCP flag', () => {
        expect(validateUpdateNode({ ...validNode, scpLegacy: 'yes' as any })).toContain('invalid scpLegacy')
    })

    it('rejects unsafe Docker disk thresholds', () => {
        expect(validateUpdateNode({ ...validNode, minFreeDiskGb: 0 })).toContain('invalid minFreeDiskGb')
    })

    it('retains only the active Docker release and its direct rollback', () => {
        expect(obsoleteDockerReleaseTags('nova-worker:current', '2.66.2-new', [
            'nova-worker:current',
            'nova-worker:current-candidate-2.66.2-new',
            'nova-worker:current-rollback-2.66.2-new',
            'nova-worker:current-candidate-2.66.1-old',
            'nova-worker:current-rollback-2.66.1-old',
            'unrelated:latest',
        ])).toEqual([
            'nova-worker:current-candidate-2.66.1-old',
            'nova-worker:current-rollback-2.66.1-old',
        ])
    })

    it('allows activation to recover a missing configured image tag from the running service', () => {
        expect(recoverConfiguredDockerImageCommand({ ...validNode, image: 'nova-worker:current', service: 'nova-worker' }))
            .toContain("docker inspect -f '{{.Image}}' 'nova-worker'")
    })
})

describe('mesh release failure notifications', () => {
    const receipt = (status: NodeUpdateReceipt['status']): NodeUpdateReceipt => ({
        nodeId: 'nova-pi5', node: 'pi5', releaseId: '2.63.1-deadbeef', runtime: 'systemd',
        status, startedAt: '2026-07-19T00:00:00.000Z', finishedAt: '2026-07-19T00:01:00.000Z',
    })

    it('creates one stable key for the same failed release state', () => {
        expect(failedReleaseNotificationKey('2.63.1', '2.63.1-deadbeef', [receipt('failed')]))
            .toBe('release-failed:2.63.1:2.63.1-deadbeef:nova-pi5:failed')
    })

    it('does not create a failure key after every node verified', () => {
        expect(failedReleaseNotificationKey('2.63.1', '2.63.1-deadbeef', [receipt('verified')]))
            .toBeUndefined()
    })
})

describe('durable release takeover', () => {
    it('resumes only an unfinished checkpoint matching the local signed artifact', () => {
        const checkpoint = {
            releaseId: '2.64.0-hash', version: '2.64.0', phase: 'deploying' as const,
            nextNodeIndex: 1, startedAt: '2026-07-19T00:00:00.000Z', receipts: [],
            mainLeaseEpoch: 4, sourceNode: 'home',
        }
        expect(canResumeReleaseCheckpoint(checkpoint, '2.64.0-hash')).toBe(true)
        expect(canResumeReleaseCheckpoint(checkpoint, '2.64.0-other')).toBe(false)
        expect(canResumeReleaseCheckpoint({ ...checkpoint, phase: 'completed' }, '2.64.0-hash')).toBe(false)
    })
})

describe('canonical persisted update status', () => {
    const verified = (nodeId: string, finishedAt: string): NodeUpdateReceipt => ({
        nodeId, node: nodeId, releaseId: '2.66.9-release', runtime: 'systemd',
        status: 'verified', startedAt: '2026-07-28T21:00:00.000Z', finishedAt,
    })

    it('restores a completed external rollout after daemon restart', () => {
        const status = derivePersistedUpdateStatus('2.66.9', {
            observedVersion: '2.66.9',
            lastRelease: '2.66.9-release',
            receipts: [
                verified('nova-spark', '2026-07-28T21:01:00.000Z'),
                verified('nova-pi5', '2026-07-28T21:02:00.000Z'),
            ],
        }, ['nova-spark', 'nova-pi5'])
        expect(status).toMatchObject({
            currentRelease: '2.66.9-release',
            lastUpdate: '2026-07-28T21:02:00.000Z',
            pendingUpdate: false,
            running: false,
        })
    })

    it('shows a controller-owned rollout as running instead of release-ready', () => {
        const status = derivePersistedUpdateStatus('2.66.10', {
            observedVersion: '2.66.9',
            lastRelease: '2.66.10-release',
            receipts: [verified('nova-spark', '2026-07-28T21:01:00.000Z')],
            activeDeployment: {
                releaseId: '2.66.10-release', version: '2.66.10', phase: 'deploying',
                nextNodeIndex: 1, startedAt: '2026-07-28T21:00:00.000Z',
                receipts: [], mainLeaseEpoch: 8, sourceNode: 'nova-spark',
            },
        }, ['nova-spark', 'nova-pi5'])
        expect(status.running).toBe(true)
        expect(status.pendingUpdate).toBe(true)
    })

    it('keeps a failed current release pending for operator retry', () => {
        const status = derivePersistedUpdateStatus('2.66.10', {
            observedVersion: '2.66.9',
            lastRelease: '2.66.10-release',
            receipts: [{ ...verified('nova-pi5', '2026-07-28T21:02:00.000Z'), releaseId: '2.66.10-release', status: 'failed' }],
            activeDeployment: {
                releaseId: '2.66.10-release', version: '2.66.10', phase: 'failed',
                nextNodeIndex: 2, startedAt: '2026-07-28T21:00:00.000Z',
                receipts: [], mainLeaseEpoch: 8, sourceNode: 'nova-spark',
            },
        }, ['nova-spark', 'nova-pi5'])
        expect(status.running).toBe(false)
        expect(status.pendingUpdate).toBe(true)
    })
})
