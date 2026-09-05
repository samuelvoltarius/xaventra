/**
 * Nova Self Doctor
 *
 * Bridges existing health, trace, mesh, and self-update systems into a single
 * improvement queue. This does not replace L15/L20/self-evolution; it turns
 * their signals into reviewable findings.
 */

import 'dotenv/config'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export type DoctorSeverity = 'info' | 'warning' | 'critical'
export type DoctorStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

export interface DoctorFinding {
    id: string
    title: string
    detail: string
    category: 'health' | 'tools' | 'trace' | 'mesh' | 'self-update' | 'config' | 'memory'
    severity: DoctorSeverity
    source: string
    recommendation: string
    evidence: Record<string, unknown>
    status: DoctorStatus
    createdAt: string
    updatedAt: string
    sourceNode?: string
}

export interface DoctorRunResult {
    healthy: boolean
    generated: number
    open: number
    findings: DoctorFinding[]
    summary: string
}

const DATA_DIR = join(process.cwd(), '.nova-data', 'self-doctor')
const FINDINGS_FILE = join(DATA_DIR, 'findings.json')
const SUPABASE_TABLE = 'nova_improvement_queue'

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function stableId(parts: Array<string | number | undefined>): string {
    const text = parts.filter(v => v !== undefined).join('|')
    return 'doctor_' + createHash('sha1').update(text).digest('hex').slice(0, 16)
}

function nowIso(): string {
    return new Date().toISOString()
}

function readJsonFile<T>(path: string, fallback: T): T {
    try {
        if (!existsSync(path)) return fallback
        return JSON.parse(readFileSync(path, 'utf-8')) as T
    } catch {
        return fallback
    }
}

function loadFindings(): DoctorFinding[] {
    ensureDir()
    const findings = readJsonFile<DoctorFinding[]>(FINDINGS_FILE, [])
    return Array.isArray(findings) ? findings : []
}

function saveFindings(findings: DoctorFinding[]): void {
    ensureDir()
    writeFileSync(FINDINGS_FILE, JSON.stringify(findings.slice(0, 200), null, 2))
}

function getSourceNode(): string | undefined {
    try {
        const path = join(process.cwd(), '.nova-data', 'instance-id.txt')
        if (existsSync(path)) return readFileSync(path, 'utf-8').trim()
    } catch { /* ignore */ }
    return undefined
}

function upsertFinding(store: DoctorFinding[], next: Omit<DoctorFinding, 'status' | 'createdAt' | 'updatedAt' | 'sourceNode'>): DoctorFinding {
    const existing = store.find(f => f.id === next.id)
    const ts = nowIso()
    if (existing) {
        existing.title = next.title
        existing.detail = next.detail
        existing.category = next.category
        existing.severity = next.severity
        existing.source = next.source
        existing.recommendation = next.recommendation
        existing.evidence = next.evidence
        existing.updatedAt = ts
        if (existing.status === 'resolved') existing.status = 'open'
        return existing
    }

    const finding: DoctorFinding = {
        ...next,
        status: 'open',
        createdAt: ts,
        updatedAt: ts,
        sourceNode: getSourceNode(),
    }
    store.unshift(finding)
    return finding
}

function resolveFinding(store: DoctorFinding[], id: string, detail: string): DoctorFinding | null {
    const finding = store.find(f => f.id === id)
    if (!finding || finding.status !== 'open') return null
    finding.status = 'resolved'
    finding.detail = detail
    finding.updatedAt = nowIso()
    return finding
}

export function recordRuntimeDoctorFinding(input: {
    key: string
    title: string
    detail: string
    category: DoctorFinding['category']
    severity: DoctorSeverity
    recommendation: string
    evidence?: Record<string, unknown>
}): DoctorFinding {
    const store = loadFindings()
    const finding = upsertFinding(store, {
        id: stableId(['runtime', input.key]),
        title: input.title,
        detail: input.detail,
        category: input.category,
        severity: input.severity,
        source: 'runtime-anomaly-detector',
        recommendation: input.recommendation,
        evidence: input.evidence || {},
    })
    saveFindings(store)
    void syncFinding(finding).catch(() => undefined)
    return finding
}

function loadSupabaseConfig(): { url: string; key: string } | null {
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            const url = config.supabase?.learningUrl || config.supabase?.meshUrl || config.supabase?.url
            const key = config.supabase?.learningKey || config.supabase?.meshKey || config.supabase?.serviceKey || config.supabase?.anonKey
            if (url && key) return { url, key }
        }
    } catch { /* ignore */ }

    const envUrl = process.env.NOVA_SUPABASE_URL || process.env.NOVA_MESH_SUPABASE_URL
    const envKey = process.env.NOVA_SUPABASE_SERVICE_KEY || process.env.NOVA_MESH_SUPABASE_KEY
    if (envUrl && envKey) return { url: envUrl, key: envKey }
    return null
}

async function syncFinding(finding: DoctorFinding): Promise<void> {
    const cfg = loadSupabaseConfig()
    if (!cfg) return

    const endpoint = `${cfg.url.replace(/\/$/, '')}/rest/v1/${SUPABASE_TABLE}`
    const headers = {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
    }

    const body = {
        id: finding.id,
        title: finding.title,
        description: finding.detail,
        source: finding.source,
        priority: finding.severity,
        risk: finding.severity === 'critical' ? 'high' : finding.severity === 'warning' ? 'medium' : 'low',
        status: finding.status,
        evidence: finding.evidence,
        proposed_actions: [{ type: 'recommendation', text: finding.recommendation }],
        verification: {},
        source_node: finding.sourceNode,
        created_at: finding.createdAt,
        updated_at: finding.updatedAt,
    }

    try {
        const res = await fetch(`${endpoint}?on_conflict=id`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        })
        if (!res.ok && res.status !== 404) {
            console.log(`[SelfDoctor] Supabase sync skipped: HTTP ${res.status}`)
        }
    } catch {
        // Best-effort only. Local queue remains source of truth.
    }
}

export function getDoctorFindings(options: { status?: DoctorStatus; limit?: number } = {}): DoctorFinding[] {
    let findings = loadFindings()
    if (options.status) findings = findings.filter(f => f.status === options.status)
    return findings.slice(0, options.limit ?? 50)
}

export function updateDoctorFindingStatus(id: string, status: DoctorStatus): boolean {
    const findings = loadFindings()
    const finding = findings.find(f => f.id === id)
    if (!finding) return false
    finding.status = status
    finding.updatedAt = nowIso()
    saveFindings(findings)
    syncFinding(finding).catch(() => { })
    return true
}

export async function runSelfDoctor(): Promise<DoctorRunResult> {
    const findings = loadFindings()
    const generated: DoctorFinding[] = []
    const evaluatedSources = new Set<string>()

    try {
        const { runHealthCheck } = await import('../layers/L0-health-monitor.js')
        const health = runHealthCheck()
        evaluatedSources.add('L0-health-monitor')
        if (!health.healthy) {
            generated.push(upsertFinding(findings, {
                id: stableId(['health', JSON.stringify(health.warnings || [])]),
                title: 'System health has warnings',
                detail: (health.warnings || ['Health check reported unhealthy state']).join('; '),
                category: 'health',
                severity: health.disk?.warning || health.memory?.warning ? 'critical' : 'warning',
                source: 'L0-health-monitor',
                recommendation: 'Inspect disk, RAM, and .nova-data size before running heavy work or deploys.',
                evidence: {
                    disk: health.disk,
                    memory: health.memory,
                    novaData: health.novaData,
                    warnings: health.warnings,
                },
            }))
        }
    } catch (err) {
        generated.push(upsertFinding(findings, {
            id: stableId(['health-monitor-unavailable']),
            title: 'Health monitor unavailable',
            detail: `L0 health monitor could not run: ${String(err).slice(0, 160)}`,
            category: 'health',
            severity: 'warning',
            source: 'self-doctor',
            recommendation: 'Check L0 health monitor imports and runtime dependencies.',
            evidence: { error: String(err) },
        }))
    }

    try {
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const { getSessionContinuityStore } = await import('../memory/session-summarizer.js')
        const governance = getMemoryGovernanceCoordinator()
        const records = governance.list()
        const maintenance = governance.getMaintenanceReport()
        const staleCandidates = records.filter(record =>
            record.status === 'candidate' && Date.now() - record.updatedAt > 30 * 24 * 60 * 60_000)
        const activeIds = new Set(records
            .filter(record => record.status === 'verified' || record.status === 'canonical')
            .map(record => record.id))
        const unresolvedConflicts = records.filter(record =>
            activeIds.has(record.id) && record.conflictIds.some(id => activeIds.has(id)))
        const orphanedProjections = records.filter(record =>
            ['rejected', 'expired', 'superseded'].includes(record.status)
            && Boolean(record.backends.lancedbId || record.backends.coreFact || record.backends.knowledgeGraph))
        const continuity = getSessionContinuityStore().getStats()
        evaluatedSources.add('memory-governance')
        const findingId = stableId(['memory-governance-health'])

        if (staleCandidates.length > 0 || unresolvedConflicts.length > 0 || orphanedProjections.length > 0 || maintenance.exactDuplicateGroups.length > 0) {
            generated.push(upsertFinding(findings, {
                id: findingId,
                title: 'Memory governance requires review',
                detail: `${staleCandidates.length} stale candidates, ${unresolvedConflicts.length} active conflicts, ${maintenance.exactDuplicateGroups.length} exact duplicate groups, ${orphanedProjections.length} inactive records with projections.`,
                category: 'memory',
                severity: unresolvedConflicts.length > 0 || orphanedProjections.length > 0 ? 'warning' : 'info',
                source: 'memory-governance',
                recommendation: 'Review candidates/conflicts through /memory review. Projection retraction remains an explicit governed action.',
                evidence: {
                    governance: governance.getStats(),
                    staleCandidateIds: staleCandidates.slice(0, 20).map(record => record.id),
                    unresolvedConflictIds: unresolvedConflicts.slice(0, 20).map(record => record.id),
                    orphanedProjectionIds: orphanedProjections.slice(0, 20).map(record => record.id),
                    continuity,
                    maintenance,
                },
            }))
        } else {
            const resolved = resolveFinding(findings, findingId, 'Automatically resolved: governed memory has no stale candidates, active conflicts, or orphaned projections.')
            if (resolved) await syncFinding(resolved)
        }
    } catch (err) {
        generated.push(upsertFinding(findings, {
            id: stableId(['memory-governance-unavailable']),
            title: 'Memory governance diagnostics unavailable',
            detail: `Memory diagnostics could not run: ${String(err).slice(0, 160)}`,
            category: 'memory',
            severity: 'warning',
            source: 'self-doctor',
            recommendation: 'Inspect the governed memory catalog and continuity file before relying on cross-session recall.',
            evidence: { error: String(err) },
        }))
    }

    try {
        const { getToolHealthStatus } = await import('../layers/L15-self-check.js')
        evaluatedSources.add('L15-self-check')
        for (const tool of getToolHealthStatus()) {
            const freshFailure = tool.lastFailure > 0 && Date.now() - tool.lastFailure < 60 * 60 * 1000
            if (tool.status === 'healthy' || !freshFailure) {
                for (const priorStatus of ['degraded', 'broken'] as const) {
                    const resolved = resolveFinding(
                        findings,
                        stableId(['tool', tool.name, priorStatus]),
                        tool.status === 'healthy'
                            ? `Automatically resolved: ${tool.name} currently reports healthy.`
                            : `Automatically resolved: ${tool.name} has no failure within the last hour; the stored incident is historical.`,
                    )
                    if (resolved) await syncFinding(resolved)
                }
                continue
            }
            generated.push(upsertFinding(findings, {
                id: stableId(['tool', tool.name, tool.status]),
                title: `Tool ${tool.name} is ${tool.status}`,
                detail: tool.lastDiagnosis || `${tool.consecutiveFailures} consecutive failures, ${tool.consecutiveEmpty} empty results`,
                category: 'tools',
                severity: tool.status === 'broken' ? 'critical' : 'warning',
                source: 'L15-self-check',
                recommendation: 'Route around this tool and inspect its config/dependencies before relying on it.',
                evidence: tool as unknown as Record<string, unknown>,
            }))
        }
    } catch { /* L15 unavailable is non-critical */ }

    try {
        const { loadTraceInsights, runTraceAnalysis } = await import('../learning/trace-analyzer.js')
        const insights = loadTraceInsights() || runTraceAnalysis()
        evaluatedSources.add('trace-analyzer')
        if (insights.overall.successRate > 0 && insights.overall.successRate < 0.95) {
            generated.push(upsertFinding(findings, {
                id: stableId(['trace-success-rate']),
                title: 'Trace success rate is below target',
                detail: `Success rate is ${(insights.overall.successRate * 100).toFixed(1)}% across ${insights.tracesAnalyzed} traces.`,
                category: 'trace',
                severity: insights.overall.successRate < 0.8 ? 'critical' : 'warning',
                source: 'trace-analyzer',
                recommendation: 'Review failing traces and convert recurring failures into self-update proposals.',
                evidence: { overall: insights.overall, mostFailingTools: insights.mostFailingTools },
            }))
        }
        const uniqueRecommendations = [...new Map(
            insights.recommendations.map(recommendation => [
                recommendation.toLowerCase().replace(/\s+/g, ' ').trim(),
                recommendation,
            ]),
        ).values()].slice(0, 5)
        for (const recommendation of uniqueRecommendations) {
            generated.push(upsertFinding(findings, {
                id: stableId(['trace-recommendation', recommendation]),
                title: 'Trace analyzer recommendation',
                detail: recommendation,
                category: 'trace',
                severity: 'info',
                source: 'trace-analyzer',
                recommendation,
                evidence: { tracesAnalyzed: insights.tracesAnalyzed },
            }))
        }
    } catch { /* trace analyzer unavailable is non-critical */ }

    try {
        const { getStats, getPendingProposals } = await import('./self-update.js')
        const stats = getStats()
        const pending = getPendingProposals()
        if (stats.pending > 0) {
            generated.push(upsertFinding(findings, {
                id: stableId(['self-update-pending']),
                title: 'Self-update proposals are waiting for review',
                detail: `${stats.pending} pending self-update proposal(s) exist.`,
                category: 'self-update',
                severity: 'info',
                source: 'self-update',
                recommendation: 'Review pending proposals before creating more autonomous code changes.',
                evidence: { stats, pending: pending.map(p => ({ id: p.id, file: p.file, type: p.type, description: p.description, confidence: p.confidence })) },
            }))
        }
    } catch { /* self-update unavailable is non-critical */ }

    try {
        const { discoverNodes } = await import('../mesh/mesh-registry.js')
        const nodes = await discoverNodes()
        evaluatedSources.add('mesh-registry')
        const offline = nodes.filter(n => n.status === 'offline')
        if (offline.length > 0) {
            generated.push(upsertFinding(findings, {
                id: stableId(['mesh-offline', offline.map(n => n.node_id).sort().join(',')]),
                title: 'Mesh has offline nodes',
                detail: `${offline.length} node(s) are offline: ${offline.map(n => n.hostname || n.node_id).join(', ')}`,
                category: 'mesh',
                severity: 'warning',
                source: 'mesh-registry',
                recommendation: 'Confirm expected offline state, then restart or remove stale mesh nodes.',
                evidence: { offline: offline.map(n => ({ id: n.node_id, hostname: n.hostname, lastHeartbeat: n.last_heartbeat })) },
            }))
        }
    } catch { /* mesh discovery may fail when Supabase is unavailable */ }

    try {
        const { inspectFailoverReadiness } = await import('../mesh/failover-readiness.js')
        const readiness = await inspectFailoverReadiness()
        evaluatedSources.add('failover-readiness')
        const findingId = stableId(['failover-readiness'])
        if (readiness.mode === 'ha' && !readiness.ready) {
            generated.push(upsertFinding(findings, {
                id: findingId,
                title: 'HA failover is not fully ready',
                detail: readiness.gates.filter(gate => !gate.ok).map(gate => `${gate.id}: ${gate.evidence}`).join('; '),
                category: 'mesh',
                severity: 'warning',
                source: 'failover-readiness',
                recommendation: 'Restore the failed readiness gates. Nova remains fail-closed and will not start an unsafe second Main.',
                evidence: readiness as unknown as Record<string, unknown>,
            }))
        } else {
            const resolved = resolveFinding(findings, findingId, `Automatically resolved: failover readiness is valid for mode ${readiness.mode}.`)
            if (resolved) await syncFinding(resolved)
        }
    } catch { /* readiness is optional outside HA mode */ }

    // ---- LLM endpoint reachability (from capability probe cache) ----
    // The capability probe only tests LOCAL/mesh endpoints — it never probes
    // cloud providers (MiniMax/OpenAI). So zero "online models" only means the
    // local fleet is down; it does NOT mean Nova can't process requests when a
    // cloud provider is the configured primary. Raising a CRITICAL finding here
    // produced false "No LLM endpoints" panics that spammed the autonomy loop
    // even while MiniMax cloud was serving every request.
    try {
        const { getOnlineModels, getProbeStatusSummary } = await import('../llm/capability-probe.js')
        const online = getOnlineModels()
        const { getCapabilityGraph } = await import('../mesh/capability-graph.js')
        const graphOnline = getCapabilityGraph().getSnapshot().nodes.flatMap(node => node.runtimes).filter(runtime =>
            runtime.status === 'running'
            && ['llm', 'vllm', 'ollama', 'lmstudio', 'openai-compatible'].includes(runtime.type.toLowerCase())
            && Date.now() - Date.parse(runtime.verifiedAt) < 15 * 60_000)
        const noOnlineModelsId = stableId(['llm-no-online-models'])
        const noLocalModelsId = stableId(['llm-no-local-models'])
        if (online.length === 0 && graphOnline.length === 0) {
            // Is a cloud provider configured as primary? Then local being down
            // is at most a warning (lost fast fallback), never critical.
            let cloudPrimary = false
            let providerName = 'unknown'
            try {
                const configPath = join(process.cwd(), 'nova.config.json')
                const persisted = existsSync(configPath)
                    ? JSON.parse(readFileSync(configPath, 'utf-8'))
                    : {}
                providerName = String(
                    persisted.provider
                    || persisted.preferredProvider
                    || process.env.NOVA_LLM_PROVIDER
                    || 'unknown',
                ).toLowerCase()
                cloudPrimary = new Set(['minimax', 'openai', 'anthropic', 'openrouter', 'groq', 'openai-codex']).has(providerName)
            } catch { /* config unavailable — fall back to critical */ }

            if (cloudPrimary) {
                const resolved = resolveFinding(
                    findings,
                    noOnlineModelsId,
                    `Automatically resolved: cloud provider "${providerName}" is configured as the active primary; no total LLM outage exists.`,
                )
                if (resolved) await syncFinding(resolved)
                const resolvedLocal = resolveFinding(
                    findings,
                    noLocalModelsId,
                    `Automatically resolved: cloud provider "${providerName}" is active; local endpoints are optional capacity, not an incident.`,
                )
                if (resolvedLocal) await syncFinding(resolvedLocal)
            } else {
                generated.push(upsertFinding(findings, {
                    id: noOnlineModelsId,
                    title: 'No LLM endpoints responding',
                    detail: 'Capability probe found zero reachable model endpoints. Nova may be unable to process requests.',
                    category: 'health',
                    severity: 'critical',
                    source: 'capability-probe',
                    recommendation: 'Check that Ollama or LM Studio is running and models are loaded. Run /models to force a rescan.',
                    evidence: { probeSummary: getProbeStatusSummary(), capabilityGraphRuntimes: graphOnline.length, cloudPrimary, provider: providerName },
                }))
            }
        } else {
            const resolved = resolveFinding(
                findings,
                noOnlineModelsId,
                `Automatically resolved: ${online.length} capability probe model(s) and ${graphOnline.length} fresh Capability Graph runtime(s) are reachable.`,
            )
            if (resolved) await syncFinding(resolved)
            const resolvedLocal = resolveFinding(
                findings,
                noLocalModelsId,
                `Automatically resolved: ${online.length} capability probe model(s) and ${graphOnline.length} fresh Capability Graph runtime(s) are reachable.`,
            )
            if (resolvedLocal) await syncFinding(resolvedLocal)
        }
    } catch { /* capability probe optional */ }

    // ---- Auto-disabled models ----
    try {
        const { getDisabledModels } = await import('../llm/model-perf-db.js')
        const disabled = getDisabledModels()
        if (disabled.length > 0) {
            generated.push(upsertFinding(findings, {
                id: stableId(['llm-auto-disabled', disabled.map(d => d.model).sort().join(',')]),
                title: `${disabled.length} model(s) auto-disabled due to failures`,
                detail: disabled.map(d => `${d.model}: ${d.reason} (re-enables at ${new Date(d.disabledUntil).toLocaleTimeString()})`).join('; '),
                category: 'health',
                severity: 'warning',
                source: 'model-perf-db',
                recommendation: 'Models will auto-re-enable after 1 hour. Manually fix underlying issues (VRAM, model files, endpoint config).',
                evidence: { disabled },
            }))
        }
    } catch { /* perf db optional */ }

    // ---- Message queue health ----
    try {
        const { getQueueStats } = await import('../channels/message-queue.js')
        const queueStats = getQueueStats()
        if (queueStats.failed > 0) {
            generated.push(upsertFinding(findings, {
                id: stableId(['msg-queue-failed', queueStats.failed]),
                title: `${queueStats.failed} message(s) permanently failed`,
                detail: `Message queue: ${queueStats.total} total, ${queueStats.pending} pending, ${queueStats.done} done, ${queueStats.failed} failed (max retries exceeded).`,
                category: 'health',
                severity: 'warning',
                source: 'message-queue',
                recommendation: 'Check logs for the failed message IDs. These messages were not answered and will not be retried.',
                evidence: { queueStats },
            }))
        }
        if (queueStats.pending > 3) {
            generated.push(upsertFinding(findings, {
                id: stableId(['msg-queue-backlog']),
                title: 'Message queue backlog is growing',
                detail: `${queueStats.pending} messages are pending/processing — Nova may be overloaded or stuck.`,
                category: 'health',
                severity: 'warning',
                source: 'message-queue',
                recommendation: 'Restart Nova daemon if messages are not draining. Check LLM response latency.',
                evidence: { queueStats },
            }))
        }
    } catch { /* queue stats optional */ }

    // ---- Config completeness ----
    try {
        const cfgPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(cfgPath)) {
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
            const issues: string[] = []

            if (cfg.channels?.telegram?.enabled && !cfg.channels?.telegram?.token && !process.env.TELEGRAM_BOT_TOKEN) {
                issues.push('Telegram token missing')
            }
            const telegramIntentionallyDisabled = process.env.NOVA_NO_TELEGRAM === 'true'
                || process.env.NOVA_TELEGRAM_MODE === 'disabled'
                || (process.env.NOVA_NODE_ONLY === 'true' && process.env.NOVA_TELEGRAM_MODE !== 'standby')
            if (!cfg.channels?.telegram?.enabled && !telegramIntentionallyDisabled) issues.push('Telegram disabled')

            // SSH key for mesh/remote
            const sshKeyPath = join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'id_ed25519')
            if (!existsSync(sshKeyPath)) {
                const sshRsaPath = join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'id_rsa')
                if (!existsSync(sshRsaPath)) {
                    issues.push('No SSH key found (~/.ssh/id_ed25519 or id_rsa) — mesh remote access may fail')
                }
            }

            if (issues.length > 0) {
                generated.push(upsertFinding(findings, {
                    id: stableId(['config-incomplete']),
                    title: 'Config has missing or incomplete entries',
                    detail: issues.join('; '),
                    category: 'config',
                    severity: 'warning',
                    source: 'self-doctor',
                    recommendation: 'Update nova.config.json or set the missing environment variables.',
                    evidence: { issues },
                }))
            } else {
                for (const finding of findings.filter(f =>
                    f.status === 'open' && f.source === 'self-doctor' && f.title === 'Config has missing or incomplete entries')) {
                    const resolved = resolveFinding(findings, finding.id, 'Automatically resolved: current configuration satisfies required runtime entries.')
                    if (resolved) await syncFinding(resolved)
                }
            }
        }
    } catch { /* config check optional */ }

    // Findings from a successful snapshot source that were not reproduced by
    // the current run are historical, not open incidents.
    const currentIds = new Set(generated.map(f => f.id))
    for (const finding of findings) {
        if (finding.status !== 'open') continue
        if (!evaluatedSources.has(finding.source)) continue
        if (currentIds.has(finding.id)) continue
        const resolved = resolveFinding(
            findings,
            finding.id,
            `Automatically resolved: ${finding.source} did not reproduce this finding in the latest successful snapshot.`,
        )
        if (resolved) await syncFinding(resolved)
    }

    saveFindings(findings)
    await Promise.all(generated.map(f => syncFinding(f)))
    try {
        const { getFailureResearchCoordinator } = await import('../doctor/failure-research-coordinator.js')
        for (const finding of generated.filter(item => item.status === 'open' && item.severity !== 'info')) {
            getFailureResearchCoordinator().ingest(finding)
        }
    } catch { /* diagnosis remains available if the research projection is unavailable */ }

    const open = findings.filter(f => f.status === 'open')
    const healthy = open.filter(f => f.severity !== 'info').length === 0
    return {
        healthy,
        generated: generated.length,
        open: open.length,
        findings: open.slice(0, 20),
        summary: formatDoctorSummary({ healthy, generated: generated.length, open: open.length, findings: open.slice(0, 20) }),
    }
}

export function formatDoctorSummary(result: Omit<DoctorRunResult, 'summary'>): string {
    const icon = result.healthy ? '✅' : '⚠️'
    const lines = [
        `## ${icon} Nova Self-Doctor`,
        `Status: **${result.healthy ? 'Healthy' : 'Attention needed'}**`,
        `Findings: ${result.open} open (${result.generated} updated this run)`,
    ]

    if (result.findings.length > 0) {
        lines.push('')

        // Group by category
        const byCategory: Record<string, typeof result.findings> = {}
        for (const f of result.findings.slice(0, 12)) {
            if (!byCategory[f.category]) byCategory[f.category] = []
            byCategory[f.category].push(f)
        }

        const categoryLabels: Record<string, string> = {
            health: '🏥 Health',
            tools: '🔧 Tools',
            trace: '📊 Traces',
            mesh: '🌐 Mesh',
            'self-update': '🔄 Self-Update',
            config: '⚙️ Config',
        }

        for (const [cat, catFindings] of Object.entries(byCategory)) {
            lines.push(`**${categoryLabels[cat] || cat}**`)
            for (const f of catFindings) {
                const sev = f.severity === 'critical' ? '❌' : f.severity === 'warning' ? '⚠️' : 'ℹ️'
                lines.push(`  ${sev} ${f.title}`)
                lines.push(`     → ${f.recommendation}`)
            }
        }
    }

    // Quick LLM status inline (no finding needed if all good)
    try {
        const { getProbeStatusSummary } = require('../llm/capability-probe.js')
        const probeSummary = getProbeStatusSummary()
        if (probeSummary) {
            lines.push('', probeSummary)
        }
    } catch { /* optional */ }

    // Message queue inline
    try {
        const { getQueueStats } = require('../channels/message-queue.js')
        const qs = getQueueStats()
        if (qs.total > 0) {
            const qIcon = qs.failed > 0 ? '⚠️' : '✅'
            lines.push(`\n**📬 Message Queue**: ${qIcon} ${qs.done} done · ${qs.pending} pending · ${qs.failed} failed`)
        }
    } catch { /* optional */ }

    return lines.join('\n')
}

export default {
    runSelfDoctor,
    getDoctorFindings,
    updateDoctorFindingStatus,
    formatDoctorSummary,
}
