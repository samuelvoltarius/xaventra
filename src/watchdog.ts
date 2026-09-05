#!/usr/bin/env node
/**
 * Nova External Watchdog
 * 
 * Läuft als SEPARATER Prozess und überwacht den Hauptprozess.
 * Kann den Hauptprozess neustarten, auch wenn L0 crashed.
 * 
 * Usage:
 *   node watchdog.js
 *   # Oder via PM2:
 *   pm2 start watchdog.js --name nova-watchdog
 */

import { spawn, ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from './config/config-path.js'


// ============================================
// Configuration
// ============================================

const CONFIG = {
    mainScript: 'dist/daemon.js',
    healthCheckInterval: 30000,  // 30s
    healthCheckTimeout: 10000,   // 10s
    maxRestarts: 5,
    restartDelay: 5000,  // 5s
    healthEndpoint: 'http://localhost:3000/health',
    logDir: '.nova-logs',
}

// ============================================
// State
// ============================================

let mainProcess: ChildProcess | null = null
let restartCount = 0
let lastHealthCheck = Date.now()
let isShuttingDown = false

// ============================================
// Logging
// ============================================

function ensureLogDir(): void {
    const dir = join(process.cwd(), CONFIG.logDir)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
}

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [WATCHDOG] [${level}] ${message}`
    console.log(line)

    // Also write to file
    try {
        const logPath = join(process.cwd(), CONFIG.logDir, 'watchdog.log')
        const fs = require('node:fs')
        fs.appendFileSync(logPath, line + '\n')
    } catch { }
}

// ============================================
// Process Management
// ============================================

function startMainProcess(): void {
    if (mainProcess) {
        log('WARN', 'Main process already running')
        return
    }

    log('INFO', `Starting main process: node ${CONFIG.mainScript}`)

    mainProcess = spawn('node', [CONFIG.mainScript], {
        cwd: process.cwd(),
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, WATCHDOG_MANAGED: 'true' },
    })

    mainProcess.on('exit', (code, signal) => {
        log('WARN', `Main process exited with code ${code}, signal ${signal}`)
        mainProcess = null

        if (!isShuttingDown) {
            scheduleRestart()
        }
    })

    mainProcess.on('error', (err) => {
        log('ERROR', `Main process error: ${err.message}`)
        mainProcess = null
        scheduleRestart()
    })

    log('INFO', `Main process started with PID ${mainProcess.pid}`)
}

function scheduleRestart(): void {
    if (isShuttingDown) return

    restartCount++

    if (restartCount > CONFIG.maxRestarts) {
        log('ERROR', `Max restarts (${CONFIG.maxRestarts}) exceeded. Giving up.`)
        sendAlert('Nova hat sich zu oft neu gestartet. Manueller Eingriff nötig!')
        return
    }

    log('INFO', `Scheduling restart in ${CONFIG.restartDelay}ms (attempt ${restartCount}/${CONFIG.maxRestarts})`)

    setTimeout(() => {
        startMainProcess()
    }, CONFIG.restartDelay)
}

function stopMainProcess(): Promise<void> {
    return new Promise((resolve) => {
        if (!mainProcess) {
            resolve()
            return
        }

        log('INFO', 'Stopping main process...')
        mainProcess.kill('SIGTERM')

        const timeout = setTimeout(() => {
            if (mainProcess) {
                log('WARN', 'Force killing main process')
                mainProcess.kill('SIGKILL')
            }
            resolve()
        }, 5000)

        mainProcess.once('exit', () => {
            clearTimeout(timeout)
            mainProcess = null
            resolve()
        })
    })
}

// ============================================
// Health Check
// ============================================

async function performHealthCheck(): Promise<boolean> {
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), CONFIG.healthCheckTimeout)

        const response = await fetch(CONFIG.healthEndpoint, {
            signal: controller.signal,
        })

        clearTimeout(timeout)

        if (response.ok) {
            const data = await response.json() as { uptime?: number; status?: string }
            log('INFO', `Health check OK: uptime=${data.uptime?.toFixed(0)}s`)
            lastHealthCheck = Date.now()
            restartCount = 0  // Reset on successful health check
            return true
        } else {
            log('WARN', `Health check failed: HTTP ${response.status}`)
            return false
        }
    } catch (err: any) {
        if (err.name === 'AbortError') {
            log('WARN', 'Health check timeout')
        } else {
            log('WARN', `Health check error: ${err.message}`)
        }
        return false
    }
}

function startHealthCheckLoop(): void {
    setInterval(async () => {
        if (!mainProcess) return

        const healthy = await performHealthCheck()

        if (!healthy) {
            const timeSinceLastCheck = Date.now() - lastHealthCheck

            // If unhealthy for more than 2 health check intervals, restart
            if (timeSinceLastCheck > CONFIG.healthCheckInterval * 2) {
                log('ERROR', 'Process unresponsive, forcing restart')
                await stopMainProcess()
                scheduleRestart()
            }
        }
    }, CONFIG.healthCheckInterval)
}

// ============================================
// Alerts
// ============================================

async function sendAlert(message: string): Promise<void> {
    log('ERROR', `ALERT: ${message}`)

    // Try to send Telegram alert
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            const token = config.telegram?.token
            const chatId = config.telegram?.allowFrom?.[0]

            if (token && chatId) {
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: `🚨 WATCHDOG ALERT\n\n${message}`,
                    }),
                })
                log('INFO', 'Telegram alert sent')
            }
        }
    } catch (err: any) {
        log('WARN', `Failed to send alert: ${err.message}`)
    }
}

// ============================================
// Shutdown
// ============================================

async function shutdown(signal: string): Promise<void> {
    log('INFO', `Received ${signal}, shutting down...`)
    isShuttingDown = true
    await stopMainProcess()
    process.exit(0)
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
    ensureLogDir()

    log('INFO', '=== Nova External Watchdog Starting ===')
    log('INFO', `Main script: ${CONFIG.mainScript}`)
    log('INFO', `Health endpoint: ${CONFIG.healthEndpoint}`)
    log('INFO', `Health check interval: ${CONFIG.healthCheckInterval}ms`)

    // Handle signals
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    // Start main process
    startMainProcess()

    // Start health checks after initial delay
    setTimeout(() => {
        log('INFO', 'Starting health check loop')
        startHealthCheckLoop()
    }, 10000)  // Wait 10s for startup

    log('INFO', 'Watchdog running. Press Ctrl+C to stop.')
}

main().catch((err) => {
    console.error('Watchdog fatal error:', err)
    process.exit(1)
})
