import { describe, expect, it } from 'vitest'
import type { UpdateConfig, UpdateNodeConfig } from '../core/auto-updater.js'
import { selectReleaseTargets } from './release-targets.js'

const node = (nodeId: string): UpdateNodeConfig => ({
    nodeId,
    name: nodeId,
    host: `${nodeId}.example`,
    user: 'nova',
    path: '/opt/nova',
    runtime: 'systemd',
    service: 'nova',
})

const config: UpdateConfig = {
    enabled: true,
    notifyOnly: false,
    canaryCount: 2,
    nodes: [node('nova-spark'), node('nova-pi5'), node('nova-worker-a'), node('nova-worker-b')],
}

describe('selectReleaseTargets', () => {
    it('keeps configured targets unchanged when no allowlist is supplied', () => {
        expect(selectReleaseTargets(config).nodes).toEqual(config.nodes)
    })

    it('selects only explicitly allowed targets in operator order', () => {
        const selected = selectReleaseTargets(config, 'nova-spark,nova-worker-a,nova-worker-b,nova-worker-a')
        expect(selected.nodes.map(item => item.nodeId)).toEqual(['nova-spark', 'nova-worker-a', 'nova-worker-b'])
        expect(selected.canaryCount).toBe(2)
    })

    it('fails closed for an unknown target', () => {
        expect(() => selectReleaseTargets(config, 'nova-spark,nova-unknown')).toThrow('unknown node')
    })
})
