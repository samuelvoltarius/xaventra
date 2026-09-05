/**
 * Nova Mesh Event Hub — Real-time Pub/Sub via WebSockets
 * 
 * Enables instant communication between all Nova nodes:
 * - Nero (Sentinel) fires: office:person_detected → all Novas react instantly
 * - Nova fires: task:completed → other nodes learn
 * - No polling, no DB queries — pure real-time
 * 
 * Architecture:
 * - Main node runs WS server (port 9090)
 * - Edge nodes connect as WS clients
 * - All events are broadcast to all connected nodes
 */

import { WebSocketServer, WebSocket } from 'ws'

// ============================================
// Types
// ============================================

export interface MeshEvent {
    type: string           // e.g. 'office:person_detected', 'mesh:model_loaded'
    source: string         // Node ID that fired the event
    data: unknown          // Event payload
    timestamp: number
}

type EventHandler = (event: MeshEvent) => void | Promise<void>

// ============================================
// Mesh Hub (Server — runs on Main node)
// ============================================

let wss: WebSocketServer | null = null
const connectedClients = new Map<string, WebSocket>()

export function startMeshHub(port = 9090): void {
    if (wss) return

    wss = new WebSocketServer({ port, host: '0.0.0.0' })

    wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress || 'unknown'
        let clientId = `node-${clientIp}`

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString())

                // Registration message
                if (msg.type === 'mesh:register') {
                    clientId = msg.data?.nodeId || clientId
                    connectedClients.set(clientId, ws)
                    console.log(`[MeshHub] 🟢 Node registered: ${clientId} (${clientIp})`)
                    // Send welcome
                    ws.send(JSON.stringify({
                        type: 'mesh:welcome',
                        source: 'hub',
                        data: { connectedNodes: Array.from(connectedClients.keys()) },
                        timestamp: Date.now(),
                    }))
                    return
                }

                // Broadcast event to all OTHER clients
                const event: MeshEvent = {
                    type: msg.type,
                    source: msg.source || clientId,
                    data: msg.data,
                    timestamp: msg.timestamp || Date.now(),
                }

                // Handle locally
                handleEvent(event)

                // Broadcast
                broadcastToOthers(event, clientId)

            } catch (err) {
                console.log(`[MeshHub] ⚠️ Invalid message from ${clientId}: ${err}`)
            }
        })

        ws.on('close', () => {
            connectedClients.delete(clientId)
            console.log(`[MeshHub] 🔴 Node disconnected: ${clientId}`)
        })

        ws.on('error', (err) => {
            console.log(`[MeshHub] ⚠️ WebSocket error from ${clientId}: ${err.message}`)
        })
    })

    console.log(`[MeshHub] ✅ Server started on port ${port} — waiting for nodes...`)
}

function broadcastToOthers(event: MeshEvent, excludeId: string): void {
    const msg = JSON.stringify(event)
    for (const [id, ws] of connectedClients) {
        if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
            ws.send(msg)
        }
    }
}

// ============================================
// Mesh Client (runs on Edge nodes)
// ============================================

let clientWs: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let clientNodeId = ''

export function connectToMeshHub(hubUrl: string, nodeId: string): void {
    clientNodeId = nodeId

    function connect(): void {
        try {
            clientWs = new WebSocket(hubUrl)

            clientWs.on('open', () => {
                console.log(`[MeshClient] 🟢 Connected to hub: ${hubUrl}`)
                // Register
                clientWs!.send(JSON.stringify({
                    type: 'mesh:register',
                    source: nodeId,
                    data: { nodeId },
                    timestamp: Date.now(),
                }))
            })

            clientWs.on('message', (raw) => {
                try {
                    const event: MeshEvent = JSON.parse(raw.toString())
                    handleEvent(event)
                } catch { /* ignore malformed */ }
            })

            clientWs.on('close', () => {
                console.log(`[MeshClient] 🔴 Disconnected — reconnecting in 10s...`)
                scheduleReconnect(hubUrl, nodeId)
            })

            clientWs.on('error', () => {
                scheduleReconnect(hubUrl, nodeId)
            })

        } catch {
            scheduleReconnect(hubUrl, nodeId)
        }
    }

    connect()
}

function scheduleReconnect(hubUrl: string, nodeId: string): void {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connectToMeshHub(hubUrl, nodeId)
    }, 10_000)
}

// ============================================
// Event System (Pub/Sub)
// ============================================

const eventHandlers = new Map<string, EventHandler[]>()

/**
 * Subscribe to mesh events
 * Examples:
 *   on('office:person_detected', handler)
 *   on('mesh:*', handler)  — wildcard
 *   on('task:completed', handler)
 */
export function on(eventType: string, handler: EventHandler): void {
    if (!eventHandlers.has(eventType)) {
        eventHandlers.set(eventType, [])
    }
    eventHandlers.get(eventType)!.push(handler)
}

/**
 * Publish an event to the mesh
 */
export function emit(type: string, data: unknown): void {
    const event: MeshEvent = {
        type,
        source: clientNodeId || 'main',
        data,
        timestamp: Date.now(),
    }

    // Handle locally
    handleEvent(event)

    // Send to hub (if client)
    if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(event))
    }

    // Broadcast to clients (if server)
    if (wss) {
        broadcastToOthers(event, 'main')
    }
}

function handleEvent(event: MeshEvent): void {
    // Exact match handlers
    const handlers = eventHandlers.get(event.type) || []
    for (const h of handlers) {
        try { h(event) } catch (err) {
            console.log(`[MeshEvent] ⚠️ Handler error for ${event.type}: ${err}`)
        }
    }

    // Wildcard handlers (e.g. 'office:*' matches 'office:person_detected')
    const prefix = event.type.split(':')[0]
    const wildcardHandlers = eventHandlers.get(`${prefix}:*`) || []
    for (const h of wildcardHandlers) {
        try { h(event) } catch { /* ignore handler errors */ }
    }

    // Global catch-all
    const globalHandlers = eventHandlers.get('*') || []
    for (const h of globalHandlers) {
        try { h(event) } catch { /* ignore */ }
    }
}

// ============================================
// Status
// ============================================

export function getMeshStatus(): {
    role: 'hub' | 'client' | 'disconnected'
    connectedNodes: string[]
    hubUrl?: string
} {
    if (wss) {
        return {
            role: 'hub',
            connectedNodes: Array.from(connectedClients.keys()),
        }
    }
    if (clientWs?.readyState === WebSocket.OPEN) {
        return {
            role: 'client',
            connectedNodes: [clientNodeId],
        }
    }
    return { role: 'disconnected', connectedNodes: [] }
}

/**
 * Initialize mesh events — main starts server, edges connect
 */
export function initMeshEvents(isMain: boolean, hubPort = 9090, hubUrl?: string, nodeId?: string): void {
    if (isMain) {
        startMeshHub(hubPort)
    } else if (hubUrl && nodeId) {
        connectToMeshHub(hubUrl, nodeId)
    }
}
