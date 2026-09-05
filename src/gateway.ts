#!/usr/bin/env node
/**
 * Nova - Separate Gateway Process
 * 
 * Runs independently from Nova core.
 * - Monitors Nova process health
 * - Provides Dashboard API even when Nova is down
 * - Can restart Nova on crash
 */

import { createServer } from 'node:http'
import { spawn, ChildProcess } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

interface GatewayState {
    novaProcess: ChildProcess | null
    novaStatus: 'running' | 'stopped' | 'crashed' | 'starting'
    lastCrash?: Date
    crashCount: number
    uptime: number
    startTime?: Date
    logs: string[]
    // Heartbeat
    lastHeartbeat?: Date
    heartbeatMissed: number
    alertSent: boolean
}

interface HeartbeatConfig {
    enabled: boolean
    intervalMs: number
    alertAfterMissed: number
    alertPhone?: string  // WhatsApp number to alert
}

// ============================================
// State
// ============================================

const state: GatewayState = {
    novaProcess: null,
    novaStatus: 'stopped',
    crashCount: 0,
    uptime: 0,
    logs: [],
    heartbeatMissed: 0,
    alertSent: false,
}

const heartbeatConfig: HeartbeatConfig = {
    enabled: true,
    intervalMs: 30000,      // Check every 30 seconds
    alertAfterMissed: 3,    // Alert after 3 missed beats (90s)
    alertPhone: process.env.NOVA_ALERT_PHONE,
}

let heartbeatInterval: NodeJS.Timeout | null = null

interface JsonRpcRequest {
    jsonrpc: '2.0'
    id: string | number
    method: string
    params?: unknown
}

const MAX_LOGS = 500
const clients = new Set<WebSocket>()

// ============================================
// Heartbeat System
// ============================================

function startHeartbeat(): void {
    if (!heartbeatConfig.enabled) return

    console.log('[Gateway] Heartbeat started (interval: ' + heartbeatConfig.intervalMs + 'ms)')

    heartbeatInterval = setInterval(() => {
        checkHeartbeat()
    }, heartbeatConfig.intervalMs)
}

function stopHeartbeat(): void {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
    }
}

function checkHeartbeat(): void {
    if (state.novaStatus !== 'running') return

    // Check if Nova is responsive by checking if process is alive
    if (!state.novaProcess || state.novaProcess.killed) {
        state.heartbeatMissed++
        console.log(`[Gateway] ❤️ Heartbeat missed (${state.heartbeatMissed}/${heartbeatConfig.alertAfterMissed})`)

        if (state.heartbeatMissed >= heartbeatConfig.alertAfterMissed && !state.alertSent) {
            sendCrashAlert()
        }
    } else {
        // Nova is alive
        if (state.heartbeatMissed > 0) {
            console.log('[Gateway] ❤️ Heartbeat recovered')
        }
        state.heartbeatMissed = 0
        state.lastHeartbeat = new Date()
        state.alertSent = false
    }

    broadcast({ type: 'heartbeat', status: state.novaStatus, missed: state.heartbeatMissed })
}

async function sendCrashAlert(): Promise<void> {
    state.alertSent = true
    const message = `🚨 Nova Alert!\n\nNova ist ausgefallen.\n\nLetzte Aktivität: ${state.lastHeartbeat?.toISOString() || 'Nie'}\nCrash Count: ${state.crashCount}\n\nGateway versucht automatischen Neustart...`

    console.log('[Gateway] 🚨 ALERT: Nova unresponsive!')
    addLog('alert', message)

    // If WhatsApp alert phone is configured, try to send alert
    if (heartbeatConfig.alertPhone) {
        try {
            // This would need the WhatsApp connection from Nova
            // For now, just log it
            console.log(`[Gateway] Would send WhatsApp alert to: ${heartbeatConfig.alertPhone}`)
            addLog('alert', `Alert would be sent to: ${heartbeatConfig.alertPhone}`)
        } catch (err) {
            console.error('[Gateway] Failed to send alert:', err)
        }
    }

    broadcast({ type: 'alert', message, phone: heartbeatConfig.alertPhone })
}

// Endpoint for Nova to report its heartbeat
function receiveHeartbeat(): void {
    state.lastHeartbeat = new Date()
    state.heartbeatMissed = 0
    state.alertSent = false
}

// ============================================
// Nova Process Management
// ============================================

function startNova(): void {
    if (state.novaProcess) {
        console.log('[Gateway] Nova already running')
        return
    }

    console.log('[Gateway] Starting Nova...')
    state.novaStatus = 'starting'
    state.startTime = new Date()

    const novaPath = join(process.cwd(), 'dist', 'nova.js')

    state.novaProcess = spawn('node', [novaPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
    })

    state.novaProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
            addLog('stdout', line)
        }
    })

    state.novaProcess.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
            addLog('stderr', line)
        }
    })

    state.novaProcess.on('spawn', () => {
        state.novaStatus = 'running'
        console.log('[Gateway] Nova started (PID: ' + state.novaProcess?.pid + ')')
        broadcast({ type: 'nova:started', pid: state.novaProcess?.pid })
    })

    state.novaProcess.on('exit', (code, signal) => {
        console.log(`[Gateway] Nova exited (code: ${code}, signal: ${signal})`)

        const wasRunning = state.novaStatus === 'running'
        state.novaProcess = null
        state.novaStatus = code === 0 ? 'stopped' : 'crashed'

        if (state.novaStatus === 'crashed') {
            state.crashCount++
            state.lastCrash = new Date()
            addLog('system', `Nova crashed (code: ${code})`)

            // Auto-restart after 5 seconds if crashed
            if (wasRunning && state.crashCount < 5) {
                console.log('[Gateway] Auto-restarting in 5s...')
                setTimeout(() => startNova(), 5000)
            }
        }

        broadcast({ type: 'nova:stopped', code, signal })
    })

    state.novaProcess.on('error', (err) => {
        console.error('[Gateway] Nova process error:', err)
        state.novaStatus = 'crashed'
        addLog('system', `Process error: ${err.message}`)
    })
}

function stopNova(): void {
    if (!state.novaProcess) {
        console.log('[Gateway] Nova not running')
        return
    }

    console.log('[Gateway] Stopping Nova...')
    state.novaProcess.kill('SIGTERM')

    // Force kill after 5 seconds
    setTimeout(() => {
        if (state.novaProcess) {
            state.novaProcess.kill('SIGKILL')
        }
    }, 5000)
}

function restartNova(): void {
    if (state.novaProcess) {
        state.novaProcess.once('exit', () => {
            setTimeout(() => startNova(), 1000)
        })
        stopNova()
    } else {
        startNova()
    }
}

// ============================================
// Logging
// ============================================

function addLog(source: string, message: string): void {
    const entry = `[${new Date().toISOString()}] [${source}] ${message}`
    state.logs.push(entry)

    if (state.logs.length > MAX_LOGS) {
        state.logs.shift()
    }

    broadcast({ type: 'log', source, message, timestamp: Date.now() })
}

function broadcast(data: unknown): void {
    const json = JSON.stringify(data)
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(json)
        }
    }
}

// ============================================
// HTTP Server
// ============================================

const httpServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', nova: state.novaStatus }))
        return
    }

    if (url.pathname === '/api/status') {
        const uptime = state.startTime
            ? Math.floor((Date.now() - state.startTime.getTime()) / 1000)
            : 0

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            nova: state.novaStatus,
            pid: state.novaProcess?.pid,
            uptime,
            crashCount: state.crashCount,
            lastCrash: state.lastCrash?.toISOString(),
            connectedClients: clients.size,
        }))
        return
    }

    if (url.pathname === '/api/logs') {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state.logs.slice(-limit)))
        return
    }

    if (url.pathname === '/api/nova/start' && req.method === 'POST') {
        startNova()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ action: 'start', status: state.novaStatus }))
        return
    }

    if (url.pathname === '/api/nova/stop' && req.method === 'POST') {
        stopNova()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ action: 'stop', status: state.novaStatus }))
        return
    }

    if (url.pathname === '/api/nova/restart' && req.method === 'POST') {
        restartNova()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ action: 'restart', status: state.novaStatus }))
        return
    }

    // ============================================
    // Token Refresh Endpoint
    // ============================================
    if (url.pathname === '/api/auth/refresh' && req.method === 'POST') {
        (async () => {
            try {
                const { existsSync, readFileSync } = await import('node:fs')
                const authPath = join(process.cwd(), '.nova-auth', 'pi-auth.json')

                if (!existsSync(authPath)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: 'No auth credentials found', needsLogin: true }))
                    return
                }

                const auth = JSON.parse(readFileSync(authPath, 'utf-8'))

                // Check if token is expired or near expiry (5 min buffer)
                if (auth.expires && auth.expires < Date.now() + 300000) {
                    console.log('[Gateway] Token expired, refreshing...')

                    // For OAuth providers, trigger re-login
                    // pi-ai handles refresh internally for most cases
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({
                        status: 'expired',
                        needsRelogin: true,
                        message: 'Token abgelaufen. Bitte neu anmelden mit /login'
                    }))
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({
                        status: 'valid',
                        email: auth.email,
                        expiresIn: Math.round((auth.expires - Date.now()) / 1000)
                    }))
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: String(err) }))
            }
        })()
        return
    }

    // ============================================
    // Models Endpoint (for Dashboard)
    // ============================================
    if (url.pathname === '/api/models') {
        const provider = url.searchParams.get('provider') || 'local'

        // Return known models for provider (could be enhanced with API discovery)
        const models: Record<string, Array<{ id: string; name: string; vision?: boolean }>> = {
            'local': [
                // Models are detected dynamically from config
                
                
                { id: 'claude-sonnet-4-6-thinking', name: 'Claude Sonnet 4.6', vision: true },
                { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6', vision: true },
                { id: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
            ],
            'openai': [
                
                // Models are detected dynamically from config
            ],
            'anthropic': [
                { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', vision: true },
                { id: 'claude-opus-4', name: 'Claude Opus 4', vision: true },
            ],
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            provider,
            models: models[provider] || [],
            dynamic: false,
            message: 'Static list - dynamic discovery coming soon'
        }))
        return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
})

// ============================================
// WebSocket Server
// ============================================

const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (ws) => {
    console.log('[Gateway] Client connected')
    clients.add(ws)

    // Send initial state
    ws.send(JSON.stringify({
        type: 'init',
        status: state.novaStatus,
        pid: state.novaProcess?.pid,
        logs: state.logs.slice(-50),
    }))

    ws.on('message', (data) => {
        try {
            const msg: JsonRpcRequest = JSON.parse(data.toString())
            handleRpc(ws, msg)
        } catch {
            ws.send(JSON.stringify({ error: 'Invalid JSON' }))
        }
    })

    ws.on('close', () => {
        console.log('[Gateway] Client disconnected')
        clients.delete(ws)
    })
})

function handleRpc(ws: WebSocket, req: JsonRpcRequest): void {
    const respond = (result: unknown) => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
    }

    const error = (message: string, code = -32000) => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } }))
    }

    switch (req.method) {
        case 'status':
            respond({
                nova: state.novaStatus,
                pid: state.novaProcess?.pid,
                crashCount: state.crashCount,
            })
            break

        case 'nova.start':
            startNova()
            respond({ status: state.novaStatus })
            break

        case 'nova.stop':
            stopNova()
            respond({ status: state.novaStatus })
            break

        case 'nova.restart':
            restartNova()
            respond({ status: state.novaStatus })
            break

        case 'logs':
            const limit = (req.params as { limit?: number })?.limit || 100
            respond(state.logs.slice(-limit))
            break

        default:
            error(`Unknown method: ${req.method}`)
    }
}

// ============================================
// Main
// ============================================

export function startGateway(port = 18789, autoStartNova = true): void {
    httpServer.listen(port, () => {
        console.log(`
╔═══════════════════════════════════════╗
║                                       ║
║    ✨  Nova Gateway v1.0.0  ✨        ║
║                                       ║
╚═══════════════════════════════════════╝

  Gateway:    http://localhost:${port}
  WebSocket:  ws://localhost:${port}
  
  Endpoints:
    GET  /health          - Gateway health
    GET  /api/status      - Nova status
    GET  /api/logs        - Process logs
    POST /api/nova/start  - Start Nova
    POST /api/nova/stop   - Stop Nova
    POST /api/nova/restart - Restart Nova
    POST /api/heartbeat   - Nova heartbeat
`)

        // Start heartbeat monitoring
        startHeartbeat()

        if (autoStartNova) {
            startNova()
        }
    })
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const port = parseInt(process.env.GATEWAY_PORT || '18789', 10)
    const autoStart = process.env.NOVA_AUTO_START !== 'false'
    startGateway(port, autoStart)
}

export {
    startHeartbeat,
    stopHeartbeat,
    receiveHeartbeat,
    startNova,
    stopNova,
    restartNova,
}

export default { startGateway, startNova, stopNova, restartNova, startHeartbeat, stopHeartbeat, receiveHeartbeat }
