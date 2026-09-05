import { isIP } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { MeshIdentity } from './mesh-identity.js'
import type { MeshAck, MeshEnvelope, MeshHandler, MeshPeer, MeshPrincipal, MeshTransport, MeshTransportHealth } from './transport-contracts.js'

interface DirectConfig {
    listenHost?: string
    port?: number
    peers?: MeshPeer[]
    allowInsecureLan?: boolean
    ackTimeoutMs?: number
}

interface PendingAck { resolve: (ack: MeshAck) => void; timeout: ReturnType<typeof setTimeout> }

function hostFromUrl(url: string): string {
    try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return '' }
}

function isPrivateEncryptedPath(url: string): boolean {
    try {
        const parsed = new URL(url)
        if (parsed.protocol === 'wss:') return true
        const host = parsed.hostname.replace(/^\[|\]$/g, '')
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
        if (isIP(host) === 4) {
            const [a, b] = host.split('.').map(Number)
            return a === 100 && b >= 64 && b <= 127 // Tailscale CGNAT range (WireGuard encrypted)
        }
    } catch { /* invalid URL */ }
    return false
}

export class DirectMeshTransport implements MeshTransport {
    readonly name = 'direct' as const
    private readonly peers: MeshPeer[]
    private readonly sockets = new Map<string, WebSocket>()
    private readonly peerBySocket = new WeakMap<WebSocket, string>()
    private readonly pending = new Map<string, PendingAck>()
    private readonly handlers = new Set<MeshHandler>()
    private server: WebSocketServer | null = null
    private lastSuccessAt?: number
    private lastError?: string

    constructor(private readonly identity: MeshIdentity, private readonly principal: MeshPrincipal, private readonly config: DirectConfig = {}) {
        this.peers = (config.peers || []).filter(peer => peer.transport === 'direct' || Boolean(peer.url))
    }

    start(): void {
        if (this.server || this.config.port == null) return
        this.server = new WebSocketServer({ host: this.config.listenHost || '0.0.0.0', port: this.config.port })
        this.server.on('connection', (socket, request) => {
            const remote = request.socket.remoteAddress || ''
            const secure = Boolean((request.socket as any).encrypted) || /^(?:::ffff:)?100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(remote) || /127\.0\.0\.1|::1/.test(remote)
            if (!secure && !this.config.allowInsecureLan) {
                socket.close(1008, 'direct mesh requires Tailscale or TLS')
                return
            }
            this.bind(socket)
        })
        this.server.on('error', error => { this.lastError = String(error) })
    }

    async discover(): Promise<MeshPeer[]> {
        return this.peers.map(peer => ({ ...peer, status: this.sockets.get(peer.nodeId)?.readyState === WebSocket.OPEN ? 'online' : peer.status || 'unknown' }))
    }

    addPeer(peer: MeshPeer): void {
        const index = this.peers.findIndex(item => item.nodeId === peer.nodeId)
        if (index >= 0) this.peers[index] = { ...this.peers[index], ...peer, transport: 'direct' }
        else this.peers.push({ ...peer, transport: 'direct' })
    }

    async connect(peer: MeshPeer): Promise<void> {
        if (this.sockets.get(peer.nodeId)?.readyState === WebSocket.OPEN) return
        if (!peer.url) throw new Error(`direct peer ${peer.nodeId} has no URL`)
        if (!this.config.allowInsecureLan && !isPrivateEncryptedPath(peer.url)) throw new Error(`unencrypted direct URL rejected: ${hostFromUrl(peer.url)}`)
        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(peer.url!)
            const timeout = setTimeout(() => { socket.terminate(); reject(new Error(`direct connect timeout: ${peer.nodeId}`)) }, 5000)
            socket.once('open', async () => {
                clearTimeout(timeout)
                this.sockets.set(peer.nodeId, socket)
                this.peerBySocket.set(socket, peer.nodeId)
                this.bind(socket)
                try {
                    const hello = this.identity.create({ kind: 'mesh.hello', targetNode: peer.nodeId, principal: this.principal, payload: { protocol: 1, nodeId: this.identity.nodeId } })
                    const ack = await this.sendOnSocket(peer.nodeId, socket, hello)
                    if (ack.status !== 'delivered' && ack.status !== 'duplicate') throw new Error(ack.reason || 'hello rejected')
                    resolve()
                } catch (error) { socket.close(); reject(error) }
            })
            socket.once('error', error => { clearTimeout(timeout); this.lastError = String(error); reject(error) })
        })
    }

    async send(peerId: string, envelope: MeshEnvelope): Promise<MeshAck> {
        const peer = this.peers.find(item => item.nodeId === peerId)
        try {
            if (!this.sockets.get(peerId) || this.sockets.get(peerId)?.readyState !== WebSocket.OPEN) {
                if (!peer) return this.ack(envelope.id, peerId, 'unreachable', 'unknown direct peer')
                await this.connect(peer)
            }
            return await this.sendOnSocket(peerId, this.sockets.get(peerId)!, envelope)
        } catch (error) {
            this.lastError = String(error)
            return this.ack(envelope.id, peerId, 'unreachable', String(error).slice(0, 200))
        }
    }

    async broadcast(envelope: MeshEnvelope): Promise<void> {
        await Promise.all(this.peers.map(peer => this.send(peer.nodeId, envelope)))
    }

    subscribe(handler: MeshHandler): void { this.handlers.add(handler) }
    health(): MeshTransportHealth {
        return {
            name: this.name, healthy: Boolean(this.server) || this.peers.length > 0 || [...this.sockets.values()].some(socket => socket.readyState === WebSocket.OPEN),
            connectedPeers: [...this.sockets.values()].filter(socket => socket.readyState === WebSocket.OPEN).length,
            queued: this.pending.size, lastSuccessAt: this.lastSuccessAt, lastError: this.lastError,
            encrypted: true, authenticated: true,
        }
    }

    listeningPort(): number | null {
        const address = this.server?.address()
        return address && typeof address === 'object' ? address.port : null
    }

    async close(): Promise<void> {
        for (const socket of this.sockets.values()) socket.close()
        this.sockets.clear()
        await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
        this.server = null
    }

    private bind(socket: WebSocket): void {
        socket.on('message', raw => { void this.receive(socket, raw.toString()) })
        socket.on('close', () => {
            const peer = this.peerBySocket.get(socket)
            if (peer && this.sockets.get(peer) === socket) this.sockets.delete(peer)
        })
        socket.on('error', error => { this.lastError = String(error) })
    }

    private async receive(socket: WebSocket, raw: string): Promise<void> {
        let envelope: MeshEnvelope
        try { envelope = JSON.parse(raw) as MeshEnvelope } catch { socket.close(1007, 'invalid JSON'); return }
        try {
            for (const handler of this.handlers) await handler(envelope)
            if (envelope.kind === 'mesh.ack') {
                const ack = envelope.payload as MeshAck
                const pending = this.pending.get(ack.envelopeId)
                if (pending) { clearTimeout(pending.timeout); this.pending.delete(ack.envelopeId); pending.resolve(ack) }
                return
            }
            const known = this.peerBySocket.get(socket)
            if (!known || known !== envelope.sourceNode) {
                this.peerBySocket.set(socket, envelope.sourceNode)
                this.sockets.set(envelope.sourceNode, socket)
            }
            await this.sendAck(socket, envelope, 'delivered')
            this.lastSuccessAt = Date.now()
        } catch (error) {
            if (envelope.kind !== 'mesh.ack') await this.sendAck(socket, envelope, 'rejected', String(error).slice(0, 180))
        }
    }

    private sendOnSocket(peerId: string, socket: WebSocket, envelope: MeshEnvelope): Promise<MeshAck> {
        return new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.pending.delete(envelope.id)
                resolve(this.ack(envelope.id, peerId, 'unreachable', 'ack timeout'))
            }, this.config.ackTimeoutMs || 5000)
            this.pending.set(envelope.id, { resolve, timeout })
            socket.send(JSON.stringify(envelope), error => {
                if (!error) return
                clearTimeout(timeout); this.pending.delete(envelope.id)
                resolve(this.ack(envelope.id, peerId, 'unreachable', String(error)))
            })
        })
    }

    private async sendAck(socket: WebSocket, received: MeshEnvelope, status: MeshAck['status'], reason?: string): Promise<void> {
        const ack = this.ack(received.id, this.identity.nodeId, status, reason)
        const envelope = this.identity.create({ kind: 'mesh.ack', targetNode: received.sourceNode, principal: this.principal, payload: ack })
        await new Promise<void>(resolve => socket.send(JSON.stringify(envelope), () => resolve()))
    }

    private ack(envelopeId: string, peerId: string, status: MeshAck['status'], reason?: string): MeshAck {
        return { envelopeId, peerId, status, transport: this.name, timestamp: Date.now(), reason }
    }
}
