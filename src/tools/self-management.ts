/**
 * Nova Self-Management Tool
 * 
 * Allows Nova to restart herself, check her own status, and perform self-maintenance.
 * Works cross-platform (Windows/Linux).
 */

import { execSync, spawn } from 'node:child_process'
import { platform } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// ============================================
// Platform Detection
// ============================================

const isWindows = platform() === 'win32'
const novaDir = process.cwd()

// ============================================
// Restart Methods
// ============================================

interface RestartResult {
    success: boolean
    method: string
    message: string
}

/**
 * Attempt to restart Nova using the best available method
 */
export async function restartNova(): Promise<RestartResult> {
    console.log('[SelfManagement] 🔄 Attempting to restart Nova...')

    // Method 1: Check if running under PM2
    if (await isRunningUnderPM2()) {
        return restartViaPM2()
    }

    // Method 2: Check if running as systemd service (Linux)
    if (!isWindows && await isSystemdService()) {
        return restartViaSystemd()
    }

    // Method 3: Direct restart (spawn new process, exit current)
    return restartDirect()
}

/**
 * Check if running under PM2
 */
async function isRunningUnderPM2(): Promise<boolean> {
    try {
        // PM2 sets PM2_HOME env variable
        if (process.env.PM2_HOME || process.env.pm_id !== undefined) {
            return true
        }
        // Try to check if pm2 list includes our process
        const output = execSync('pm2 jlist 2>nul || pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 })
        const processes = JSON.parse(output)
        return processes.some((p: any) => p.pm2_env?.pm_cwd === novaDir || p.name?.includes('nova'))
    } catch {
        return false
    }
}

/**
 * Restart via PM2
 */
function restartViaPM2(): RestartResult {
    try {
        const processName = process.env.pm_id || 'nova'
        console.log(`[SelfManagement] Restarting via PM2: ${processName}`)
        execSync(`pm2 restart ${processName}`, { encoding: 'utf-8', timeout: 10000 })
        return {
            success: true,
            method: 'PM2',
            message: `Nova wird via PM2 neugestartet. Bin gleich wieder da! 🚀`
        }
    } catch (err: any) {
        return {
            success: false,
            method: 'PM2',
            message: `PM2 restart fehlgeschlagen: ${err.message}`
        }
    }
}

/**
 * Check if running as systemd service (Linux)
 */
async function isSystemdService(): Promise<boolean> {
    if (isWindows) return false
    try {
        // Check if we're a systemd service
        const output = execSync('systemctl is-active nova 2>/dev/null', { encoding: 'utf-8', timeout: 5000 })
        return output.trim() === 'active'
    } catch {
        return false
    }
}

/**
 * Restart via systemd
 */
function restartViaSystemd(): RestartResult {
    try {
        console.log('[SelfManagement] Restarting via systemd...')
        // Note: This requires the user to have sudo permissions or the service to be user-level
        execSync('sudo systemctl restart nova', { encoding: 'utf-8', timeout: 10000 })
        return {
            success: true,
            method: 'systemd',
            message: `Nova wird via systemd neugestartet. Bin gleich wieder da! 🚀`
        }
    } catch (err: any) {
        return {
            success: false,
            method: 'systemd',
            message: `systemd restart fehlgeschlagen: ${err.message}`
        }
    }
}

/**
 * Direct restart - spawn new process and exit current
 */
function restartDirect(): RestartResult {
    console.log('[SelfManagement] Direct restart - spawning new process...')

    const npmCmd = isWindows ? 'npm.cmd' : 'npm'
    const startScript = existsSync(join(novaDir, 'package.json')) ? 'npm run nova' : 'node dist/daemon.js'

    try {
        // Spawn a new Nova process
        const child = spawn(npmCmd, ['run', 'nova'], {
            cwd: novaDir,
            detached: true,
            stdio: 'ignore',
            shell: true,
        })

        child.unref()

        // Schedule exit of current process
        setTimeout(() => {
            console.log('[SelfManagement] Exiting current process...')
            process.exit(0)
        }, 1000)

        return {
            success: true,
            method: 'direct',
            message: `Nova startet sich neu... Bin gleich wieder da! 🔄`
        }
    } catch (err: any) {
        return {
            success: false,
            method: 'direct',
            message: `Direkter Restart fehlgeschlagen: ${err.message}`
        }
    }
}

// ============================================
// Status Check
// ============================================

export interface NovaStatus {
    uptime: number
    uptimeFormatted: string
    memoryUsage: {
        heapUsed: number
        heapTotal: number
        external: number
    }
    platform: string
    nodeVersion: string
    pid: number
    cwd: string
}

export function getNovaStatus(): NovaStatus {
    const mem = process.memoryUsage()
    const uptimeSeconds = process.uptime()

    const hours = Math.floor(uptimeSeconds / 3600)
    const minutes = Math.floor((uptimeSeconds % 3600) / 60)
    const seconds = Math.floor(uptimeSeconds % 60)

    return {
        uptime: uptimeSeconds,
        uptimeFormatted: `${hours}h ${minutes}m ${seconds}s`,
        memoryUsage: {
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            external: Math.round(mem.external / 1024 / 1024),
        },
        platform: platform(),
        nodeVersion: process.version,
        pid: process.pid,
        cwd: novaDir,
    }
}

// ============================================
// Tool Definitions
// ============================================

export const selfManagementTools = [
    {
        name: 'nova_restart',
        description: 'Startet Nova komplett neu. Nutze das bei Updates oder wenn etwas hängt.',
        category: 'system' as const,
        parameters: [],
        handler: async () => {
            const result = await restartNova()
            return result
        },
    },
    {
        name: 'nova_status',
        description: 'Zeigt Novas aktuellen Status: Uptime, Memory, Platform.',
        category: 'system' as const,
        parameters: [],
        handler: async () => {
            const status = getNovaStatus()
            return {
                success: true,
                ...status,
                formatted: `
🤖 **Nova Status**
• Uptime: ${status.uptimeFormatted}
• Memory: ${status.memoryUsage.heapUsed}MB / ${status.memoryUsage.heapTotal}MB
• Platform: ${status.platform}
• Node: ${status.nodeVersion}
• PID: ${status.pid}
• Dir: ${status.cwd}
`.trim()
            }
        },
    },
]

export default selfManagementTools
