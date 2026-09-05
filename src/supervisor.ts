/**
 * Nova Supervisor - External Process Monitor
 * 
 * Runs as a SEPARATE process that:
 * - Monitors Nova's health via heartbeat
 * - Restarts Nova if it crashes
 * - Provides status HTTP endpoints
 * - Logs crashes for debugging
 * 
 * Run: npm run supervisor
 */

import { spawn, ChildProcess } from 'node:child_process'
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'

// ============================================
// Configuration
// ============================================

const CONFIG = {
    novaScript: 'dist/daemon.js',
    port: Number(process.env.NOVA_SUPERVISOR_PORT || 3099),
    heartbeatInterval: 30000,  // 30 seconds
    heartbeatTimeout: 60000,   // one missed window; restart only after confirmations
    heartbeatFailuresBeforeRestart: 3,
    maxRestarts: 5,
    restartDelay: 5000,        // 5 seconds between restarts
    logDir: '.nova-logs',
}

// ============================================
// State
// ============================================

interface SupervisorState {
    novaProcess: ChildProcess | null
    status: 'stopped' | 'starting' | 'running' | 'crashed' | 'restarting'
    lastHeartbeat: number
    restartCount: number
    startTime: number
    crashes: Array<{ time: number; reason: string }>
    services: Record<string, unknown>
    novaPid: number | null
    missedHeartbeats: number
}

const state: SupervisorState = {
    novaProcess: null,
    status: 'stopped',
    lastHeartbeat: 0,
    restartCount: 0,
    startTime: 0,
    crashes: [],
    services: {},
    novaPid: null,
    missedHeartbeats: 0,
}

function isProcessAlive(pid: number | null | undefined): boolean {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
}

function pidFromFile(): number | null {
    try {
        const pid = Number(readFileSync('.nova.pid', 'utf8').trim())
        return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch { return null }
}

// ============================================
// Logging
// ============================================

function log(msg: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${level}] ${msg}`
    console.log(line)

    // Also write to file
    if (!existsSync(CONFIG.logDir)) {
        mkdirSync(CONFIG.logDir, { recursive: true })
    }
    const logFile = join(CONFIG.logDir, `supervisor-${new Date().toISOString().split('T')[0]}.log`)
    appendFileSync(logFile, line + '\n')
}

// ============================================
// Nova Process Management
// ============================================

function startNova(): void {
    if (state.novaProcess) {
        log('Nova already running, stopping first...', 'WARN')
        stopNova()
    }

    const existingPid = pidFromFile()
    if (isProcessAlive(existingPid)) {
        state.novaPid = existingPid
        state.status = 'running'
        state.startTime = Date.now()
        state.lastHeartbeat = Date.now()
        state.missedHeartbeats = 0
        log(`Adopted already-running Nova daemon (PID: ${existingPid})`)
        return
    }

    state.status = 'starting'
    log('Starting Nova daemon...')

    try {
        // Spawn Node directly. On Windows, shell:true+npx creates an
        // intermediate cmd.exe process; killing it leaves the real daemon
        // orphaned and causes an endless duplicate-PID restart loop.
        const child = spawn(process.execPath, [CONFIG.novaScript], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
        })
        state.novaProcess = child

        state.startTime = Date.now()
        state.novaPid = child.pid || null
        state.lastHeartbeat = Date.now()

        // Capture stdout
        child.stdout?.on('data', (data) => {
            const output = data.toString().trim()
            if (output) {
                process.stdout.write(`[Nova] ${output}\n`)
            }
        })

        // Capture stderr
        child.stderr?.on('data', (data) => {
            const output = data.toString().trim()
            if (output) {
                process.stderr.write(`[Nova ERROR] ${output}\n`)
            }
        })

        // Handle exit
        child.on('exit', (code, signal) => {
            const reason = signal ? `Signal: ${signal}` : `Exit code: ${code}`
            log(`Nova exited: ${reason}`, code === 0 ? 'INFO' : 'ERROR')

            const isCurrentChild = state.novaProcess === child
            if (state.novaPid === child.pid) state.novaPid = null
            if (!isCurrentChild) {
                log(`Ignoring exit from superseded Nova PID ${child.pid}`)
                return
            }
            state.novaProcess = null

            if (code !== 0 && state.status !== 'stopped') {
                handleCrash(reason)
            } else {
                state.status = 'stopped'
            }
        })

        // Handle errors
        child.on('error', (err) => {
            log(`Nova spawn error: ${err.message}`, 'ERROR')
            handleCrash(`Spawn error: ${err.message}`)
        })

        state.status = 'running'
        log(`Nova started (PID: ${child.pid})`)

    } catch (err) {
        log(`Failed to start Nova: ${err}`, 'ERROR')
        state.status = 'crashed'
    }
}

function stopNova(): void {
    if (state.novaProcess) {
        const target = state.novaProcess
        log('Stopping Nova...')
        state.status = 'stopped'
        target.kill('SIGTERM')

        // Force kill after 5 seconds
        setTimeout(() => {
            if (state.novaProcess === target && isProcessAlive(target.pid)) {
                log('Force killing Nova...', 'WARN')
                target.kill('SIGKILL')
            }
        }, 5000)
    }
}

function handleCrash(reason: string): void {
    state.status = 'crashed'
    state.crashes.push({ time: Date.now(), reason })

    // Keep only last 10 crashes
    if (state.crashes.length > 10) {
        state.crashes.shift()
    }

    log(`Nova crashed: ${reason}`, 'ERROR')

    // Check restart limit
    if (state.restartCount >= CONFIG.maxRestarts) {
        log(`Max restarts (${CONFIG.maxRestarts}) reached. Manual intervention required.`, 'ERROR')
        return
    }

    // Schedule restart
    state.status = 'restarting'
    state.restartCount++
    log(`Scheduling restart ${state.restartCount}/${CONFIG.maxRestarts} in ${CONFIG.restartDelay}ms...`)

    setTimeout(() => {
        if (state.status === 'restarting') {
            startNova()
        }
    }, CONFIG.restartDelay)
}

// ============================================
// Heartbeat Monitor
// ============================================

function receiveHeartbeat(pid?: number): void {
    state.lastHeartbeat = Date.now()
    state.restartCount = 0  // Reset on successful heartbeat
    state.missedHeartbeats = 0
    if (pid && isProcessAlive(pid)) state.novaPid = pid
    if (state.status === 'crashed' || state.status === 'restarting' || state.status === 'starting') {
        state.status = 'running'
        log(`Heartbeat restored running state${pid ? ` (PID: ${pid})` : ''}`)
    }
}

function checkHeartbeat(): void {
    if (state.status !== 'running') return

    const elapsed = Date.now() - state.lastHeartbeat
    if (elapsed > CONFIG.heartbeatTimeout) {
        state.missedHeartbeats++
        log(`No heartbeat for ${elapsed}ms (${state.missedHeartbeats}/${CONFIG.heartbeatFailuresBeforeRestart})`, 'WARN')
        if (state.missedHeartbeats >= CONFIG.heartbeatFailuresBeforeRestart) {
            handleCrash('Heartbeat timeout confirmed')
        }
    }
}

// ============================================
// HTTP API
// ============================================

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/'
    const method = req.method || 'GET'

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Content-Type', 'application/json')

    if (method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
    }

    // Routes
    if (url === '/health' && method === 'GET') {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, name: 'nova-supervisor' }))
        return
    }

    if (url === '/api/status' && method === 'GET') {
        const uptime = state.startTime ? Date.now() - state.startTime : 0
        res.writeHead(200)
        res.end(JSON.stringify({
            status: state.status,
            pid: state.novaProcess?.pid || state.novaPid,
            uptime,
            restartCount: state.restartCount,
            lastHeartbeat: state.lastHeartbeat,
            crashes: state.crashes.slice(-5),
            services: state.services,
        }))
        return
    }

    if (url === '/api/nova/start' && method === 'POST') {
        if (state.status === 'running') {
            res.writeHead(400)
            res.end(JSON.stringify({ error: 'Nova already running' }))
            return
        }
        startNova()
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, message: 'Nova starting' }))
        return
    }

    if (url === '/api/nova/stop' && method === 'POST') {
        stopNova()
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, message: 'Nova stopping' }))
        return
    }

    if (url === '/api/nova/restart' && method === 'POST') {
        stopNova()
        setTimeout(() => startNova(), 2000)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, message: 'Nova restarting' }))
        return
    }

    if (url === '/api/heartbeat' && method === 'POST') {
        let body = ''
        req.on('data', chunk => { if (body.length < 1_000_000) body += chunk })
        req.on('end', () => {
            let heartbeatPid: number | undefined
            try {
                const payload = body ? JSON.parse(body) : {}
                if (payload.services && typeof payload.services === 'object') state.services = payload.services
                heartbeatPid = Number(payload.pid) || undefined
            } catch { /* heartbeat remains valid even without diagnostics */ }
            receiveHeartbeat(heartbeatPid)
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true }))
        })
        return
    }

    if (url === '/api/logs' && method === 'GET') {
        res.writeHead(200)
        res.end(JSON.stringify({ crashes: state.crashes }))
        return
    }

    // 404
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
    console.log('')
    console.log('╔═══════════════════════════════════════════════════════╗')
    console.log('║          🛡️ Nova Supervisor Starting 🛡️               ║')
    console.log('╚═══════════════════════════════════════════════════════╝')
    console.log('')

    // Start HTTP server
    const server = createServer(handleRequest)
    server.listen(CONFIG.port, () => {
        log(`Supervisor API running on http://localhost:${CONFIG.port}`)
        console.log('')
        console.log('  Endpoints:')
        console.log('    GET  /health          - Supervisor health')
        console.log('    GET  /api/status      - Nova status')
        console.log('    GET  /api/logs        - Crash logs')
        console.log('    POST /api/nova/start  - Start Nova')
        console.log('    POST /api/nova/stop   - Stop Nova')
        console.log('    POST /api/nova/restart - Restart Nova')
        console.log('    POST /api/heartbeat   - Nova heartbeat')
        console.log('')
    })

    // Start heartbeat checker
    setInterval(checkHeartbeat, CONFIG.heartbeatInterval)

    // Auto-start Nova
    log('Auto-starting Nova...')
    startNova()

    // Graceful shutdown
    process.on('SIGINT', () => {
        log('Received SIGINT, shutting down...')
        stopNova()
        setTimeout(() => process.exit(0), 3000)
    })

    process.on('SIGTERM', () => {
        log('Received SIGTERM, shutting down...')
        stopNova()
        setTimeout(() => process.exit(0), 3000)
    })
}

main().catch(console.error)
