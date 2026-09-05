import type { MeshAck, MeshEnvelope, MeshHandler, MeshPeer, MeshTransport, MeshTransportHealth } from './transport-contracts.js'
import { isNodeVisibleByDefault, resolveNodeLifecycle } from './mesh-node-lifecycle.js'

interface SupabaseTransportConfig { url?: string; key?: string; table?: string; pollMs?: number }

export class SupabaseMeshTransport implements MeshTransport {
    readonly name = 'supabase' as const
    private readonly handlers = new Set<MeshHandler>()
    private timer: ReturnType<typeof setInterval> | null = null
    private lastSuccessAt?: number
    private lastError?: string
    private queued = 0
    private readonly table: string

    constructor(private readonly nodeId: string, private readonly config: SupabaseTransportConfig) {
        this.table = config.table || 'nova_mesh_envelopes'
    }

    async discover(): Promise<MeshPeer[]> {
        if (!this.configured()) return []
        try {
            const query = `nova_mesh_nodes?select=node_id,status,last_heartbeat,lifecycle_state&node_id=neq.${encodeURIComponent(this.nodeId)}&limit=200`
            const response = await fetch(`${this.config.url}/${query}`, { headers: this.headers(), signal: AbortSignal.timeout(3000) })
            if (!response.ok) throw new Error(`Supabase node discovery ${response.status}`)
            const rows = await response.json() as Array<{ node_id?: string; status?: string; last_heartbeat?: string; lifecycle_state?: string }>
            return rows.filter(row => {
                if (!row.node_id) return false
                const lifecycle = resolveNodeLifecycle({ lastHeartbeat: row.last_heartbeat, lifecycleState: row.lifecycle_state })
                return isNodeVisibleByDefault(lifecycle)
            }).map(row => ({
                nodeId: row.node_id!, transport: 'supabase' as const,
                status: resolveNodeLifecycle({ lastHeartbeat: row.last_heartbeat, lifecycleState: row.lifecycle_state }) === 'active'
                    ? 'online' as const
                    : 'offline' as const,
                lastSeen: row.last_heartbeat ? new Date(row.last_heartbeat).getTime() : undefined,
            }))
        } catch (error) {
            this.lastError = String(error)
            return []
        }
    }
    async connect(_peer: MeshPeer): Promise<void> { if (!this.configured()) throw new Error('Supabase mesh transport is not configured') }

    async send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck> {
        if (!this.configured()) return this.ack(envelope.id, peerId, 'unreachable', 'Supabase not configured')
        try {
            const response = await fetch(`${this.config.url}/${this.table}`, {
                method: 'POST', headers: this.headers('return=minimal'),
                body: JSON.stringify({ id: envelope.id, from_node: envelope.sourceNode, to_node: peerId, kind: envelope.kind, envelope, created_at: envelope.createdAt, expires_at: new Date(envelope.expiresAt).toISOString(), delivered: false }),
                signal: AbortSignal.timeout(5000),
            })
            if (!response.ok) throw new Error(`Supabase envelope insert ${response.status}`)
            this.lastSuccessAt = Date.now(); this.queued++
            return this.ack(envelope.id, peerId, 'queued')
        } catch (error) {
            this.lastError = String(error)
            return this.ack(envelope.id, peerId, 'unreachable', this.lastError.slice(0, 180))
        }
    }

    async broadcast(envelope: MeshEnvelope): Promise<void> { await this.send('*', envelope) }
    subscribe(handler: MeshHandler): void {
        this.handlers.add(handler)
        if (!this.timer && this.configured()) {
            void this.poll()
            this.timer = setInterval(() => { void this.poll() }, this.config.pollMs || 3000)
            if (this.timer.unref) this.timer.unref()
        }
    }
    health(): MeshTransportHealth {
        return { name: this.name, healthy: this.configured() && !this.lastError, connectedPeers: 0, queued: this.queued, lastSuccessAt: this.lastSuccessAt, lastError: this.lastError, encrypted: true, authenticated: true }
    }
    async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null }

    private async poll(): Promise<void> {
        try {
            const query = `?or=(to_node.eq.${encodeURIComponent(this.nodeId)},to_node.eq.*)&delivered=eq.false&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.asc&limit=100`
            const response = await fetch(`${this.config.url}/${this.table}${query}`, { headers: this.headers(), signal: AbortSignal.timeout(5000) })
            if (!response.ok) throw new Error(`Supabase envelope poll ${response.status}`)
            const rows = await response.json() as Array<{ id: string; envelope: MeshEnvelope }>
            for (const row of rows) {
                try {
                    for (const handler of this.handlers) await handler(row.envelope)
                    await fetch(`${this.config.url}/${this.table}?id=eq.${encodeURIComponent(row.id)}&delivered=eq.false`, {
                        method: 'PATCH', headers: this.headers('return=minimal'), body: JSON.stringify({ delivered: true, delivered_at: new Date().toISOString() }), signal: AbortSignal.timeout(5000),
                    })
                    this.queued = Math.max(0, this.queued - 1); this.lastSuccessAt = Date.now()
                } catch { /* invalid/untrusted envelope remains for audit and expiry */ }
            }
            this.lastError = undefined
        } catch (error) { this.lastError = String(error) }
    }

    private configured(): boolean { return Boolean(this.config.url && this.config.key) }
    private headers(prefer?: string): Record<string, string> {
        return { 'Content-Type': 'application/json', apikey: this.config.key || '', Authorization: `Bearer ${this.config.key || ''}`, ...(prefer ? { Prefer: prefer } : {}) }
    }
    private ack(envelopeId: string, peerId: string, status: MeshAck['status'], reason?: string): MeshAck {
        return { envelopeId, peerId, status, transport: this.name, timestamp: Date.now(), reason }
    }
}
