export type MeshNodeLifecycle = 'active' | 'offline' | 'retired' | 'tombstoned'

export const NODE_OFFLINE_AFTER_MS = 5 * 60 * 1000
export const NODE_RETIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface NodeLifecycleEvidence {
    lastHeartbeat?: string
    lifecycleState?: string
}

export function resolveNodeLifecycle(
    evidence: NodeLifecycleEvidence,
    now = Date.now(),
): MeshNodeLifecycle {
    if (evidence.lifecycleState === 'tombstoned') return 'tombstoned'
    if (evidence.lifecycleState === 'retired') return 'retired'

    const heartbeat = Date.parse(evidence.lastHeartbeat || '')
    if (!Number.isFinite(heartbeat)) return 'offline'
    const age = Math.max(0, now - heartbeat)
    if (age > NODE_RETIRE_AFTER_MS) return 'retired'
    if (age > NODE_OFFLINE_AFTER_MS) return 'offline'
    return 'active'
}

export function isNodeVisibleByDefault(lifecycle: MeshNodeLifecycle): boolean {
    return lifecycle === 'active' || lifecycle === 'offline'
}

export function isActiveNode(lifecycle: MeshNodeLifecycle): boolean {
    return lifecycle === 'active'
}
