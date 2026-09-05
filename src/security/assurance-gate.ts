import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { runChaosAssurance } from './chaos-assurance.js'
import { resolveConfigPath } from '../config/config-path.js'


const execFileAsync = promisify(execFile)

export interface AssuranceFinding {
    id: string
    severity: 'info' | 'warning' | 'blocking'
    message: string
    evidence?: Record<string, unknown>
}

export interface AssuranceReport {
    version: 1
    createdAt: string
    passed: boolean
    dependencyAudit: { critical: number; high: number; moderate: number; low: number; total: number }
    chaos: Awaited<ReturnType<typeof runChaosAssurance>>
    findings: AssuranceFinding[]
}

const SOURCE_SCAN_EXCLUDES = new Set([
    '.git', '.nova-data', '.nova-logs', '.nova-test-tmp', '.pnpm-store', 'coverage', 'dist',
    'node_modules', 'output', 'temp', 'tmp',
])

const FORBIDDEN_WALLET_PATHS = new Set([
    'wallet.json',
    'wallets.json',
    'operation_world_dominance',
])

/**
 * Fail closed if a release tree contains the removed wallet experiment or a
 * literal EVM private key. This intentionally reports paths and rule IDs only;
 * secret values must never enter assurance output or logs.
 */
export function scanSourceForWalletMaterial(root = process.cwd()): Array<{ path: string; rule: string }> {
    const findings: Array<{ path: string; rule: string }> = []
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (SOURCE_SCAN_EXCLUDES.has(entry.name)) continue
            const absolute = join(directory, entry.name)
            const path = relative(root, absolute).replaceAll('\\', '/')
            const firstSegment = path.split('/')[0].toLowerCase()
            if (FORBIDDEN_WALLET_PATHS.has(entry.name.toLowerCase()) || FORBIDDEN_WALLET_PATHS.has(firstSegment)) {
                findings.push({ path, rule: 'forbidden-wallet-artifact' })
                continue
            }
            if (entry.isDirectory()) {
                visit(absolute)
                continue
            }
            if (!entry.isFile() || lstatSync(absolute).size > 2 * 1024 * 1024) continue
            let content = ''
            try { content = readFileSync(absolute, 'utf8') } catch { continue }
            if (/['\"]private_key['\"]\s*:\s*['\"](?:0x)?[0-9a-f]{64}['\"]/i.test(content)) {
                findings.push({ path, rule: 'literal-evm-private-key' })
            }
            if (extname(path).toLowerCase() === '.py' && /\bgenerate_real_wallets\b|\bfrom\s+eth_account\s+import\s+Account\b|encrypted_wallets\.json/i.test(content)) {
                findings.push({ path, rule: 'wallet-generator' })
            }
        }
    }
    visit(root)
    return findings
}

async function dependencyAudit(): Promise<AssuranceReport['dependencyAudit']> {
    let output = ''
    const npmArgs = ['audit', '--json', '--omit=dev']
    const executable = process.platform === 'win32' ? process.execPath : 'npm'
    if (process.platform === 'win32') npmArgs.unshift(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    try { output = (await execFileAsync(executable, npmArgs, { cwd: process.cwd(), timeout: 120_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })).stdout }
    catch (error: any) { output = String(error?.stdout || '') }
    if (!output.trim().startsWith('{')) throw new Error('npm audit did not return JSON')
    return parseDependencyAudit(output)
}

export function parseDependencyAudit(output: string): AssuranceReport['dependencyAudit'] {
    const parsed = JSON.parse(output)
    const counts = parsed?.metadata?.vulnerabilities
    if (parsed?.error || !counts || ['critical', 'high', 'moderate', 'low', 'total'].some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
        throw new Error('npm audit returned an error or incomplete vulnerability metadata')
    }
    return {
        critical: Number(counts.critical || 0), high: Number(counts.high || 0), moderate: Number(counts.moderate || 0),
        low: Number(counts.low || 0), total: Number(counts.total || 0),
    }
}

function newestReport(directory: string): { file?: string; ageMs?: number } {
    if (!existsSync(directory)) return {}
    const files = readdirSync(directory).filter(file => file.endsWith('.json')).map(file => ({ file, mtime: new Date(Number(file.replace('.json', '')) || 0).getTime() }))
    const newest = files.sort((a, b) => b.mtime - a.mtime)[0]
    return newest ? { file: newest.file, ageMs: Date.now() - newest.mtime } : {}
}

export async function runSecurityAssurance(outputFile = join(process.cwd(), '.nova-data', 'security', 'assurance-latest.json')): Promise<AssuranceReport> {
    const findings: AssuranceFinding[] = []
    const walletMaterial = scanSourceForWalletMaterial()
    if (walletMaterial.length) {
        findings.push({
            id: 'wallet-material',
            severity: 'blocking',
            message: `${walletMaterial.length} forbidden wallet artifact(s) or generator(s) found in the release tree`,
            evidence: { matches: walletMaterial },
        })
    }
    let audit: AssuranceReport['dependencyAudit']
    try { audit = await dependencyAudit() }
    catch (error) {
        audit = { critical: 0, high: 0, moderate: 0, low: 0, total: 0 }
        findings.push({ id: 'dependency-audit-unavailable', severity: 'blocking', message: String(error) })
    }
    if (audit.critical > 0 || audit.high > 0) findings.push({ id: 'dependency-risk', severity: 'blocking', message: `${audit.critical} critical and ${audit.high} high runtime dependency findings`, evidence: audit })
    else if (audit.total > 0) findings.push({ id: 'dependency-advisories', severity: 'warning', message: `${audit.total} non-high runtime dependency advisories remain`, evidence: audit })

    try {
        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8'))
        const raw = config?.mcp?.servers
        const servers = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([name, value]) => ({ name, ...(value as object) }))
        const insecure = servers.filter((server: any) => typeof server.url === 'string' && /^http:\/\//i.test(server.url) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(server.url))
        if (insecure.length) findings.push({ id: 'mcp-transport', severity: 'blocking', message: `${insecure.length} remote MCP server(s) use plaintext HTTP`, evidence: { servers: insecure.map((server: any) => server.name || 'unnamed') } })
    } catch (error) { findings.push({ id: 'config-read', severity: 'blocking', message: `Could not validate MCP configuration: ${String(error)}` }) }

    const external = newestReport(join(process.cwd(), '.nova-data', 'benchmarks', 'external-comparisons'))
    if (!external.file) findings.push({ id: 'external-evaluation', severity: 'warning', message: 'No artifact-verified external agent comparison has been recorded yet' })
    else if (Number(external.ageMs) > 30 * 24 * 60 * 60_000) findings.push({ id: 'external-evaluation-stale', severity: 'warning', message: 'Latest external agent comparison is older than 30 days', evidence: external })

    const chaos = await runChaosAssurance()
    if (!chaos.passed) findings.push({ id: 'chaos-assurance', severity: 'blocking', message: 'One or more deterministic chaos checks failed', evidence: { failed: chaos.checks.filter(check => !check.passed) } })
    const report: AssuranceReport = { version: 1, createdAt: new Date().toISOString(), passed: !findings.some(item => item.severity === 'blocking'), dependencyAudit: audit, chaos, findings }
    mkdirSync(dirname(outputFile), { recursive: true })
    writeFileSync(outputFile, JSON.stringify(report, null, 2))
    return report
}
