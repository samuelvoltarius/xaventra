/**
 * CL-07 receiver-side fencing for mesh workers.
 *
 * A worker remembers, per service, the highest lease epoch it has ever seen on
 * a delegated request (tool.request / agent.request / update.release) and
 * rejects anything older. The high-water mark is persisted and only ever
 * rises, so a restarted worker still refuses a stale Main. Epochs come from
 * the v5 sequence (globally monotone); witness epochs are made monotone in
 * witness-quorum.ts before they are used here.
 */

import { readFileSync } from 'node:fs'
import { getNovaDataDir } from '../core/data-root.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { DelegatedFence, FenceCheck } from './fence.js'

type HighWater = Record<string, number>

function highWaterPath(): string {
    return getNovaDataDir('fence-highwater.json')
}

function load(): HighWater {
    try {
        const parsed = JSON.parse(readFileSync(highWaterPath(), 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const result: HighWater = {}
        for (const [service, epoch] of Object.entries(parsed as Record<string, unknown>)) {
            if (Number.isSafeInteger(epoch) && Number(epoch) > 0) result[service] = Number(epoch)
        }
        return result
    } catch {
        return {}
    }
}

export function getFenceHighWater(service: string): number {
    return load()[service] || 0
}

/** Parse `service:epoch:node` (Supabase), `service:q<epoch>:node` (witness) or
 * `service:e<epoch>:node` (owner-confirmed emergency Main, 2.88). */
export function parseFenceToken(token: string): { service: string; epoch: number; nodeId: string } | null {
    const match = /^(.+):[qe]?(\d+):([^:]+)$/.exec(String(token || ''))
    if (!match) return null
    const epoch = Number(match[2])
    return Number.isSafeInteger(epoch) && epoch > 0 ? { service: match[1], epoch, nodeId: match[3] } : null
}

/**
 * Compare-and-set on the persisted high-water mark. Accepts `epoch >= mark`
 * (equal = same term) and raises the mark; rejects anything lower.
 */
export function observeFenceEpoch(service: string, epoch: number): { accepted: boolean; highWater: number } {
    if (!Number.isSafeInteger(epoch) || epoch < 1) return { accepted: false, highWater: getFenceHighWater(service) }
    const marks = load()
    const current = marks[service] || 0
    if (epoch < current) return { accepted: false, highWater: current }
    if (epoch > current) {
        marks[service] = epoch
        atomicWriteJsonSync(highWaterPath(), marks)
    }
    return { accepted: true, highWater: Math.max(epoch, current) }
}

/**
 * Validates a fence carried by a mesh envelope. Structural + high-water check
 * always; with `live` also the coordinator's read-only nova_check_fence when a
 * Supabase coordinator is configured (ns1 without access: high-water only).
 */
export async function checkDelegatedFence(fence: DelegatedFence, options: { live?: boolean; observe?: boolean } = {}): Promise<FenceCheck> {
    const parsed = parseFenceToken(fence.token)
    if (!parsed || parsed.service !== fence.service || parsed.epoch !== fence.epoch || parsed.nodeId !== fence.sourceNode) {
        return { ok: false, reason: 'fence token does not match service, epoch and sending node' }
    }
    const verdict = options.observe === false
        ? { accepted: fence.epoch >= getFenceHighWater(fence.service), highWater: getFenceHighWater(fence.service) }
        : observeFenceEpoch(fence.service, fence.epoch)
    if (!verdict.accepted) return { ok: false, reason: `stale epoch ${fence.epoch} < high-water ${verdict.highWater}` }
    if (!options.live) return { ok: true, reason: `epoch ${fence.epoch} >= high-water` }
    try {
        const { checkRemoteFence } = await import('./leader-election.js')
        const remote = await checkRemoteFence(fence.service, fence.epoch, fence.sourceNode)
        if (remote.available === false) return { ok: true, reason: `epoch ${fence.epoch} >= high-water; ${remote.reason}` }
        return remote.valid ? { ok: true, reason: remote.reason } : { ok: false, reason: remote.reason }
    } catch (error) {
        return { ok: false, reason: `remote fence check failed (${String(error).slice(0, 120)})` }
    }
}
