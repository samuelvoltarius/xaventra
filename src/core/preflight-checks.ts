/**
 * Nova Pre-Flight Checks
 * 
 * Systematic environment validation before deployments,
 * SSH commands, or node operations. Prevents blind failures
 * by checking architecture, runtime, ports, LLMs, etc.
 * 
 * Usage:
 *   /preflight <host>     — Run all checks on a remote host
 *   /preflight local      — Run checks on local machine
 *   /preflight            — Show last check results
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Types
// ============================================

export interface PreFlightResult {
    host: string
    timestamp: string
    checks: CheckResult[]
    passed: number
    failed: number
    warnings: number
    summary: string
}

export interface CheckResult {
    name: string
    status: 'pass' | 'fail' | 'warn'
    message: string
    detail?: string
}

// ============================================
// Local Pre-Flight Checks
// ============================================

export async function runLocalPreFlight(): Promise<PreFlightResult> {
    const checks: CheckResult[] = []

    // 1. Node.js version & architecture
    checks.push({
        name: 'Node.js Runtime',
        status: 'pass',
        message: `Node ${process.version} (${process.arch}, ${process.platform})`,
    })

    // 2. Check if dist/ exists
    const distExists = existsSync(join(process.cwd(), 'dist', 'daemon.js'))
    checks.push({
        name: 'Build Output (dist/)',
        status: distExists ? 'pass' : 'fail',
        message: distExists ? 'dist/daemon.js found' : 'dist/daemon.js MISSING — run npm run build',
    })

    // 3. Check config
    const configPath = resolveConfigPath()
    const configExists = existsSync(configPath)
    checks.push({
        name: 'Config File',
        status: configExists ? 'pass' : 'fail',
        message: configExists ? 'xaventra.config.json found' : 'xaventra.config.json MISSING',
    })

    // 4. Check ports
    for (const port of [3001, 3002]) {
        const portFree = await checkPortFree(port)
        checks.push({
            name: `Port ${port}`,
            status: portFree ? 'pass' : 'warn',
            message: portFree ? `Port ${port} available` : `Port ${port} in use`,
        })
    }

    // 5. Check local LLMs
    const llmChecks = await checkLocalLLMs('localhost')
    checks.push(...llmChecks)

    // 6. Auth tokens
    const tokenFile = join(process.cwd(), '.nova-tokens.json')
    const hasTokens = existsSync(tokenFile)
    checks.push({
        name: 'Auth Tokens',
        status: hasTokens ? 'pass' : 'warn',
        message: hasTokens ? 'Token file found' : 'No token file — cloud LLMs unavailable',
    })

    return buildResult('localhost', checks)
}

// ============================================
// Remote Pre-Flight Checks (via SSH)
// ============================================

export async function runRemotePreFlight(host: string, user: string = 'xaventra', port: number = 22): Promise<PreFlightResult> {
    const checks: CheckResult[] = []
    const ssh = (cmd: string): string => {
        try {
            return execSync(
                `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -p ${port} ${user}@${host} "${cmd}"`,
                { timeout: 10000, encoding: 'utf-8' }
            ).trim()
        } catch (err: any) {
            return `ERROR: ${err.message?.slice(0, 100) || 'command failed'}`
        }
    }

    // 1. SSH Connectivity
    const whoami = ssh('whoami')
    if (whoami.startsWith('ERROR')) {
        checks.push({
            name: 'SSH Connection',
            status: 'fail',
            message: `Cannot connect to ${user}@${host}:${port}`,
            detail: whoami,
        })
        return buildResult(host, checks)
    }
    checks.push({
        name: 'SSH Connection',
        status: 'pass',
        message: `Connected as ${whoami}@${host}`,
    })

    // 2. OS Architecture
    const kernelArch = ssh('uname -m')
    const dpkgArch = ssh('dpkg --print-architecture 2>/dev/null || echo unknown')
    const archMatch = (kernelArch === 'aarch64' && dpkgArch === 'arm64') ||
        (kernelArch === 'x86_64' && dpkgArch === 'amd64') ||
        dpkgArch === 'unknown'
    checks.push({
        name: 'OS Architecture',
        status: archMatch ? 'pass' : 'fail',
        message: `Kernel: ${kernelArch}, Userland: ${dpkgArch}`,
        detail: archMatch ? undefined : '⚠️ Kernel/Userland mismatch! 64-bit kernel with 32-bit userland. Native packages like LanceDB will fail. Install 64-bit OS.',
    })

    // 3. Node.js
    const nodeVersion = ssh('node --version 2>/dev/null || echo NOT_INSTALLED')
    const nodeArch = ssh('node -p process.arch 2>/dev/null || echo unknown')
    const nodeOk = !nodeVersion.startsWith('NOT') && !nodeVersion.startsWith('ERROR')
    checks.push({
        name: 'Node.js',
        status: nodeOk ? (nodeArch === 'arm' ? 'warn' : 'pass') : 'fail',
        message: nodeOk ? `${nodeVersion} (${nodeArch})` : 'Node.js not installed',
        detail: nodeArch === 'arm' ? '⚠️ 32-bit Node.js — native modules (LanceDB) will fail. Install arm64 Node.' : undefined,
    })

    // 4. dist/ exists
    const distCheck = ssh('test -f ~/nova-core/dist/daemon.js && echo YES || echo NO')
    checks.push({
        name: 'Build Output (dist/)',
        status: distCheck === 'YES' ? 'pass' : 'fail',
        message: distCheck === 'YES' ? 'dist/daemon.js found' : 'dist/daemon.js MISSING — build or scp needed',
    })

    // 5. node_modules
    const nmCheck = ssh('test -d ~/nova-core/node_modules && echo YES || echo NO')
    checks.push({
        name: 'Dependencies (node_modules)',
        status: nmCheck === 'YES' ? 'pass' : 'fail',
        message: nmCheck === 'YES' ? 'node_modules present' : 'node_modules MISSING — run npm install',
    })

    // 6. Config
    const cfgCheck = ssh('test -f ~/nova-core/xaventra.config.json && echo YES || echo NO')
    checks.push({
        name: 'Config File',
        status: cfgCheck === 'YES' ? 'pass' : 'fail',
        message: cfgCheck === 'YES' ? 'xaventra.config.json found' : 'xaventra.config.json MISSING',
    })

    // 7. Telegram conflict check
    if (cfgCheck === 'YES') {
        const tgEnabled = ssh("node -e \"const c=JSON.parse(require('fs').readFileSync('/home/xaventra/nova-core/xaventra.config.json'));console.log(c.channels?.telegram?.enabled)\" 2>/dev/null || echo unknown")
        if (tgEnabled === 'true') {
            checks.push({
                name: 'Telegram Config',
                status: 'warn',
                message: 'Telegram enabled — will conflict if another instance uses same bot token!',
            })
        } else {
            checks.push({
                name: 'Telegram Config',
                status: 'pass',
                message: 'Telegram disabled (bridge mode OK)',
            })
        }
    }

    // 8. Ports
    for (const p of [3001, 3002]) {
        const portCheck = ssh(`ss -tlnp 2>/dev/null | grep :${p} || echo FREE`)
        checks.push({
            name: `Port ${p}`,
            status: portCheck.includes('FREE') ? 'pass' : 'warn',
            message: portCheck.includes('FREE') ? `Port ${p} available` : `Port ${p} in use`,
        })
    }

    // 9. Local LLMs
    const ollamaCheck = ssh('which ollama 2>/dev/null && ollama list 2>/dev/null | head -5 || echo NOT_FOUND')
    if (ollamaCheck.includes('NOT_FOUND')) {
        const llamaCheck = ssh('curl -s --connect-timeout 2 http://localhost:8080/v1/models 2>/dev/null || echo NOT_RUNNING')
        if (llamaCheck.includes('NOT_RUNNING') || llamaCheck.includes('ERROR')) {
            checks.push({
                name: 'Local LLMs',
                status: 'warn',
                message: 'No Ollama, no llama.cpp server running',
                detail: 'Install Ollama or start llama.cpp server for local inference',
            })
        } else {
            checks.push({
                name: 'Local LLMs',
                status: 'pass',
                message: 'llama.cpp server responding on :8080',
            })
        }
    } else {
        checks.push({
            name: 'Local LLMs',
            status: 'pass',
            message: `Ollama available:\n${ollamaCheck.slice(0, 200)}`,
        })
    }

    // 10. Disk space
    const diskCheck = ssh("df -h / | tail -1 | awk '{print $4}'")
    checks.push({
        name: 'Disk Space',
        status: 'pass',
        message: `${diskCheck} free`,
    })

    // 11. RAM
    const ramCheck = ssh("free -m | awk '/Mem:/{printf \"%dMB / %dMB (%.0f%%)\", $3, $2, $3*100/$2}'")
    checks.push({
        name: 'RAM',
        status: 'pass',
        message: ramCheck,
    })

    // 12. Running Nova instances
    const novaProc = ssh("ps aux | grep 'node dist/daemon' | grep -v grep | wc -l")
    const running = parseInt(novaProc) || 0
    checks.push({
        name: 'Nova Instances',
        status: running === 0 ? 'pass' : (running === 1 ? 'pass' : 'warn'),
        message: running === 0 ? 'No running instance' : `${running} instance(s) running`,
        detail: running > 1 ? '⚠️ Multiple instances detected — potential port/resource conflicts' : undefined,
    })

    return buildResult(host, checks)
}

// ============================================
// Helpers
// ============================================

async function checkPortFree(port: number): Promise<boolean> {
    try {
        const cmd = process.platform === 'win32'
            ? `netstat -ano | findstr :${port} | findstr LISTENING`
            : `ss -tlnp | grep :${port}`
        execSync(cmd, { encoding: 'utf-8', timeout: 3000 })
        return false // port in use
    } catch {
        return true // port free (command found nothing)
    }
}

async function checkLocalLLMs(host: string): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    const endpoints = [
        { name: 'Ollama', port: 11434, path: '/api/tags' },
        { name: 'llama.cpp', port: 8080, path: '/v1/models' },
        { name: 'LMStudio', port: 1234, path: '/v1/models' },
    ]

    for (const ep of endpoints) {
        try {
            const res = await fetch(`http://${host}:${ep.port}${ep.path}`, {
                signal: AbortSignal.timeout(2000),
            })
            if (res.ok) {
                const data = await res.json() as any
                const models = data.models?.map((m: any) => m.name || m.id).join(', ') ||
                    data.data?.map((m: any) => m.id).join(', ') || 'available'
                results.push({
                    name: `LLM: ${ep.name}`,
                    status: 'pass',
                    message: `${ep.name} running on :${ep.port} — ${models}`,
                })
            }
        } catch {
            // Not running — skip silently
        }
    }

    if (results.length === 0) {
        results.push({
            name: 'Local LLMs',
            status: 'warn',
            message: 'No local LLM servers detected',
        })
    }

    return results
}

function buildResult(host: string, checks: CheckResult[]): PreFlightResult {
    const passed = checks.filter(c => c.status === 'pass').length
    const failed = checks.filter(c => c.status === 'fail').length
    const warnings = checks.filter(c => c.status === 'warn').length

    const icon = failed > 0 ? '❌' : warnings > 0 ? '⚠️' : '✅'
    const summary = `${icon} ${passed} passed, ${failed} failed, ${warnings} warnings`

    return { host, timestamp: new Date().toISOString(), checks, passed, failed, warnings, summary }
}

// ============================================
// Formatting
// ============================================

export function formatPreFlightResult(result: PreFlightResult): string {
    let msg = `🔍 *Pre-Flight Check: ${result.host}*\n`
    msg += `_${new Date(result.timestamp).toLocaleString('de-DE')}_\n\n`

    for (const c of result.checks) {
        const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️'
        msg += `${icon} *${c.name}*: ${c.message}\n`
        if (c.detail) msg += `   _${c.detail}_\n`
    }

    msg += `\n${result.summary}`
    if (result.failed > 0) {
        msg += '\n\n🛑 *Fix failed checks before deployment!*'
    }

    return msg
}
