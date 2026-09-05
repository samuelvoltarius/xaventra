/**
 * Nova Watchdog — Cross-Platform Daemon Monitor
 *
 * Monitors Nova sub-processes and auto-restarts on crash.
 * Works as:
 *   - systemd service on NovaOS/Linux
 *   - standalone Node.js process on Windows/macOS
 *   - npm script (npm run watchdog) on any platform
 *
 * Architecture:
 *   watchdog (this) → spawns/monitors:
 *     - nova-agent (LLM + layers + tool execution)
 *     - nova-memory (LanceDB, patterns, core facts)  [optional]
 *     - nova-telegram (Telegraf bot)                  [optional]
 */

import { fork, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { platform, hostname } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

// ============================================
// Types
// ============================================

interface DaemonConfig {
    name: string
    script: string
    args?: string[]
    enabled: boolean
    restartDelay: number      // base delay in ms
    maxRestarts: number       // max restarts before giving up
    healthEndpoint?: string   // HTTP health check URL
    healthInterval?: number   // health check interval in ms
}

interface DaemonState {
    name: string
    pid: number | null
    status: 'running' | 'stopped' | 'crashed' | 'disabled'
    restarts: number
    lastStart: number
    lastCrash: number | null
    uptime: number
    errors: string[]
}

interface WatchdogConfig {
    daemons: DaemonConfig[]
    healthPort: number
    logDir: string
    pidFile: string
}

// ============================================
// Default Config
// ============================================

const getDefaultConfig = (): WatchdogConfig => {
    const baseDir = process.cwd()
    return {
        daemons: [
            {
                name: 'nova-agent',
                script: join(baseDir, 'dist', 'index.js'),
                args: ['--config', 'config.novaos.json'],
                enabled: true,
                restartDelay: 3000,
                maxRestarts: 10,
                healthEndpoint: 'http://localhost:3000/health',
                healthInterval: 30000,
            },
            // Optional daemons — enable via config
            {
                name: 'nova-memory',
                script: join(baseDir, 'dist', 'memory', 'memory-daemon.js'),
                enabled: false,
                restartDelay: 5000,
                maxRestarts: 5,
            },
            {
                name: 'nova-telegram',
                script: join(baseDir, 'dist', 'channels', 'telegram-daemon.js'),
                enabled: false,
                restartDelay: 5000,
                maxRestarts: 5,
            },
        ],
        healthPort: 9090,
        logDir: join(baseDir, '.nova-data', 'logs'),
        pidFile: join(baseDir, '.nova-data', 'watchdog.pid'),
    }
}

// ============================================
// Watchdog
// ============================================

export class NovaWatchdog {
    private config: WatchdogConfig
    private processes: Map<string, ChildProcess> = new Map()
    private states: Map<string, DaemonState> = new Map()
    private healthServer: ReturnType<typeof createServer> | null = null
    private healthCheckers: Map<string, NodeJS.Timeout> = new Map()
    private running = false

    constructor(configOverrides?: Partial<WatchdogConfig>) {
        this.config = { ...getDefaultConfig(), ...configOverrides }

        // Merge daemon configs
        if (configOverrides?.daemons) {
            for (const override of configOverrides.daemons) {
                const existing = this.config.daemons.find(d => d.name === override.name)
                if (existing) {
                    Object.assign(existing, override)
                } else {
                    this.config.daemons.push(override as DaemonConfig)
                }
            }
        }

        // Ensure log dir exists
        if (!existsSync(this.config.logDir)) {
            mkdirSync(this.config.logDir, { recursive: true })
        }
    }

    // ============================================
    // Lifecycle
    // ============================================

    async start(): Promise<void> {
        this.running = true
        this.log('🐕 Nova Watchdog starting...')
        this.log(`  Platform: ${platform()}`)
        this.log(`  Hostname: ${hostname()}`)
        this.log(`  Daemons:  ${this.config.daemons.filter(d => d.enabled).map(d => d.name).join(', ')}`)

        // Write PID file
        writeFileSync(this.config.pidFile, String(process.pid))

        // Start health server
        this.startHealthServer()

        // Start enabled daemons
        for (const daemon of this.config.daemons) {
            if (daemon.enabled) {
                await this.startDaemon(daemon)
            } else {
                this.states.set(daemon.name, {
                    name: daemon.name,
                    pid: null,
                    status: 'disabled',
                    restarts: 0,
                    lastStart: 0,
                    lastCrash: null,
                    uptime: 0,
                    errors: [],
                })
            }
        }

        // Handle graceful shutdown
        const shutdown = () => this.stop()
        process.on('SIGTERM', shutdown)
        process.on('SIGINT', shutdown)
        process.on('SIGHUP', shutdown)

        this.log('✅ Nova Watchdog running')
    }

    async stop(): Promise<void> {
        this.log('🛑 Nova Watchdog shutting down...')
        this.running = false

        // Stop health checkers
        for (const [, timer] of this.healthCheckers) {
            clearInterval(timer)
        }
        this.healthCheckers.clear()

        // Stop all daemons
        for (const [name, proc] of this.processes) {
            this.log(`  Stopping ${name} (PID ${proc.pid})...`)
            proc.kill('SIGTERM')
        }

        // Wait for processes to exit (max 10s)
        await new Promise<void>(resolve => {
            const timeout = setTimeout(resolve, 10000)
            const check = setInterval(() => {
                if (this.processes.size === 0) {
                    clearInterval(check)
                    clearTimeout(timeout)
                    resolve()
                }
            }, 100)
        })

        // Force kill remaining
        for (const [name, proc] of this.processes) {
            this.log(`  Force-killing ${name}...`)
            proc.kill('SIGKILL')
        }

        // Stop health server
        this.healthServer?.close()

        // Clean PID file
        try {
            if (existsSync(this.config.pidFile)) {
                require('fs').unlinkSync(this.config.pidFile)
            }
        } catch { /* ignore */ }

        this.log('✅ Nova Watchdog stopped')
        process.exit(0)
    }

    // ============================================
    // Daemon Management
    // ============================================

    private async startDaemon(daemon: DaemonConfig): Promise<void> {
        if (!existsSync(daemon.script)) {
            this.log(`⚠️ ${daemon.name}: script not found: ${daemon.script}`)
            this.log(`  Hint: Run 'npm run build' first`)
            this.states.set(daemon.name, {
                name: daemon.name,
                pid: null,
                status: 'stopped',
                restarts: 0,
                lastStart: 0,
                lastCrash: null,
                uptime: 0,
                errors: [`Script not found: ${daemon.script}`],
            })
            return
        }

        const state: DaemonState = this.states.get(daemon.name) || {
            name: daemon.name,
            pid: null,
            status: 'stopped',
            restarts: 0,
            lastStart: 0,
            lastCrash: null,
            uptime: 0,
            errors: [],
        }

        try {
            const child = fork(daemon.script, daemon.args || [], {
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                env: {
                    ...process.env,
                    NOVA_DAEMON: daemon.name,
                    NOVA_WATCHDOG_PID: String(process.pid),
                },
            })

            this.processes.set(daemon.name, child)
            state.pid = child.pid || null
            state.status = 'running'
            state.lastStart = Date.now()

            this.log(`✅ ${daemon.name} started (PID ${child.pid})`)

            // Handle stdout/stderr
            child.stdout?.on('data', (data: Buffer) => {
                const line = data.toString().trim()
                if (line) this.log(`  [${daemon.name}] ${line}`)
            })

            child.stderr?.on('data', (data: Buffer) => {
                const line = data.toString().trim()
                if (line) this.log(`  [${daemon.name}] ⚠️ ${line}`)
            })

            // Handle exit
            child.on('exit', (code, signal) => {
                this.processes.delete(daemon.name)
                state.pid = null

                if (!this.running) return  // We're shutting down, don't restart

                if (code !== 0) {
                    state.status = 'crashed'
                    state.lastCrash = Date.now()
                    state.restarts++
                    state.errors.push(`Exit code ${code} (signal: ${signal}) at ${new Date().toISOString()}`)

                    // Keep only last 10 errors
                    if (state.errors.length > 10) state.errors = state.errors.slice(-10)

                    this.log(`💥 ${daemon.name} crashed (code: ${code}, restarts: ${state.restarts}/${daemon.maxRestarts})`)

                    // Auto-restart with exponential backoff
                    if (state.restarts < daemon.maxRestarts) {
                        const delay = daemon.restartDelay * Math.min(state.restarts, 5)
                        this.log(`  ⏳ Restarting in ${delay}ms...`)
                        setTimeout(() => {
                            if (this.running) this.startDaemon(daemon)
                        }, delay)
                    } else {
                        this.log(`❌ ${daemon.name}: max restarts reached (${daemon.maxRestarts}). Giving up.`)
                        state.status = 'stopped'
                    }
                } else {
                    this.log(`📦 ${daemon.name} exited cleanly`)
                    state.status = 'stopped'
                }

                this.states.set(daemon.name, state)
            })

            // Start health checker
            if (daemon.healthEndpoint && daemon.healthInterval) {
                this.startHealthChecker(daemon)
            }
        } catch (err: unknown) {
            state.status = 'crashed'
            state.errors.push((err as Error).message)
            this.log(`❌ ${daemon.name} failed to start: ${(err as Error).message}`)
        }

        this.states.set(daemon.name, state)
    }

    // ============================================
    // Health Checking
    // ============================================

    private startHealthChecker(daemon: DaemonConfig): void {
        if (!daemon.healthEndpoint || !daemon.healthInterval) return

        const timer = setInterval(async () => {
            try {
                const url = new URL(daemon.healthEndpoint!)
                const http = await import('node:http')
                const result = await new Promise<boolean>((resolve) => {
                    const req = http.request(url, { timeout: 5000 }, (res) => {
                        resolve(res.statusCode === 200)
                    })
                    req.on('error', () => resolve(false))
                    req.on('timeout', () => { req.destroy(); resolve(false) })
                    req.end()
                })

                if (!result) {
                    const state = this.states.get(daemon.name)
                    if (state && state.status === 'running') {
                        this.log(`⚠️ ${daemon.name} health check failed, restarting...`)
                        const proc = this.processes.get(daemon.name)
                        proc?.kill('SIGTERM')
                    }
                }
            } catch { /* ignore */ }
        }, daemon.healthInterval)

        this.healthCheckers.set(daemon.name, timer)
    }

    // ============================================
    // Health Server (for external monitoring)
    // ============================================

    private startHealthServer(): void {
        this.healthServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.url === '/health') {
                const status = this.getStatus()
                const allHealthy = Object.values(status.daemons)
                    .filter(d => d.status !== 'disabled')
                    .every(d => d.status === 'running')

                res.writeHead(allHealthy ? 200 : 503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(status, null, 2))
            } else if (req.url === '/restart' && req.method === 'POST') {
                this.log('🔄 Restart requested via API')
                for (const daemon of this.config.daemons.filter(d => d.enabled)) {
                    const proc = this.processes.get(daemon.name)
                    const state = this.states.get(daemon.name)
                    if (state) state.restarts = 0  // Reset counter
                    proc?.kill('SIGTERM')
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ message: 'Restart initiated' }))
            } else {
                res.writeHead(404)
                res.end('Not Found')
            }
        })

        this.healthServer.listen(this.config.healthPort, () => {
            this.log(`📡 Health API: http://localhost:${this.config.healthPort}/health`)
        })

        this.healthServer.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                this.log(`⚠️ Health port ${this.config.healthPort} in use, skipping health server`)
            }
        })
    }

    // ============================================
    // Status
    // ============================================

    getStatus(): { watchdog: { pid: number; uptime: number; platform: string }; daemons: Record<string, DaemonState> } {
        const daemons: Record<string, DaemonState> = {}
        for (const [name, state] of this.states) {
            daemons[name] = {
                ...state,
                uptime: state.status === 'running' ? Date.now() - state.lastStart : 0,
            }
        }
        return {
            watchdog: {
                pid: process.pid,
                uptime: process.uptime() * 1000,
                platform: platform(),
            },
            daemons,
        }
    }

    // ============================================
    // Logging
    // ============================================

    private log(message: string): void {
        const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0]
        const line = `[${timestamp}] ${message}`
        console.log(line)

        // Also write to log file
        try {
            const logFile = join(this.config.logDir, 'watchdog.log')
            require('fs').appendFileSync(logFile, line + '\n')
        } catch { /* ignore */ }
    }
}

// ============================================
// CLI Entry Point
// ============================================

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] || '').href ||
    process.argv[1]?.endsWith('nova-watchdog.js') ||
    process.argv[1]?.endsWith('nova-watchdog.ts')

if (isMainModule) {
    console.log('🐕 Nova Watchdog v1.0')
    console.log(`  Platform: ${platform()}`)
    console.log('')

    // Load config from file if available
    const configPath = join(process.cwd(), 'watchdog.config.json')
    let configOverrides: Partial<WatchdogConfig> = {}
    if (existsSync(configPath)) {
        try {
            configOverrides = JSON.parse(readFileSync(configPath, 'utf-8'))
            console.log(`  Config: ${configPath}`)
        } catch { /* use defaults */ }
    }

    const watchdog = new NovaWatchdog(configOverrides)
    watchdog.start().catch(err => {
        console.error('❌ Watchdog failed to start:', err)
        process.exit(1)
    })
}

export default NovaWatchdog
