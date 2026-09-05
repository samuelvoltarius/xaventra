import type { UpdateConfig, UpdateNodeConfig } from '../core/auto-updater.js'

export function selectReleaseTargets(config: UpdateConfig, rawNodeIds?: string): UpdateConfig {
    if (!rawNodeIds?.trim()) return config
    const requested = [...new Set(rawNodeIds.split(',').map(value => value.trim()).filter(Boolean))]
    if (!requested.length) throw new Error('release target allowlist is empty')
    const configured = new Map(config.nodes.map(node => [node.nodeId, node] as const))
    const unknown = requested.filter(nodeId => !configured.has(nodeId))
    if (unknown.length) throw new Error(`release target allowlist contains unknown node(s): ${unknown.join(', ')}`)
    const nodes = requested.map(nodeId => configured.get(nodeId) as UpdateNodeConfig)
    return { ...config, nodes, canaryCount: Math.min(config.canaryCount || 1, nodes.length) }
}
