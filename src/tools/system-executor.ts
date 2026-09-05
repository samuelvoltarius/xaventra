/**
 * Nova — Cross-Platform System Executor
 *
 * REAL command execution via child_process.
 * Works on Windows, macOS, and Linux as standalone app or inside NovaOS.
 *
 * This is the fix for Nova's hallucination problem:
 * Instead of generating text about running commands,
 * this module actually executes them and returns real results.
 */

import { execFile, exec, type ExecOptions } from 'node:child_process'
import { readFile, writeFile, stat, readdir, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, basename, extname } from 'node:path'
import { homedir, platform, hostname, tmpdir, cpus, totalmem, freemem } from 'node:os'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// ============================================
// Types
// ============================================

export interface ExecutionResult {
    success: boolean
    stdout: string
    stderr: string
    exitCode: number
    duration: number
}

export interface FileResult {
    success: boolean
    content?: string
    error?: string
    path: string
    size?: number
}

export interface ScreenshotResult {
    success: boolean
    path?: string
    error?: string
}

export interface SystemInfo {
    platform: NodeJS.Platform
    hostname: string
    cpus: number
    totalMemory: string
    freeMemory: string
    homeDir: string
    tempDir: string
    isNovaOS: boolean
}

// ============================================
// Security: Command Allow/Block Lists
// ============================================

interface SecurityConfig {
    allowedPaths: string[]
    blockedCommands: string[]
    requireConfirmation: string[]
    maxOutputBytes: number
    timeoutMs: number
}

const DEFAULT_SECURITY: SecurityConfig = {
    allowedPaths: [
        homedir(),
        tmpdir(),
        '/opt/novaos',
        '/tmp',
    ],
    blockedCommands: [
        'rm -rf /',
        'mkfs',
        'dd if=/dev',
        'format c:',
        ':(){:|:&};:',
        'shutdown',
        'reboot',
        'halt',
        'poweroff',
    ],
    requireConfirmation: [
        'apt install',
        'apt remove',
        'npm install -g',
        'pip install',
        'systemctl',
        'docker rm',
        'docker rmi',
    ],
    maxOutputBytes: 100_000,  // 100KB max output
    timeoutMs: 30_000,        // 30s timeout
}

// ============================================
// Cross-Platform System Executor
// ============================================

export class SystemExecutor {
    private security: SecurityConfig
    private os: NodeJS.Platform

    constructor(securityOverrides?: Partial<SecurityConfig>) {
        this.security = { ...DEFAULT_SECURITY, ...securityOverrides }
        this.os = platform()

        // Add platform-specific allowed paths
        if (this.os === 'win32') {
            this.security.allowedPaths.push(
                'C:\\Users',
                'C:\\temp',
                process.env.APPDATA || '',
                process.env.LOCALAPPDATA || '',
            )
        } else if (this.os === 'darwin') {
            this.security.allowedPaths.push(
                '/Users',
                '/Applications',
                '/usr/local',
            )
        }
    }

    // ============================================
    // Command Execution (the critical fix)
    // ============================================

    /**
     * Execute a system command and return REAL results.
     * Uses execFile (no shell injection) when possible.
     */
    async runCommand(command: string, options?: {
        cwd?: string
        timeout?: number
        shell?: boolean
    }): Promise<ExecutionResult> {
        const start = Date.now()

        // Security: check blocked commands
        const cmdLower = command.toLowerCase()
        for (const blocked of this.security.blockedCommands) {
            if (cmdLower.includes(blocked.toLowerCase())) {
                return {
                    success: false,
                    stdout: '',
                    stderr: `🚫 Blocked: "${command}" matches security rule "${blocked}"`,
                    exitCode: -1,
                    duration: 0,
                }
            }
        }

        // Security: check if confirmation needed
        const needsConfirm = this.security.requireConfirmation.some(
            rc => cmdLower.includes(rc.toLowerCase())
        )

        if (needsConfirm) {
            console.log(`[SystemExecutor] ⚠️ Command requires confirmation: ${command}`)
            // In standalone mode, we log but proceed. In NovaOS, the watchdog would gate this.
        }

        const execOptions: ExecOptions = {
            cwd: options?.cwd || homedir(),
            timeout: options?.timeout || this.security.timeoutMs,
            maxBuffer: this.security.maxOutputBytes,
            env: { ...process.env, LANG: 'en_US.UTF-8' },
        }

        try {
            // Use shell mode for complex commands (pipes, redirects)
            const useShell = options?.shell !== false && (
                command.includes('|') ||
                command.includes('>') ||
                command.includes('&&') ||
                command.includes(';')
            )

            let result: { stdout: string; stderr: string }

            if (useShell) {
                // Shell mode: needed for pipes, redirects
                const shell = this.os === 'win32' ? 'powershell.exe' : '/bin/bash'
                const shellArgs = this.os === 'win32'
                    ? ['-NoProfile', '-Command', command]
                    : ['-c', command]
                result = await execFileAsync(shell, shellArgs, { ...execOptions, encoding: 'utf-8' })
            } else {
                // Safe mode: split command into binary + args
                const parts = command.split(/\s+/)
                const binary = parts[0]
                const args = parts.slice(1)
                result = await execFileAsync(binary, args, { ...execOptions, encoding: 'utf-8' })
            }

            return {
                success: true,
                stdout: result.stdout.trim(),
                stderr: result.stderr.trim(),
                exitCode: 0,
                duration: Date.now() - start,
            }
        } catch (err: unknown) {
            const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
            return {
                success: false,
                stdout: (e.stdout || '').trim(),
                stderr: (e.stderr || e.message || 'Unknown error').trim(),
                exitCode: e.code || 1,
                duration: Date.now() - start,
            }
        }
    }

    // ============================================
    // File Operations
    // ============================================

    async readFileContent(filePath: string): Promise<FileResult> {
        const resolved = resolve(filePath)

        if (!this.isPathAllowed(resolved)) {
            return { success: false, error: `Path not allowed: ${resolved}`, path: resolved }
        }

        try {
            const stats = await stat(resolved)
            if (stats.size > 5_000_000) {
                return { success: false, error: `File too large: ${stats.size} bytes`, path: resolved }
            }

            const content = await readFile(resolved, 'utf-8')
            return { success: true, content, path: resolved, size: stats.size }
        } catch (err: unknown) {
            return { success: false, error: (err as Error).message, path: resolved }
        }
    }

    async writeFileContent(filePath: string, content: string): Promise<FileResult> {
        const resolved = resolve(filePath)

        if (!this.isPathAllowed(resolved)) {
            return { success: false, error: `Path not allowed: ${resolved}`, path: resolved }
        }

        try {
            const dir = join(resolved, '..')
            if (!existsSync(dir)) {
                await mkdir(dir, { recursive: true })
            }
            await writeFile(resolved, content, 'utf-8')
            return { success: true, path: resolved, size: content.length }
        } catch (err: unknown) {
            return { success: false, error: (err as Error).message, path: resolved }
        }
    }

    async listDirectory(dirPath: string): Promise<FileResult> {
        const resolved = resolve(dirPath)

        if (!this.isPathAllowed(resolved)) {
            return { success: false, error: `Path not allowed: ${resolved}`, path: resolved }
        }

        try {
            const entries = await readdir(resolved, { withFileTypes: true })
            const listing = entries.map(e => {
                const type = e.isDirectory() ? '📁' : '📄'
                return `${type} ${e.name}`
            }).join('\n')
            return { success: true, content: listing, path: resolved }
        } catch (err: unknown) {
            return { success: false, error: (err as Error).message, path: resolved }
        }
    }

    async deleteFile(filePath: string): Promise<FileResult> {
        const resolved = resolve(filePath)

        if (!this.isPathAllowed(resolved)) {
            return { success: false, error: `Path not allowed: ${resolved}`, path: resolved }
        }

        try {
            await unlink(resolved)
            return { success: true, path: resolved }
        } catch (err: unknown) {
            return { success: false, error: (err as Error).message, path: resolved }
        }
    }

    // ============================================
    // Screenshot (cross-platform)
    // ============================================

    async takeScreenshot(outputPath?: string): Promise<ScreenshotResult> {
        const filename = `screenshot-${Date.now()}.png`
        const output = outputPath || join(tmpdir(), filename)

        try {
            if (this.os === 'win32') {
                // Windows: PowerShell Screenshot
                const psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
          $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
          $bitmap.Save('${output.replace(/\\/g, '\\\\')}')
          $graphics.Dispose()
          $bitmap.Dispose()
        `
                await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
                    timeout: 10000,
                })
            } else if (this.os === 'darwin') {
                // macOS: screencapture
                await execFileAsync('screencapture', ['-x', output], { timeout: 10000 })
            } else {
                // Linux: scrot or gnome-screenshot or import (ImageMagick)
                try {
                    await execFileAsync('scrot', [output], { timeout: 10000 })
                } catch {
                    try {
                        await execFileAsync('gnome-screenshot', ['-f', output], { timeout: 10000 })
                    } catch {
                        await execFileAsync('import', ['-window', 'root', output], { timeout: 10000 })
                    }
                }
            }

            if (existsSync(output)) {
                return { success: true, path: output }
            }
            return { success: false, error: 'Screenshot file not created' }
        } catch (err: unknown) {
            return { success: false, error: (err as Error).message }
        }
    }

    // ============================================
    // System Info
    // ============================================

    getSystemInfo(): SystemInfo {
        const totalMem = totalmem()
        const free = freemem()
        return {
            platform: this.os,
            hostname: hostname(),
            cpus: cpus().length,
            totalMemory: `${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
            freeMemory: `${(free / 1024 / 1024 / 1024).toFixed(1)} GB`,
            homeDir: homedir(),
            tempDir: tmpdir(),
            isNovaOS: existsSync('/etc/os-release') &&
                require('fs').readFileSync('/etc/os-release', 'utf-8').includes('NovaOS'),
        }
    }

    // ============================================
    // Cross-Platform Helpers
    // ============================================

    /**
     * Get the right command for common operations across platforms.
     */
    getCommand(action: 'list_files' | 'find_process' | 'network_scan' | 'disk_usage' | 'open_url', arg?: string): string {
        const commands: Record<string, Record<NodeJS.Platform, string>> = {
            list_files: {
                win32: `Get-ChildItem -Path "${arg || '.'}" -Force`,
                darwin: `ls -la "${arg || '.'}"`,
                linux: `ls -la "${arg || '.'}"`,
            } as Record<NodeJS.Platform, string>,
            find_process: {
                win32: `Get-Process ${arg ? `| Where-Object { $_.ProcessName -like '*${arg}*' }` : ''}`,
                darwin: `ps aux ${arg ? `| grep -i "${arg}"` : ''}`,
                linux: `ps aux ${arg ? `| grep -i "${arg}"` : ''}`,
            } as Record<NodeJS.Platform, string>,
            network_scan: {
                win32: 'arp -a',
                darwin: 'arp -a',
                linux: 'ip neigh show',
            } as Record<NodeJS.Platform, string>,
            disk_usage: {
                win32: 'Get-PSDrive -PSProvider FileSystem | Format-Table Name, Used, Free -AutoSize',
                darwin: 'df -h',
                linux: 'df -h',
            } as Record<NodeJS.Platform, string>,
            open_url: {
                win32: `Start-Process "${arg}"`,
                darwin: `open "${arg}"`,
                linux: `xdg-open "${arg}" 2>/dev/null || sensible-browser "${arg}"`,
            } as Record<NodeJS.Platform, string>,
        }

        return commands[action]?.[this.os] || commands[action]?.linux || `echo "Unknown action: ${action}"`
    }

    // ============================================
    // Security Helpers
    // ============================================

    private isPathAllowed(filePath: string): boolean {
        const resolved = resolve(filePath)
        return this.security.allowedPaths.some(allowed =>
            resolved.startsWith(resolve(allowed))
        )
    }

    /**
     * Add a path to the allowed list at runtime.
     */
    allowPath(path: string): void {
        this.security.allowedPaths.push(resolve(path))
    }

    /**
     * Block a command pattern at runtime.
     */
    blockCommand(pattern: string): void {
        this.security.blockedCommands.push(pattern)
    }
}

// ============================================
// Singleton
// ============================================

let instance: SystemExecutor | null = null

export const getSystemExecutor = (overrides?: Partial<SecurityConfig>): SystemExecutor => {
    if (!instance) instance = new SystemExecutor(overrides)
    return instance
}

export default { SystemExecutor, getSystemExecutor }
