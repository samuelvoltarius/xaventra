/**
 * Wächter — worker samples on the Main. The mesh router has already checked
 * the envelope signature against the trusted key; on top of that a sample is
 * only stored when
 *   - the watch is on and this node is the Main,
 *   - the sender is a configured peer WITH a pinned public key (no
 *     trust-on-first-use node, no unknown node),
 *   - the sample names the sender itself (no relaying for others),
 *   - its time is plausible (≤ 5 min in the future, ≤ 24 h old),
 *   - the sender did not already deliver one within the last 60 s.
 */
import { sanitizeWatchSample } from './sample.js'
import { appendWatchSample } from './store.js'

export interface PeerSampleInput {
    sourceNode: string
    payload: unknown
    /** Node ids of configured peers that carry a publicKey. */
    knownNodes: readonly string[]
    localNodeId: string
}

export interface PeerSampleContext {
    enabled: boolean
    isMain: boolean
    watchDir: string
    maxBytes: number
    now: number
    /** Last accepted sample per node (ms); updated in place. */
    lastAccepted: Map<string, number>
}

const MIN_GAP_MS = 60_000
const MAX_FUTURE_MS = 5 * 60_000
const MAX_AGE_MS = 24 * 60 * 60_000

export function acceptPeerWatchSample(input: PeerSampleInput, ctx: PeerSampleContext): { accepted: boolean; reason: string } {
    if (!ctx.enabled) return { accepted: false, reason: 'aus' }
    if (!ctx.isMain) return { accepted: false, reason: 'kein Main' }
    const source = String(input.sourceNode || '')
    if (!source || source === input.localNodeId) return { accepted: false, reason: 'eigener oder leerer Absender' }
    if (!input.knownNodes.includes(source)) return { accepted: false, reason: 'unbekannter Knoten (kein konfigurierter Peer mit Schlüssel)' }
    const sample = sanitizeWatchSample(input.payload)
    if (!sample) return { accepted: false, reason: 'ungültiger Messwert' }
    if (sample.agg) return { accepted: false, reason: 'verdichtete Werte werden nicht angenommen' }
    if (sample.nodeId !== source) return { accepted: false, reason: 'Messwert nennt einen anderen Knoten' }
    const at = Date.parse(sample.at)
    if (at > ctx.now + MAX_FUTURE_MS || at < ctx.now - MAX_AGE_MS) return { accepted: false, reason: 'Zeitstempel unplausibel' }
    const last = ctx.lastAccepted.get(source)
    if (last !== undefined && ctx.now - last < MIN_GAP_MS) return { accepted: false, reason: 'zu häufig' }
    if (!appendWatchSample(ctx.watchDir, sample, ctx.maxBytes)) return { accepted: false, reason: 'Größengrenze erreicht' }
    ctx.lastAccepted.set(source, ctx.now)
    return { accepted: true, reason: 'gespeichert' }
}
