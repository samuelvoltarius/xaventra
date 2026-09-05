import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { recordMeshEvent, withSpan } from '../infra/telemetry.js'
import { MeshIdentity } from './mesh-identity.js'
import { MeshPolicy, type MeshTrustConfig } from './mesh-policy.js'
import type { MeshAck, MeshEnvelope, MeshEnvelopeKind, MeshFence, MeshHandler, MeshPeer, MeshPrincipal, MeshTransport, MeshTransportHealth } from './transport-contracts.js'

interface OutboxItem { peerId: string; envelope: MeshEnvelope; attempts: number; nextAttemptAt: number; lastError?: string }

class MeshOutbox {
    private items: OutboxItem[] = []
    constructor(private readonly path = join(getNovaDataDir(), 'mesh-outbox.json')) {
        try { this.items = JSON.parse(readFileSync(path, 'utf8')) as OutboxItem[] } catch { this.items = [] }
        this.compactStateUpdates()
    }
    add(peerId: string, envelope: MeshEnvelope, reason?: string): void {
        if (this.items.some(item => item.envelope.id === envelope.id && item.peerId === peerId)) return
        if (STATE_UPDATE_KINDS.has(envelope.kind)) {
            this.items = this.items.filter(item => item.peerId !== peerId || item.envelope.kind !== envelope.kind)
        }
        this.items.push({ peerId, envelope, attempts: 0, nextAttemptAt: Date.now() + 2000, lastError: reason })
        this.persist()
    }
    due(now = Date.now()): OutboxItem[] { return this.items.filter(item => item.nextAttemptAt <= now && item.envelope.expiresAt > now) }
    complete(item: OutboxItem): void { this.items = this.items.filter(candidate => candidate !== item); this.persist() }
    fail(item: OutboxItem, reason?: string): void {
        item.attempts++; item.lastError = reason; item.nextAttemptAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(item.attempts, 6)); this.persist()
    }
    prune(): void { const before = this.items.length; this.items = this.items.filter(item => item.envelope.expiresAt > Date.now()); if (before !== this.items.length) this.persist() }
    size(): number { return this.items.length }
    private compactStateUpdates(): void {
        const latest = new Map<string, OutboxItem>()
        const durable: OutboxItem[] = []
        for (const item of this.items) {
            if (!STATE_UPDATE_KINDS.has(item.envelope.kind)) { durable.push(item); continue }
            const key = `${item.peerId}:${item.envelope.kind}`
            const previous = latest.get(key)
            if (!previous || previous.envelope.createdAt < item.envelope.createdAt) latest.set(key, item)
        }
        const compacted = [...durable, ...latest.values()]
        if (compacted.length !== this.items.length) {
            this.items = compacted
            this.persist()
        }
    }
    private persist(): void {
        const dir = dirname(this.path); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const temporary = `${this.path}.tmp`; writeFileSync(temporary, JSON.stringify(this.items, null, 2)); renameSync(temporary, this.path)
    }
}

const STATE_UPDATE_KINDS = new Set(['node.heartbeat', 'node.capabilities', 'node.tools'])

export class MeshTransportRouter implements MeshTransport {
    readonly name = 'outbox' as const
    private readonly handlers = new Set<MeshHandler>()
    private readonly outbox = new MeshOutbox()
    private readonly policy: MeshPolicy
    private retryTimer: ReturnType<typeof setInterval> | null = null
    private lastSuccessAt?: number
    private lastError?: string

    constructor(
        readonly identity: MeshIdentity,
        readonly principal: MeshPrincipal,
        private readonly trust: MeshTrustConfig,
        private readonly transports: MeshTransport[],
    ) {
        this.policy = new MeshPolicy(trust, identity.nodeId)
        for (const transport of transports) transport.subscribe(envelope => this.receive(envelope))
        this.retryTimer = setInterval(() => { void this.flushOutbox() }, 3000)
        if (this.retryTimer.unref) this.retryTimer.unref()
    }

    create<T>(kind: MeshEnvelopeKind, targetNode: string | '*', payload: T, options: { runId?: string; fence?: MeshFence; ttlMs?: number; principal?: MeshPrincipal } = {}): MeshEnvelope<T> {
        return this.identity.create({ kind, targetNode, payload, principal: options.principal || this.principal, runId: options.runId, fence: options.fence, ttlMs: options.ttlMs })
    }

    async discover(): Promise<MeshPeer[]> {
        const all = (await Promise.all(this.transports.map(transport => transport.discover().catch(() => [])))).flat()
        const unique = new Map<string, MeshPeer>()
        for (const peer of [...this.trust.peers, ...all]) {
            const key = `${peer.nodeId}:${peer.transport}`
            const previous = unique.get(key)
            unique.set(key, previous?.status === 'online' ? previous : peer)
        }
        return [...unique.values()]
    }

    async connect(peer: MeshPeer): Promise<void> {
        const transport = this.transports.find(item => item.name === peer.transport)
        if (!transport) throw new Error(`transport not available: ${peer.transport}`)
        await transport.connect(peer)
    }

    async send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck> {
        return withSpan('nova.mesh.send', {
            'nova.mesh.kind': envelope.kind,
            'nova.mesh.source_node': envelope.sourceNode,
            'nova.mesh.target_node': peerId,
        }, async () => {
            const ordered = await this.orderFor(peerId)
            let last: MeshAck | undefined
            for (const transport of ordered) {
                const ack = await transport.send(peerId, envelope)
                last = ack
                recordMeshEvent({ event: 'envelope', nodeId: peerId, kind: envelope.kind, direction: 'outbound', transport: transport.name, status: ack.status })
                if (ack.status === 'delivered' || ack.status === 'duplicate' || ack.status === 'queued') {
                    this.lastSuccessAt = Date.now(); this.lastError = undefined
                    return ack
                }
                // Authentication/policy rejection is terminal. Retrying the same
                // signed envelope via another transport must never bypass policy.
                if (ack.status === 'rejected') return ack
            }
            this.lastError = last?.reason || 'no healthy transport'
            this.outbox.add(peerId, envelope, this.lastError)
            recordMeshEvent({ event: 'envelope', nodeId: peerId, kind: envelope.kind, direction: 'outbound', transport: 'outbox', status: 'queued' })
            return { envelopeId: envelope.id, peerId, status: 'queued', transport: 'outbox', timestamp: Date.now(), reason: this.lastError }
        })
    }

    async broadcast(envelope: MeshEnvelope): Promise<void> {
        const peers = [...new Set((await this.discover()).map(peer => peer.nodeId).filter(id => id !== this.identity.nodeId))]
        await Promise.all(peers.map(peer => this.send(peer, envelope)))
    }
    subscribe(handler: MeshHandler): void { this.handlers.add(handler) }
    health(): MeshTransportHealth {
        const health = this.transports.map(transport => transport.health())
        return {
            name: this.name, healthy: health.some(item => item.healthy) || this.trust.mode === 'standalone',
            connectedPeers: Math.max(0, ...health.map(item => item.connectedPeers)), queued: this.outbox.size(),
            lastSuccessAt: this.lastSuccessAt, lastError: this.lastError,
            encrypted: health.filter(item => item.healthy).every(item => item.encrypted !== false),
            authenticated: health.filter(item => item.healthy).every(item => item.authenticated !== false),
        }
    }
    transportHealth(): MeshTransportHealth[] { return this.transports.map(transport => transport.health()) }
    async close(): Promise<void> {
        if (this.retryTimer) clearInterval(this.retryTimer); this.retryTimer = null
        await Promise.all(this.transports.map(transport => transport.close?.()))
    }

    private async receive(envelope: MeshEnvelope): Promise<void> {
        const decision = this.policy.verify(envelope)
        if (decision.duplicate) {
            recordMeshEvent({ event: 'envelope', nodeId: envelope.sourceNode, kind: envelope.kind, direction: 'inbound', status: 'duplicate' })
            return
        }
        if (!decision.accepted) {
            recordMeshEvent({ event: 'envelope', nodeId: envelope.sourceNode, kind: envelope.kind, direction: 'inbound', status: 'rejected' })
            throw new Error(decision.reason || 'mesh policy rejected envelope')
        }
        recordMeshEvent({ event: 'envelope', nodeId: envelope.sourceNode, kind: envelope.kind, direction: 'inbound', status: 'accepted' })
        for (const handler of this.handlers) await handler(envelope)
    }

    private async orderFor(peerId: string): Promise<MeshTransport[]> {
        const locals = await this.transports.find(item => item.name === 'local')?.discover().catch(() => []) || []
        const hasLocal = locals.some(peer => peer.nodeId === peerId)
        const byName = (name: MeshTransport['name']) => this.transports.find(item => item.name === name)
        const names: MeshTransport['name'][] = this.trust.mode === 'ha'
            ? ['direct', ...(hasLocal ? ['local' as const] : []), 'supabase', 'relay']
            : this.trust.mode === 'direct'
                ? ['direct', ...(hasLocal ? ['local' as const] : []), 'relay']
                : ['direct', ...(hasLocal ? ['local' as const] : [])]
        return names.map(byName).filter((item): item is MeshTransport => Boolean(item) && item!.health().healthy)
    }

    private async flushOutbox(): Promise<void> {
        this.outbox.prune()
        for (const item of this.outbox.due()) {
            const ordered = await this.orderFor(item.peerId)
            let delivered = false
            let reason = 'no healthy transport'
            for (const transport of ordered) {
                const ack = await transport.send(item.peerId, item.envelope)
                if (['delivered', 'duplicate', 'queued'].includes(ack.status)) { delivered = true; break }
                reason = ack.reason || reason
            }
            if (delivered) this.outbox.complete(item); else this.outbox.fail(item, reason)
        }
    }
}
