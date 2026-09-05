import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, platform, release, totalmem, freemem, uptime } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getCapabilityGraph } from '../mesh/capability-graph.js'

const execFileAsync = promisify(execFile)
const DATA_FILE = join(process.cwd(), '.nova-data', 'security', 'blue-team-incidents.json')
const MAX_LOG_BYTES = 5 * 1024 * 1024

export type BlueSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface BlueEvidence {
    id: string
    incidentId: string
    type: 'asset' | 'log' | 'ioc' | 'dependency' | 'decision' | 'validation'
    source: string
    observedAt: string
    summary: string
    sha256: string
    previousHash?: string
    metadata?: Record<string, unknown>
}

export interface BlueIncident {
    id: string
    title: string
    status: 'open' | 'contained' | 'closed'
    severity: BlueSeverity
    scope: string
    createdAt: string
    updatedAt: string
    evidence: BlueEvidence[]
}

export interface LogFinding {
    severity: BlueSeverity
    category: string
    line: number
    excerpt: string
}

const LOG_RULES: Array<{ severity: BlueSeverity; category: string; pattern: RegExp }> = [
    { severity: 'critical', category: 'credential-attack', pattern: /(?:authentication failure|invalid password|failed password).*(?:root|admin)/i },
    { severity: 'high', category: 'privilege-change', pattern: /(?:sudo|administrator|role).*(?:granted|elevated|owner)/i },
    { severity: 'high', category: 'malware-signal', pattern: /(?:ransomware|reverse shell|credential dump|mimikatz|webshell)/i },
    { severity: 'medium', category: 'repeated-failure', pattern: /(?:unauthorized|forbidden|access denied|login failed)/i },
    { severity: 'medium', category: 'service-instability', pattern: /(?:crash loop|restart loop|out of memory|oom killed|segmentation fault)/i },
    { severity: 'low', category: 'configuration-warning', pattern: /(?:deprecated|insecure|certificate.*expir|permission denied)/i },
]

function redact(value: string): string {
    return value
        .replace(/(?:bearer\s+|token[=:]\s*|api[_-]?key[=:]\s*)[A-Za-z0-9._~+\/-]{8,}/gi, '[REDACTED]')
        .replace(/\b(?:sk|ghp|xoxb)-?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
        .slice(0, 500)
}

function allowedRoots(): string[] {
    return [process.cwd(), join(process.cwd(), '.nova-data'), join(process.cwd(), '.nova-logs'),
        ...(process.env.NOVA_BLUE_TEAM_LOG_ROOTS || '').split(',').filter(Boolean)]
        .map(root => resolve(root.trim()))
}

function assertReadablePath(path: string): string {
    const target = resolve(path)
    const allowed = allowedRoots().some(root => {
        const rel = relative(root, target)
        return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`))
    })
    if (!allowed) throw new Error('Log path is outside the configured Blue Team roots')
    if (!existsSync(target)) throw new Error(`Log file not found: ${target}`)
    return target
}

export class BlueTeamService {
    private incidents = new Map<string, BlueIncident>()

    constructor(private readonly file = DATA_FILE) { this.load() }

    createIncident(title: string, scope = 'nova-managed-assets', severity: BlueSeverity = 'medium'): BlueIncident {
        const now = new Date().toISOString()
        const incident: BlueIncident = {
            id: `inc-${randomUUID()}`,
            title: redact(title || 'Untitled incident'),
            scope: redact(scope), severity, status: 'open', createdAt: now, updatedAt: now, evidence: [],
        }
        this.incidents.set(incident.id, incident)
        this.save()
        return structuredClone(incident)
    }

    listIncidents(): BlueIncident[] {
        return [...this.incidents.values()].map(item => structuredClone(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    getIncident(id: string): BlueIncident | undefined {
        const incident = this.incidents.get(id)
        return incident ? structuredClone(incident) : undefined
    }

    addEvidence(incidentId: string, type: BlueEvidence['type'], source: string, summary: string, metadata: Record<string, unknown> = {}): BlueEvidence {
        const incident = this.requireIncident(incidentId)
        const previousHash = incident.evidence.at(-1)?.sha256
        const observedAt = new Date().toISOString()
        const canonical = JSON.stringify({ incidentId, type, source, observedAt, summary: redact(summary), metadata, previousHash })
        const evidence: BlueEvidence = {
            id: `evi-${randomUUID()}`, incidentId, type, source: redact(source), observedAt,
            summary: redact(summary), metadata, previousHash, sha256: createHash('sha256').update(canonical).digest('hex'),
        }
        incident.evidence.push(evidence)
        incident.updatedAt = observedAt
        this.save()
        return structuredClone(evidence)
    }

    verifyEvidenceChain(incidentId: string): { valid: boolean; entries: number; firstInvalid?: string } {
        const incident = this.requireIncident(incidentId)
        for (let i = 0; i < incident.evidence.length; i++) {
            const entry = incident.evidence[i]
            if (entry.previousHash !== incident.evidence[i - 1]?.sha256) return { valid: false, entries: incident.evidence.length, firstInvalid: entry.id }
        }
        return { valid: true, entries: incident.evidence.length }
    }

    inventory(): Record<string, unknown> {
        const graph = getCapabilityGraph().getSnapshot()
        return {
            local: { hostname: hostname(), platform: platform(), release: release(), memoryTotal: totalmem(), memoryFree: freemem(), uptimeSeconds: uptime() },
            mesh: graph.nodes.map(node => ({
                id: node.id, hostname: node.hostname, status: node.status, lastSeen: node.lastHeartbeat || node.updatedAt,
                runtimes: node.runtimes.map(runtime => ({ type: runtime.type, status: runtime.status, models: runtime.models })),
            })),
            observedAt: new Date().toISOString(),
        }
    }

    analyzeLog(path: string): { path: string; lines: number; findings: LogFinding[]; truncated: boolean } {
        const target = assertReadablePath(path)
        const raw = readFileSync(target)
        const truncated = raw.byteLength > MAX_LOG_BYTES
        const text = raw.subarray(Math.max(0, raw.byteLength - MAX_LOG_BYTES)).toString('utf8')
        const lines = text.split(/\r?\n/)
        const findings: LogFinding[] = []
        for (let index = 0; index < lines.length; index++) {
            for (const rule of LOG_RULES) {
                if (rule.pattern.test(lines[index])) findings.push({ severity: rule.severity, category: rule.category, line: index + 1, excerpt: redact(lines[index]) })
            }
        }
        return { path: target, lines: lines.length, findings: findings.slice(0, 500), truncated }
    }

    checkIndicators(indicators: string[], textOrPath: string): { matches: Array<{ indicator: string; count: number }>; checked: number } {
        const cleanIndicators = [...new Set(indicators.map(item => item.trim().toLowerCase()).filter(item => item.length >= 3 && item.length <= 256))].slice(0, 1_000)
        let haystack = textOrPath
        if (existsSync(textOrPath)) haystack = readFileSync(assertReadablePath(textOrPath)).subarray(0, MAX_LOG_BYTES).toString('utf8')
        const lower = haystack.toLowerCase()
        const matches = cleanIndicators.map(indicator => ({
            indicator,
            count: lower.split(indicator).length - 1,
        })).filter(item => item.count > 0)
        return { matches, checked: cleanIndicators.length }
    }

    async dependencyAudit(repository = process.cwd()): Promise<Record<string, unknown>> {
        const target = resolve(repository)
        const rel = relative(process.cwd(), target)
        if (rel.startsWith('..')) throw new Error('Dependency audit is limited to the Nova workspace')
        try {
            const result = await execFileAsync('npm', ['audit', '--json', '--omit=dev'], { cwd: target, timeout: 120_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
            return JSON.parse(result.stdout)
        } catch (error: any) {
            const output = String(error?.stdout || '')
            if (output.trim().startsWith('{')) return JSON.parse(output)
            throw new Error(`Dependency audit unavailable: ${redact(String(error?.message || error))}`)
        }
    }

    containmentPlan(incidentId: string): Record<string, unknown> {
        const incident = this.requireIncident(incidentId)
        const categories = new Set(incident.evidence.map(item => String(item.metadata?.category || item.type)))
        return {
            incidentId,
            mode: 'proposal-only',
            requiresApproval: true,
            steps: [
                { order: 1, action: 'preserve-evidence', reversible: true, automatic: true },
                { order: 2, action: 'isolate-affected-service-or-node', reversible: true, automatic: false, gate: 'OWNER/PATCH_GATE' },
                { order: 3, action: 'rotate-exposed-credentials-if-confirmed', reversible: false, automatic: false, gate: 'OWNER' },
                { order: 4, action: 'apply-tested-hardening-change', reversible: true, automatic: false, gate: 'SANDBOX/CANARY/PATCH_GATE' },
                { order: 5, action: 'validate-and-monitor', reversible: true, automatic: true },
            ],
            observedCategories: [...categories],
            warning: 'This plan does not execute containment or offensive actions.',
        }
    }

    private requireIncident(id: string): BlueIncident {
        const incident = this.incidents.get(id)
        if (!incident) throw new Error(`Blue Team incident not found: ${id}`)
        return incident
    }

    private load(): void {
        if (!existsSync(this.file)) return
        try {
            const values = JSON.parse(readFileSync(this.file, 'utf8')) as BlueIncident[]
            for (const value of values) this.incidents.set(value.id, value)
        } catch { /* fail empty; corrupted state grants no capability */ }
    }

    private save(): void {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(this.file, JSON.stringify([...this.incidents.values()], null, 2), 'utf8')
    }
}

let singleton: BlueTeamService | null = null
export function getBlueTeamService(): BlueTeamService { return singleton ||= new BlueTeamService() }
