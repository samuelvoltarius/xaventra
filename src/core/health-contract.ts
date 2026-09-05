export type ProbeState = 'up' | 'down' | 'unknown'

export interface ServiceProbe {
    name: string
    endpoint: string
    state: ProbeState
    checkedAt: number
    latencyMs?: number
    error?: string
}

export interface ReachabilitySnapshot {
    host: ProbeState
    ssh: ProbeState
    services: ServiceProbe[]
}

/** A node is usable when at least one real service responds. SSH is an
 * administration path and must never be treated as the node's liveness. */
export function summarizeReachability(value: ReachabilitySnapshot): 'online' | 'degraded' | 'offline' | 'unknown' {
    const anyServiceUp = value.services.some(service => service.state === 'up')
    if (anyServiceUp) return value.ssh === 'down' ? 'degraded' : 'online'
    if (value.host === 'down' && value.services.every(service => service.state === 'down')) return 'offline'
    if (value.ssh === 'up') return 'degraded'
    return 'unknown'
}

export async function probeHttpService(name: string, endpoint: string, timeoutMs = 3000): Promise<ServiceProbe> {
    const startedAt = Date.now()
    try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) })
        return {
            name,
            endpoint,
            state: response.ok ? 'up' : 'down',
            checkedAt: Date.now(),
            latencyMs: Date.now() - startedAt,
            error: response.ok ? undefined : `HTTP ${response.status}`,
        }
    } catch (error) {
        return {
            name,
            endpoint,
            state: 'down',
            checkedAt: Date.now(),
            latencyMs: Date.now() - startedAt,
            error: String(error).slice(0, 180),
        }
    }
}
