/**
 * L0 Health Monitor - System Resource Monitoring
 * 
 * Monitors disk space and memory usage. Alerts when:
 * - Disk space below a production-safe reserve
 * - Memory usage above a critical threshold
 * - operational .nova-data grows unexpectedly (managed release/benchmark
 *   artifacts are reported separately and do not create false alarms)
 * 
 * Runs as part of the heartbeat cycle (every 5 minutes).
 */

import { execSync } from 'node:child_process'
import { existsSync, statSync, readdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { totalmem, freemem } from 'node:os'

// ============================================
// Types
// ============================================

export interface HealthStatus {
    timestamp: number
    disk: {
        freeGB: number
        totalGB: number
        usedPercent: number
        warning: boolean
    }
    memory: {
        usedMB: number
        totalMB: number
        usedPercent: number
        warning: boolean
    }
    novaData: {
        sizeMB: number
        managedMB: number
        operationalMB: number
        warning: boolean
    }
    healthy: boolean
    warnings: string[]
}

// ============================================
// Configuration
// ============================================

const THRESHOLDS = {
    diskFreeMinMB: 5 * 1024,
    diskUsedMaxPercent: 92,
    memoryMaxPercent: 95,
    novaOperationalMaxMB: 750,
    novaDataHardMaxMB: 4 * 1024,
}

const MANAGED_NOVA_DATA_DIRS = new Set([
    'release-artifacts',
    'benchmark-workspace',
    'benchmarks',
    'codex-runtime',
])

// ============================================
// Health Check Functions
// ============================================

function getDiskSpace(): { freeGB: number; totalGB: number; usedPercent: number } {
    try {
        // Native Node API avoids shell/locale/ExecutionPolicy failures on all
        // supported platforms. Keep the legacy platform commands as fallback.
        const fs = statfsSync(process.cwd())
        const blockSize = Number(fs.bsize)
        const totalBytes = Number(fs.blocks) * blockSize
        const freeBytes = Number(fs.bavail) * blockSize
        if (totalBytes > 0 && freeBytes >= 0) {
            return {
                freeGB: Math.round(freeBytes / 1e9 * 10) / 10,
                totalGB: Math.round(totalBytes / 1e9 * 10) / 10,
                usedPercent: Math.round((totalBytes - freeBytes) / totalBytes * 100),
            }
        }

        if (process.platform === 'win32') {
            const drive = process.cwd().slice(0, 2) // e.g., "F:"
            const output = execSync(
                `powershell -Command "(Get-PSDrive ${drive[0]}).Free, (Get-PSDrive ${drive[0]}).Used"`,
                { encoding: 'utf-8', timeout: 5000 }
            ).trim()
            const lines = output.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
            if (lines.length >= 2) {
                const freeBytes = lines[0]
                const usedBytes = lines[1]
                const totalBytes = freeBytes + usedBytes
                return {
                    freeGB: Math.round(freeBytes / 1e9 * 10) / 10,
                    totalGB: Math.round(totalBytes / 1e9 * 10) / 10,
                    usedPercent: Math.round(usedBytes / totalBytes * 100),
                }
            }
        } else if (process.platform === 'darwin') {
            // macOS: df -k gives kilobytes (no --output flag support)
            const output = execSync('df -k /', { encoding: 'utf-8', timeout: 5000 })
            const lines = output.trim().split('\n')
            if (lines.length >= 2) {
                const parts = lines[1].trim().split(/\s+/)
                // df -k columns: Filesystem, 1024-blocks, Used, Available, Capacity%, Mounted
                const totalKB = parseInt(parts[1])
                const availKB = parseInt(parts[3])
                if (!isNaN(totalKB) && !isNaN(availKB)) {
                    return {
                        freeGB: Math.round(availKB / 1024 / 1024 * 10) / 10,
                        totalGB: Math.round(totalKB / 1024 / 1024 * 10) / 10,
                        usedPercent: Math.round((totalKB - availKB) / totalKB * 100),
                    }
                }
            }
        } else {
            // Linux: df -BM with --output
            const output = execSync('df -BM --output=avail,size /', { encoding: 'utf-8', timeout: 5000 })
            const lines = output.trim().split('\n')
            if (lines.length >= 2) {
                const [avail, size] = lines[1].trim().split(/\s+/).map(s => parseInt(s))
                return {
                    freeGB: Math.round(avail / 1024 * 10) / 10,
                    totalGB: Math.round(size / 1024 * 10) / 10,
                    usedPercent: Math.round((size - avail) / size * 100),
                }
            }
        }
    } catch (err) {
        console.log(`[HealthMonitor] Disk space check failed: ${err}`)
    }
    return { freeGB: -1, totalGB: -1, usedPercent: -1 }
}

function getMemoryUsage(): { usedMB: number; totalMB: number; usedPercent: number } {
    try {
        const total = totalmem()
        const free = freemem()
        const used = total - free
        return {
            usedMB: Math.round(used / 1e6),
            totalMB: Math.round(total / 1e6),
            usedPercent: Math.round(used / total * 100),
        }
    } catch {
        return { usedMB: -1, totalMB: -1, usedPercent: -1 }
    }
}

function getPathSizeBytes(path: string): number {
    try {
        const stat = statSync(path)
        if (stat.isFile()) return stat.size
        if (!stat.isDirectory()) return 0
        let total = 0
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue
            if (entry.isDirectory() && entry.name.startsWith('.')) continue
            try {
                total += getPathSizeBytes(join(path, entry.name))
            } catch { /* skip unreadable entries */ }
        }
        return total
    } catch {
        return 0
    }
}

export function classifyNovaDataUsage(totalMB: number, managedMB: number): {
    sizeMB: number
    managedMB: number
    operationalMB: number
    warning: boolean
} {
    const safeTotal = Math.max(0, Math.round(totalMB))
    const safeManaged = Math.min(safeTotal, Math.max(0, Math.round(managedMB)))
    const operationalMB = Math.max(0, safeTotal - safeManaged)
    return {
        sizeMB: safeTotal,
        managedMB: safeManaged,
        operationalMB,
        warning: operationalMB > THRESHOLDS.novaOperationalMaxMB
            || safeTotal > THRESHOLDS.novaDataHardMaxMB,
    }
}

function getNovaDataUsage(dirPath: string): ReturnType<typeof classifyNovaDataUsage> {
    try {
        if (!existsSync(dirPath)) return classifyNovaDataUsage(0, 0)
        let totalBytes = 0
        let managedBytes = 0
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue
            if (entry.isDirectory() && entry.name.startsWith('.')) continue
            const bytes = getPathSizeBytes(join(dirPath, entry.name))
            totalBytes += bytes
            if (entry.isDirectory() && MANAGED_NOVA_DATA_DIRS.has(entry.name)) {
                managedBytes += bytes
            }
        }
        return classifyNovaDataUsage(totalBytes / 1e6, managedBytes / 1e6)
    } catch {
        return {
            sizeMB: -1,
            managedMB: -1,
            operationalMB: -1,
            warning: false,
        }
    }
}

function warningClasses(status: Pick<HealthStatus, 'disk' | 'memory' | 'novaData'>): string {
    return [
        status.disk.warning ? 'disk' : '',
        status.memory.warning ? 'memory' : '',
        status.novaData.warning ? 'nova-data' : '',
    ].filter(Boolean).join('|')
}

// ============================================
// Health Check Runner
// ============================================

let lastStatus: HealthStatus | null = null
let onWarningCallback: ((warnings: string[]) => void) | null = null

export function runHealthCheck(): HealthStatus {
    const warnings: string[] = []

    // Disk space
    const disk = getDiskSpace()
    const diskWarning = disk.freeGB >= 0
        && (disk.freeGB * 1024 < THRESHOLDS.diskFreeMinMB || disk.usedPercent >= THRESHOLDS.diskUsedMaxPercent)
    if (diskWarning) {
        warnings.push(`⚠️ Disk Space kritisch: ${disk.freeGB}GB frei, ${disk.usedPercent}% belegt`)
    }

    // Memory
    const memory = getMemoryUsage()
    const memoryWarning = memory.usedPercent >= 0 && memory.usedPercent > THRESHOLDS.memoryMaxPercent
    if (memoryWarning) {
        warnings.push(`⚠️ Memory hoch: ${memory.usedPercent}% belegt (${memory.usedMB}MB / ${memory.totalMB}MB)`)
    }

    // .nova-data size
    const novaDataPath = join(process.cwd(), '.nova-data')
    const novaData = getNovaDataUsage(novaDataPath)
    if (novaData.warning) {
        warnings.push(`⚠️ Nova-Daten kritisch: ${novaData.operationalMB}MB operativ, ${novaData.managedMB}MB verwaltet, ${novaData.sizeMB}MB gesamt`)
    }

    const status: HealthStatus = {
        timestamp: Date.now(),
        disk: { ...disk, warning: diskWarning },
        memory: { ...memory, warning: memoryWarning },
        novaData,
        healthy: warnings.length === 0,
        warnings,
    }

    // Log warnings
    if (warnings.length > 0) {
        console.log(`[HealthMonitor] ⚠️ ${warnings.length} warning(s):`)
        for (const w of warnings) {
            console.log(`[HealthMonitor]   ${w}`)
        }
        // A persistent condition is logged for observability, but notified only
        // when the affected resource class changes. Numeric drift must not
        // create a new Telegram alert every heartbeat.
        if (onWarningCallback && warningClasses(status) !== warningClasses(lastStatus || {
            disk: { ...disk, warning: false },
            memory: { ...memory, warning: false },
            novaData: { ...novaData, warning: false },
        })) {
            onWarningCallback(warnings)
        }
    } else if (!lastStatus || lastStatus.warnings.length > 0) {
        // Log only when transitioning from warning to healthy (or first check)
        console.log(`[HealthMonitor] ✅ System healthy — Disk: ${disk.freeGB}GB free, RAM: ${memory.usedPercent}%, .nova-data: ${novaData.sizeMB}MB (${novaData.managedMB}MB managed)`)
    }

    lastStatus = status
    return status
}

export function getLastHealthStatus(): HealthStatus | null {
    return lastStatus
}

export function setWarningCallback(callback: (warnings: string[]) => void): void {
    onWarningCallback = callback
}

export function formatHealthStatus(status: HealthStatus): string {
    const lines: string[] = ['## 🏥 System Health']

    if (status.healthy) {
        lines.push('✅ **Alles OK**\n')
    } else {
        lines.push('⚠️ **Warnungen:**\n')
        for (const w of status.warnings) {
            lines.push(`- ${w}`)
        }
        lines.push('')
    }

    lines.push('| Ressource | Wert | Status |')
    lines.push('|-----------|------|--------|')
    lines.push(`| 💾 Disk | ${status.disk.freeGB}GB frei / ${status.disk.totalGB}GB | ${status.disk.warning ? '⚠️' : '✅'} |`)
    lines.push(`| 🧠 RAM | ${status.memory.usedPercent}% (${status.memory.usedMB}MB) | ${status.memory.warning ? '⚠️' : '✅'} |`)
    lines.push(`| 📁 .nova-data | ${status.novaData.sizeMB}MB gesamt (${status.novaData.operationalMB}MB operativ, ${status.novaData.managedMB}MB verwaltet) | ${status.novaData.warning ? '⚠️' : '✅'} |`)

    return lines.join('\n')
}

export default {
    runHealthCheck,
    getLastHealthStatus,
    setWarningCallback,
    formatHealthStatus,
}
