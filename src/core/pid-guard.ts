import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export function isNovaDaemonCommandLine(commandLine: string): boolean {
    const normalized = commandLine.replaceAll('\\', '/').toLowerCase()
    return normalized.includes('dist/daemon.js') || normalized.includes('src/daemon.ts')
}

function commandLineForPid(pid: number): string {
    try {
        if (process.platform === 'win32') {
            return String(execFileSync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
            ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })).trim()
        }
        if (process.platform === 'linux') {
            return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
        }
        return String(execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 5000,
        })).trim()
    } catch {
        return ''
    }
}

/**
 * PID files outlive crashes and numeric PIDs are eventually reused. Treat an
 * existing PID as Nova only when the OS command line identifies Nova's daemon.
 * If process inspection is unavailable, fail closed to avoid duplicate daemons.
 */
export function isNovaDaemonPid(pid: number): boolean {
    try {
        process.kill(pid, 0)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
        return false
    }
    const commandLine = commandLineForPid(pid)
    return commandLine ? isNovaDaemonCommandLine(commandLine) : true
}
