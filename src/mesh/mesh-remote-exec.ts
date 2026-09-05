// Mesh Remote Execution — Request/Response over WebSocket
// Unlike Event Hub (fire-and-forget), this waits for a response.

import { randomUUID } from 'node:crypto'

// ============================================
// Types
// ============================================

interface RemoteRequest {
    id: string
    from: string
    to: string
    type: 'exec' | 'llm' | 'ollama' | 'tool'
    payload: any
    timestamp: number
}

interface RemoteResponse {
    requestId: string
    from: string
    success: boolean
    result: any
    error?: string
    durationMs: number
}

type RequestHandler = (payload: any) => Promise<any>

// ============================================
// State
// ============================================

const pendingRequests = new Map<string, {
    resolve: (res: RemoteResponse) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
}>()

const handlers = new Map<string, RequestHandler>()

// ============================================
// Core — Send request and wait for response
// ============================================

export async function remoteExec(
    targetNode: string,
    type: RemoteRequest['type'],
    payload: any,
    timeoutMs = 30000
): Promise<RemoteResponse> {
    const request: RemoteRequest = {
        id: randomUUID().slice(0, 12),
        from: process.env.NOVA_NODE_NAME || 'master',
        to: targetNode,
        type,
        payload,
        timestamp: Date.now(),
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingRequests.delete(request.id)
            reject(new Error(`Remote exec timeout after ${timeoutMs}ms (${targetNode}/${type})`))
        }, timeoutMs)

        pendingRequests.set(request.id, { resolve, reject, timeout })

        // Send via Event Hub
        sendViaEventHub(request).catch(err => {
            clearTimeout(timeout)
            pendingRequests.delete(request.id)
            reject(err)
        })
    })
}

// Handle incoming response
export function handleResponse(response: RemoteResponse): void {
    const pending = pendingRequests.get(response.requestId)
    if (pending) {
        clearTimeout(pending.timeout)
        pendingRequests.delete(response.requestId)
        pending.resolve(response)
    }
}

// Handle incoming request (execute locally and send response)
export async function handleRequest(request: RemoteRequest): Promise<void> {
    const handler = handlers.get(request.type)
    const start = Date.now()

    let response: RemoteResponse

    if (handler) {
        try {
            const result = await handler(request.payload)
            response = {
                requestId: request.id,
                from: process.env.NOVA_NODE_NAME || 'master',
                success: true,
                result,
                durationMs: Date.now() - start,
            }
        } catch (err: any) {
            response = {
                requestId: request.id,
                from: process.env.NOVA_NODE_NAME || 'master',
                success: false,
                result: null,
                error: err.message?.slice(0, 200),
                durationMs: Date.now() - start,
            }
        }
    } else {
        response = {
            requestId: request.id,
            from: process.env.NOVA_NODE_NAME || 'master',
            success: false,
            result: null,
            error: `No handler for type: ${request.type}`,
            durationMs: Date.now() - start,
        }
    }

    // Send response back
    sendResponseViaEventHub(response).catch(err => {
        console.log(`[RemoteExec] Failed to send response: ${err.message?.slice(0, 60)}`)
    })
}

// ============================================
// Register handlers for different request types
// ============================================

export function registerHandler(type: string, handler: RequestHandler): void {
    handlers.set(type, handler)
    console.log(`[RemoteExec] Handler registered: ${type}`)
}

// ============================================
// Event Hub integration
// ============================================

async function sendViaEventHub(request: RemoteRequest): Promise<void> {
    try {
        const { emit } = await import('./event-hub.js')
        emit('mesh:remote_request', request)
    } catch (err: any) {
        throw new Error(`Event Hub not available: ${err.message}`)
    }
}

async function sendResponseViaEventHub(response: RemoteResponse): Promise<void> {
    try {
        const { emit } = await import('./event-hub.js')
        emit('mesh:remote_response', response)
    } catch { }
}

// ============================================
// Init — register event listeners
// ============================================

export async function initRemoteExec(): Promise<void> {
    try {
        const { on } = await import('./event-hub.js')
        const myName = process.env.NOVA_NODE_NAME || 'master'

        // Listen for incoming requests addressed to us
        on('mesh:remote_request', async (data: any) => {
            if (data.to === myName || data.to === '*') {
                await handleRequest(data as RemoteRequest)
            }
        })

        // Listen for responses to our requests
        on('mesh:remote_response', (data: any) => {
            handleResponse(data as RemoteResponse)
        })

        console.log(`[RemoteExec] ✅ Listening as "${myName}"`)
    } catch (err) {
        console.log(`[RemoteExec] ⚠️ Event Hub not available: ${err}`)
    }
}
