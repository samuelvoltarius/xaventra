/**
 * Layer 19 - Proactive Service Monitoring
 * 
 * Nova periodically checks configured URLs/services and alerts via Telegram
 * when they go down. Also provides /monitor command for manual checks.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

interface MonitorTarget {
    url: string
    name: string
    expectedStatus?: number
    checkIntervalMs?: number
    lastCheck?: number
    lastStatus?: 'up' | 'down' | 'unknown'
    lastResponseTime?: number
    downSince?: number
    consecutiveFailures?: number
}

interface MonitorConfig {
    enabled: boolean
    targets: MonitorTarget[]
    defaultIntervalMs: number
    alertAfterFailures: number
}

interface MonitorStats {
    totalChecks: number
    totalAlerts: number
    uptimePercent: Map<string, number>
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const CONFIG_FILE = join(DATA_DIR, 'monitoring.json')

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function loadConfig(): MonitorConfig {
    ensureDir()
    try {
        if (existsSync(CONFIG_FILE)) {
            return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
        }
    } catch { /* ignore */ }
    return {
        enabled: true,
        targets: [],
        defaultIntervalMs: 5 * 60 * 1000, // 5 min
        alertAfterFailures: 2,
    }
}

function saveConfig(config: MonitorConfig): void {
    ensureDir()
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

// ============================================
// Service Monitor
// ============================================

class ServiceMonitor {
    private config: MonitorConfig
    private intervalId: ReturnType<typeof setInterval> | null = null
    private stats: MonitorStats = {
        totalChecks: 0,
        totalAlerts: 0,
        uptimePercent: new Map(),
    }
    private alertCallback: ((target: MonitorTarget, status: 'down' | 'recovered') => Promise<void>) | null = null

    constructor() {
        this.config = loadConfig()
    }

    setAlertCallback(cb: (target: MonitorTarget, status: 'down' | 'recovered') => Promise<void>): void {
        this.alertCallback = cb
    }

    addTarget(name: string, url: string, intervalMs?: number): MonitorTarget {
        const target: MonitorTarget = {
            url,
            name,
            expectedStatus: 200,
            checkIntervalMs: intervalMs || this.config.defaultIntervalMs,
            lastStatus: 'unknown',
            consecutiveFailures: 0,
        }
        this.config.targets.push(target)
        saveConfig(this.config)
        console.log(`[L19 Monitor] Added target: ${name} (${url})`)
        return target
    }

    removeTarget(name: string): boolean {
        const idx = this.config.targets.findIndex(t => t.name.toLowerCase() === name.toLowerCase())
        if (idx === -1) return false
        this.config.targets.splice(idx, 1)
        saveConfig(this.config)
        return true
    }

    async checkTarget(target: MonitorTarget): Promise<{ up: boolean; responseTime: number; statusCode?: number }> {
        const start = Date.now()
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 10000)

            const response = await fetch(target.url, {
                method: 'HEAD',
                signal: controller.signal,
                headers: { 'User-Agent': 'Nova-Monitor' },
            })
            clearTimeout(timeout)

            const responseTime = Date.now() - start
            const up = response.status < 500

            return { up, responseTime, statusCode: response.status }
        } catch {
            return { up: false, responseTime: Date.now() - start }
        }
    }

    async checkAll(): Promise<string[]> {
        const results: string[] = []

        for (const target of this.config.targets) {
            const result = await this.checkTarget(target)
            this.stats.totalChecks++

            target.lastCheck = Date.now()
            target.lastResponseTime = result.responseTime

            if (result.up) {
                const wasDown = target.lastStatus === 'down'
                target.lastStatus = 'up'
                target.consecutiveFailures = 0

                if (wasDown) {
                    const downDuration = target.downSince ? Math.floor((Date.now() - target.downSince) / 1000 / 60) : 0
                    target.downSince = undefined
                    results.push(`✅ ${target.name} ist wieder ONLINE! (war ${downDuration} min down, ${result.responseTime}ms)`)
                    if (this.alertCallback) {
                        await this.alertCallback(target, 'recovered')
                    }
                } else {
                    results.push(`✅ ${target.name}: UP (${result.responseTime}ms, HTTP ${result.statusCode || '?'})`)
                }
            } else {
                target.consecutiveFailures = (target.consecutiveFailures || 0) + 1
                const wasUp = target.lastStatus !== 'down'
                target.lastStatus = 'down'

                if (wasUp) {
                    target.downSince = Date.now()
                }

                results.push(`❌ ${target.name}: DOWN (${target.consecutiveFailures}x, ${result.responseTime}ms)`)

                if (target.consecutiveFailures >= this.config.alertAfterFailures && this.alertCallback) {
                    this.stats.totalAlerts++
                    await this.alertCallback(target, 'down')
                }
            }
        }

        saveConfig(this.config)
        return results
    }

    start(): void {
        if (this.intervalId) return
        if (this.config.targets.length === 0) {
            console.log('[L19 Monitor] Keine Targets konfiguriert — Monitoring inaktiv')
            return
        }

        console.log(`[L19 Monitor] Gestartet — ${this.config.targets.length} Targets, Check alle ${this.config.defaultIntervalMs / 1000}s`)

        // Initial check
        this.checkAll().catch(err => console.error(`[L19 Monitor] Check failed: ${err}`))

        this.intervalId = setInterval(() => {
            this.checkAll().catch(err => console.error(`[L19 Monitor] Check failed: ${err}`))
        }, this.config.defaultIntervalMs)
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
            console.log('[L19 Monitor] Gestoppt')
        }
    }

    getTargets(): MonitorTarget[] {
        return this.config.targets
    }

    formatStatus(): string {
        if (this.config.targets.length === 0) {
            return `📡 *Service Monitor*\n\nKeine Targets konfiguriert.\n\nHinzufügen: /monitor add <name> <url>\nBeispiel: /monitor add MeinServer https://example.com`
        }

        const lines = this.config.targets.map(t => {
            const status = t.lastStatus === 'up' ? '🟢' : t.lastStatus === 'down' ? '🔴' : '⚪'
            const time = t.lastResponseTime ? `${t.lastResponseTime}ms` : '—'
            const ago = t.lastCheck ? `vor ${Math.floor((Date.now() - t.lastCheck) / 1000)}s` : 'nie'
            return `${status} *${t.name}*\n   ${t.url}\n   ${time} | ${ago}${t.consecutiveFailures ? ` | ❌ ${t.consecutiveFailures}x` : ''}`
        })

        return `📡 *Service Monitor*\n\n${lines.join('\n\n')}\n\n📊 Checks: ${this.stats.totalChecks} | Alerts: ${this.stats.totalAlerts}`
    }
}

// ============================================
// Singleton
// ============================================

let monitor: ServiceMonitor | null = null

export function getServiceMonitor(): ServiceMonitor {
    if (!monitor) {
        monitor = new ServiceMonitor()
    }
    return monitor
}

export default { ServiceMonitor, getServiceMonitor }
