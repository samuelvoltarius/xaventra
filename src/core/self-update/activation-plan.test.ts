import { describe, expect, it } from 'vitest'
import { buildActivationPlan, planHash, summarizeActivationPlan, type NodeProfile } from './activation-plan.js'
import type { VerifiedRelease } from './release-watch.js'

const release: VerifiedRelease = {
    version: '2.81.0', tag: 'v2.81.0', releaseId: `2.81.0-${'a'.repeat(64)}`, commit: 'c'.repeat(40),
    publisherKeyId: 'xaventra-update-20260910', checkedAt: '2026-10-01T12:00:00.000Z', notes: 'x',
    artifacts: [
        { arch: 'x64', name: 'xaventra-2.81.0-linux-x64.tar.gz', size: 300, sha256: '1'.repeat(64), image: `ghcr.io/samuelvoltarius/xaventra@sha256:${'1'.repeat(64)}` },
        { arch: 'arm64', name: 'xaventra-2.81.0-linux-arm64.tar.gz', size: 300, sha256: '2'.repeat(64), image: `ghcr.io/samuelvoltarius/xaventra@sha256:${'2'.repeat(64)}` },
    ],
}
const fleet: NodeProfile[] = [
    { nodeId: 'xaventra-spark', kind: 'native-spark', arch: 'arm64', currentVersion: '2.80.0' },
    { nodeId: 'xaventra-nas', kind: 'container-nas', arch: 'x64', currentVersion: '2.80.0' },
    { nodeId: 'xaventra-ns1', kind: 'container-worker', arch: 'x64', currentVersion: '2.80.0' },
    { nodeId: 'xaventra-ns2', kind: 'container-worker', arch: 'x64', currentVersion: '2.80.0' },
    { nodeId: 'nova-pi5', kind: 'excluded', arch: 'arm64', currentVersion: '2.78.0' },
]

describe('activation plan as data (nothing executes)', () => {
    const plan = buildActivationPlan(release, fleet)

    it('orders workers first, NAS after the workers and Spark last; Pi stays excluded', () => {
        expect(plan.order).toEqual(['xaventra-ns1', 'xaventra-ns2', 'xaventra-nas', 'xaventra-spark'])
        expect(plan.skipped).toEqual([{ nodeId: 'nova-pi5', reason: expect.stringContaining('ausgeschlossen') }])
        expect(plan.executes).toBe(false)
        const mutating = plan.sequence.filter(s => s.mutates)
        expect(mutating[mutating.length - 1].nodeId).toBe('xaventra-spark')
        const firstSpark = plan.sequence.findIndex(s => s.nodeId === 'xaventra-spark' && s.mutates)
        const lastOther = plan.sequence.map(s => s.nodeId !== 'xaventra-spark' && s.phase !== 'rueckweg').lastIndexOf(true)
        expect(firstSpark).toBeGreaterThan(lastOther)
    })

    it('Spark follows runbook 3.4b with backup and the 3.5 rollback path', () => {
        const spark = plan.nodes.find(n => n.nodeId === 'xaventra-spark')!
        const ops = (phase: string) => spark.steps.filter(s => s.phase === phase).map(s => s.op)
        expect(ops('vorher')).toEqual(expect.arrayContaining(['verify-release-on-host', 'extract-program-from-image', 'isolated-lifecycle', 'preflight-running-service', 'check-disk-headroom']))
        expect(ops('sicherung')).toEqual(['stop-service', 'assert-no-writers', 'freeze-runtime-readonly', 'copy-runtime', 'verify-copy-hash', 'save-old-unit'])
        expect(ops('aktivierung')).toEqual(['switch-program-links', 'switch-unit-paths', 'start-service'])
        expect(ops('nachher')).toEqual(expect.arrayContaining(['probe-active', 'probe-version', 'probe-unauthenticated-401', 'probe-model', 'probe-telegram', 'assert-bridge-container-stopped', 'write-receipt']))
        expect(ops('rueckweg')).toEqual(['stop-new-service', 'assert-mainpid-zero', 'restore-old-unit', 'daemon-reload', 'unmount-readonly-bind', 'start-old-service', 'verify-old-version', 'verify-telegram-exclusive'])
        expect(spark.steps.find(s => s.op === 'extract-program-from-image')!.params.image).toBe(release.artifacts[1].image)
        expect(spark.steps.find(s => s.op === 'check-disk-headroom')!.params.minFreeGiB).toBe(40)
        expect(JSON.stringify(spark)).not.toMatch(/docker (run|start)|start-container/)
    })

    it('NAS is swapped like a worker but the host is never restarted', () => {
        const nas = plan.nodes.find(n => n.nodeId === 'xaventra-nas')!
        expect(nas.hostRestart).toBe(false)
        expect(nas.steps.some(s => /reboot|restart-host|shutdown|power/.test(s.op))).toBe(false)
        expect(nas.steps.find(s => s.op === 'backup-runtime')!.params.reflink).toBe(true)
        expect(nas.steps.map(s => s.op)).toContain('disable-telegram-config')
        for (const node of plan.nodes) expect(node.steps.some(s => /reboot|restart-host/.test(s.op))).toBe(false)
        expect(plan.invariants.join('\n')).toContain('NAS nie neu starten')
    })

    it('container workers follow the worker swap with backup, verified image and rollback container', () => {
        const ns1 = plan.nodes.find(n => n.nodeId === 'xaventra-ns1')!
        const ops = ns1.steps.map(s => s.op)
        expect(ops).toEqual(expect.arrayContaining(['inspect-running', 'assert-rollback-name-free', 'pull-image-by-digest', 'verify-image-labels', 'stop-container', 'backup-runtime', 'verify-backup', 'rename-to-rollback', 'run-new-container', 'probe-container']))
        expect(ns1.steps.find(s => s.op === 'verify-image-labels')!.params).toMatchObject({ version: '2.81.0', revision: release.commit, architecture: 'amd64' })
        expect(ns1.steps.filter(s => s.phase === 'rueckweg').map(s => s.op)).toEqual(['stop-new-container', 'start-rollback-container', 'verify-old-version'])
        expect(ns1.steps.find(s => s.op === 'run-new-container')!.params.env).toMatchObject({ NOVA_NODE_ONLY: 'true', NOVA_NO_TELEGRAM: 'true' })
    })

    it('is deterministic, hash-bound and skips nodes that are already current', () => {
        expect(planHash(buildActivationPlan(release, fleet))).toBe(planHash(plan))
        expect(planHash(plan)).toMatch(/^[a-f0-9]{64}$/)
        const partial = buildActivationPlan(release, fleet.map(n => n.nodeId === 'xaventra-ns1' ? { ...n, currentVersion: '2.81.0' } : n))
        expect(partial.order).not.toContain('xaventra-ns1')
        expect(partial.skipped.map(s => s.nodeId)).toContain('xaventra-ns1')
        expect(summarizeActivationPlan(plan)).toContain('xaventra-spark (zuletzt)')
    })

    it('refuses a plan without the matching architecture descriptor or with two native mains', () => {
        expect(() => buildActivationPlan({ ...release, artifacts: [release.artifacts[0]] }, fleet)).toThrow(/arm64/)
        expect(() => buildActivationPlan(release, [...fleet, { nodeId: 'spark2', kind: 'native-spark', arch: 'arm64', currentVersion: '2.80.0' }])).toThrow(/Spark/)
    })
})
