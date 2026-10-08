export type MeshNodeLifecycle = 'active' | 'offline' | 'retired' | 'tombstoned'

export const NODE_OFFLINE_AFTER_MS = 5 * 60 * 1000
export const NODE_RETIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Clock skew tolerated for a heartbeat that lies slightly in the future. */
export const HEARTBEAT_FUTURE_SKEW_MS = 30_000

/**
 * THE freshness rule of the mesh: a heartbeat counts only if it exists, is not
 * (far) in the future and is at most NODE_OFFLINE_AFTER_MS old. Anything else
 * (missing, unparsable, stale) is not "online", whatever a stored status says.
 */
export function isHeartbeatFresh(heartbeat: string | number | undefined | null, now = Date.now()): boolean {
    const at = typeof heartbeat === 'number' ? heartbeat : Date.parse(String(heartbeat ?? ''))
    if (!Number.isFinite(at)) return false
    const age = now - at
    return age >= -HEARTBEAT_FUTURE_SKEW_MS && age <= NODE_OFFLINE_AFTER_MS
}

/** "vor 10 min" / "vor 3 Std." / "unbekannt" for the last heartbeat. */
export function describeLastSeen(heartbeat: string | number | undefined | null, now = Date.now()): string {
    const at = typeof heartbeat === 'number' ? heartbeat : Date.parse(String(heartbeat ?? ''))
    if (!Number.isFinite(at)) return 'unbekannt'
    const sec = Math.max(0, Math.round((now - at) / 1000))
    if (sec < 60) return `vor ${sec} s`
    if (sec < 3600) return `vor ${Math.round(sec / 60)} min`
    if (sec < 86400) return `vor ${Math.round(sec / 3600)} Std.`
    return `vor ${Math.round(sec / 86400)} Tg.`
}

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
    const age = now - heartbeat
    if (age > NODE_RETIRE_AFTER_MS) return 'retired'
    return isHeartbeatFresh(heartbeat, now) ? 'active' : 'offline'
}

export function isNodeVisibleByDefault(lifecycle: MeshNodeLifecycle): boolean {
    return lifecycle === 'active' || lifecycle === 'offline'
}

export function isActiveNode(lifecycle: MeshNodeLifecycle): boolean {
    return lifecycle === 'active'
}
