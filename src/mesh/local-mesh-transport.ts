import type { MeshAck, MeshEnvelope, MeshHandler, MeshPeer, MeshTransport, MeshTransportHealth } from './transport-contracts.js'

const buses = new Map<string, LocalMeshTransport>()

export class LocalMeshTransport implements MeshTransport {
    readonly name = 'local' as const
    private handlers = new Set<MeshHandler>()
    private lastSuccessAt?: number

    constructor(readonly nodeId: string) { buses.set(nodeId, this) }

    async discover(): Promise<MeshPeer[]> {
        return [...buses.keys()].map(nodeId => ({ nodeId, transport: 'local', status: 'online', lastSeen: Date.now() }))
    }
    async connect(_peer: MeshPeer): Promise<void> { /* same-process bus requires no connection */ }

    async send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck> {
        const target = buses.get(peerId)
        if (!target) return this.ack(envelope.id, 'unreachable', 'local peer not registered')
        for (const handler of target.handlers) await handler(envelope)
        this.lastSuccessAt = Date.now()
        return this.ack(envelope.id, 'delivered')
    }

    async broadcast(envelope: MeshEnvelope): Promise<void> {
        await Promise.all([...buses.entries()].filter(([id]) => id !== this.nodeId).map(([id]) => this.send(id, envelope)))
    }
    subscribe(handler: MeshHandler): void { this.handlers.add(handler) }
    health(): MeshTransportHealth {
        return { name: this.name, healthy: true, connectedPeers: Math.max(0, buses.size - 1), queued: 0, lastSuccessAt: this.lastSuccessAt, encrypted: true, authenticated: true }
    }
    async close(): Promise<void> { buses.delete(this.nodeId); this.handlers.clear() }
    private ack(envelopeId: string, status: MeshAck['status'], reason?: string): MeshAck {
        return { envelopeId, peerId: this.nodeId, status, transport: this.name, timestamp: Date.now(), reason }
    }
}
