import type { MeshAck, MeshEnvelope, MeshHandler, MeshPeer, MeshTransport, MeshTransportHealth } from './transport-contracts.js'

interface RelayConfig { url?: string; token?: string; pollMs?: number }

function encryptedRelayPath(url?: string): boolean {
    if (!url) return false
    try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:') return true
        if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return true
        const match = parsed.hostname.match(/^100\.(\d+)\./)
        return parsed.protocol === 'http:' && Boolean(match) && Number(match![1]) >= 64 && Number(match![1]) <= 127
    } catch { return false }
}

export class RelayMeshTransport implements MeshTransport {
    readonly name = 'relay' as const
    private handlers = new Set<MeshHandler>()
    private timer: ReturnType<typeof setInterval> | null = null
    private lastSuccessAt?: number
    private lastError?: string
    private queued = 0
    private polling = false
    constructor(private readonly nodeId: string, private readonly config: RelayConfig) {}

    async discover(): Promise<MeshPeer[]> {
        if (!this.config.url || !this.config.token) return []
        try {
            const response = await fetch(`${this.config.url.replace(/\/$/, '')}/peers`, { headers: this.headers(), signal: AbortSignal.timeout(3000) })
            if (!response.ok) throw new Error(`relay discover ${response.status}`)
            const rows = await response.json() as Array<{ nodeId?: string; lastSeen?: number }>
            return rows.filter(row => row.nodeId && row.nodeId !== this.nodeId).map(row => ({ nodeId: row.nodeId!, transport: 'relay' as const, status: 'online' as const, lastSeen: row.lastSeen }))
        } catch (error) { this.lastError = String(error); return [] }
    }
    async connect(_peer: MeshPeer): Promise<void> { if (!this.config.url) throw new Error('relay not configured') }
    async send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck> {
        if (!this.config.url) return this.ack(envelope.id, peerId, 'unreachable', 'relay not configured')
        try {
            const response = await fetch(`${this.config.url.replace(/\/$/, '')}/envelopes`, {
                method: 'POST', headers: this.headers(), body: JSON.stringify({ to: peerId, envelope }), signal: AbortSignal.timeout(5000),
            })
            if (!response.ok) throw new Error(`relay send ${response.status}`)
            this.lastSuccessAt = Date.now()
            return this.ack(envelope.id, peerId, 'queued')
        } catch (error) { this.lastError = String(error); return this.ack(envelope.id, peerId, 'unreachable', this.lastError.slice(0, 180)) }
    }
    async broadcast(envelope: MeshEnvelope): Promise<void> { await this.send('*', envelope) }
    subscribe(handler: MeshHandler): void {
        this.handlers.add(handler)
        if (!this.timer && this.config.url) {
            void this.poll()
            this.timer = setInterval(() => { void this.poll() }, this.config.pollMs || 3000)
            if (this.timer.unref) this.timer.unref()
        }
    }
    health(): MeshTransportHealth {
        return { name: this.name, healthy: Boolean(this.config.url && this.config.token) && !this.lastError, connectedPeers: 0, queued: this.queued, lastSuccessAt: this.lastSuccessAt, lastError: this.lastError, encrypted: encryptedRelayPath(this.config.url), authenticated: Boolean(this.config.token) }
    }
    async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null }

    private async poll(): Promise<void> {
        if (!this.config.url || this.polling) return
        this.polling = true
        try {
            const response = await fetch(`${this.config.url.replace(/\/$/, '')}/envelopes?to=${encodeURIComponent(this.nodeId)}&limit=100`, { headers: this.headers(), signal: AbortSignal.timeout(5000) })
            if (!response.ok) throw new Error(`relay poll ${response.status}`)
            const rows = await response.json() as Array<{ receipt?: string; envelope: MeshEnvelope }>
            this.queued = rows.length
            for (const row of rows) {
                for (const handler of this.handlers) await handler(row.envelope)
                if (row.receipt) await fetch(`${this.config.url.replace(/\/$/, '')}/envelopes/${encodeURIComponent(row.receipt)}/ack`, { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(5000) })
                this.queued = Math.max(0, this.queued - 1)
            }
            this.lastSuccessAt = Date.now(); this.lastError = undefined
        } catch (error) { this.lastError = String(error) }
        finally { this.polling = false }
    }
    private headers(): Record<string, string> { return { 'Content-Type': 'application/json', ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}) } }
    private ack(envelopeId: string, peerId: string, status: MeshAck['status'], reason?: string): MeshAck { return { envelopeId, peerId, status, transport: this.name, timestamp: Date.now(), reason } }
}
