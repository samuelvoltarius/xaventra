/**
 * Nova Dashboard Server v2.0
 * 
 * Full-featured dashboard with:
 * - Live Stats (tokens, costs, sessions)
 * - Chat Interface (bidirectional WebSocket)
 * - Admin Features (config, tools, layers)
 * - Self-Update Proposals
 */

import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { z } from 'zod'
import { resolveConfigPath } from '../config/config-path.js'
import { dashboardAddress, listenDashboard } from './listener.js'


const __dirname = dirname(fileURLToPath(import.meta.url))

function safeDashboardPayload<T>(value: T): T {
    try { return JSON.parse(redactSecrets(JSON.stringify(value))) as T }
    catch { return value }
}

// ============================================
// Types
// ============================================

interface DashboardState {
    nova: {
        status: 'idle' | 'thinking' | 'executing' | 'waiting'
        currentTask: string
        lastMessage: string
        uptime: number
    }
    stats: {
        tokensToday: number
        tokensMonth: number
        costToday: number
        costMonth: number
        requestsToday: number
        requestsMonth: number
    }
    l0: {
        totalAttempts: number
        successfulRepairs: number
        repairsByType: Record<string, number>
    }
    agents: Array<{
        id: string
        status: string
        query: string
        startedAt: number
    }>
    thoughts: Array<{
        id: string
        content: string
        timestamp: number
        type?: string
        similarity?: number
    }>
    layers: Record<string, {
        active: boolean
        lastUsed: number
        callCount: number
    }>
    errors: Array<{
        id: string
        message: string
        stack?: string
        timestamp: number
        resolved: boolean
    }>
    watchdog: {
        healthy: boolean
        lastCheck: number
        issues: string[]
    }
}

interface ChatMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    channel: string
}

// ============================================
// State
// ============================================

let state: DashboardState = {
    nova: {
        status: 'idle',
        currentTask: '',
        lastMessage: '',
        uptime: Date.now(),
    },
    stats: {
        tokensToday: 0,
        tokensMonth: 0,
        costToday: 0,
        costMonth: 0,
        requestsToday: 0,
        requestsMonth: 0,
    },
    l0: {
        totalAttempts: 0,
        successfulRepairs: 0,
        repairsByType: {},
    },
    agents: [],
    thoughts: [],
    layers: {},
    errors: [],
    watchdog: {
        healthy: true,
        lastCheck: Date.now(),
        issues: [],
    },
}

const chatHistory: ChatMessage[] = []
const DATA_DIR = join(process.cwd(), '.nova-data')
const STATS_FILE = join(DATA_DIR, 'usage-stats.json')
const CHAT_HISTORY_FILE = join(DATA_DIR, 'chat-history.json')

// Load chat history from disk on startup
try {
    if (existsSync(CHAT_HISTORY_FILE)) {
        const saved = JSON.parse(readFileSync(CHAT_HISTORY_FILE, 'utf-8'))
        if (Array.isArray(saved)) {
            chatHistory.push(...saved.slice(-200))
            console.log(`[Dashboard] Loaded ${chatHistory.length} chat messages from disk`)
        }
    }
} catch { /* fresh start */ }

function saveChatHistory() {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        // Keep max 500 messages
        const toSave = chatHistory.slice(-500)
        atomicWriteJsonSync(CHAT_HISTORY_FILE, toSave)
    } catch (err) {
        console.error('[Dashboard] Failed to save chat history:', err)
    }
}

// ============================================
// Data Loading
// ============================================

function loadStats(): DashboardState['stats'] {
    if (!existsSync(STATS_FILE)) {
        return state.stats
    }
    try {
        const data = JSON.parse(readFileSync(STATS_FILE, 'utf-8'))
        const stats = {
            tokensToday: data.tokensToday || 0,
            tokensMonth: data.tokensMonth || 0,
            costToday: data.costToday || 0,
            costMonth: data.costMonth || 0,
            requestsToday: data.requestsToday || 0,
            requestsMonth: data.requestsMonth || 0,
        }

        // Daily reset: check if the saved date differs from today (or is missing)
        const today = new Date().toLocaleDateString('sv-SE')  // YYYY-MM-DD
        const savedDate = data.lastResetDate || ''
        if (!savedDate || savedDate !== today) {
            console.log(`[Dashboard] Daily stats reset — was ${savedDate}, now ${today}`)
            stats.tokensToday = 0
            stats.costToday = 0
            stats.requestsToday = 0

            // Monthly reset on 1st of month
            const savedMonth = savedDate.slice(0, 7)
            const currentMonth = today.slice(0, 7)
            if (savedMonth !== currentMonth) {
                console.log(`[Dashboard] Monthly stats reset — was ${savedMonth}, now ${currentMonth}`)
                stats.tokensMonth = 0
                stats.costMonth = 0
                stats.requestsMonth = 0
            }
        }

        return stats
    } catch {
        return state.stats
    }
}

function saveStats(): void {
    try {
        const today = new Date().toLocaleDateString('sv-SE')
        const toSave = { ...state.stats, lastResetDate: today }
        atomicWriteJsonSync(STATS_FILE, toSave)
    } catch (err) {
        console.error('[Dashboard] Failed to save stats:', err)
    }
}

function loadVectorMemory(): DashboardState['thoughts'] {
    // Try all possible memory data directories
    const dirs = [
        join(process.cwd(), '.nova-data', 'memory'),
        join(process.cwd(), '.nova-vector-memory'),
        join(process.cwd(), '.nova-data'),
    ]

    for (const dir of dirs) {
        if (!existsSync(dir)) continue

        const indexFile = join(dir, 'index.json')
        if (!existsSync(indexFile)) continue

        try {
            // VectorMemoryStore format: { "userId": MemoryEntry[] }
            const data = JSON.parse(readFileSync(indexFile, 'utf-8'))
            const entries: DashboardState['thoughts'] = []

            for (const [userId, userEntries] of Object.entries(data)) {
                const items = Array.isArray(userEntries) ? userEntries : []
                for (const e of items.slice(-25) as any[]) {
                    entries.push({
                        id: e.id || 'unknown',
                        content: e.content || e.text || '',
                        timestamp: e.timestamp || Date.now(),
                        type: e.role || e.metadata?.tool || 'thought',
                    })
                }
            }

            if (entries.length > 0) {
                // Sort by timestamp descending, show newest first
                entries.sort((a, b) => b.timestamp - a.timestamp)
                return entries.slice(0, 50)
            }
        } catch {
            continue
        }
    }

    return []
}

function loadLanceDBMemory(): DashboardState['thoughts'] {
    const entries: DashboardState['thoughts'] = []

    // Load journal entries from L06
    const journalDir = join(process.cwd(), '.nova-data', 'memory', 'journal')
    if (existsSync(journalDir)) {
        try {
            const files = require('node:fs').readdirSync(journalDir)
                .filter((f: string) => f.endsWith('.json'))
                .sort()
                .slice(-10)

            for (const file of files) {
                try {
                    const journal = JSON.parse(readFileSync(join(journalDir, file), 'utf-8'))
                    entries.push({
                        id: `journal-${journal.date}`,
                        content: `📓 ${journal.date}: ${journal.summary || 'No summary'}`,
                        timestamp: journal.createdAt || Date.now(),
                        type: 'journal',
                    })
                } catch { /* skip corrupt */ }
            }
        } catch { /* no journal dir */ }
    }

    // Load core facts
    const coreFactsFile = join(process.cwd(), '.nova-data', 'CORE_FACTS.json')
    if (existsSync(coreFactsFile)) {
        try {
            const facts = JSON.parse(readFileSync(coreFactsFile, 'utf-8'))
            if (Array.isArray(facts) && facts.length > 0) {
                entries.push({
                    id: 'core_facts',
                    content: `📋 ${facts.length} Core Facts gespeichert`,
                    timestamp: Date.now(),
                    type: 'system',
                })
            }
        } catch { /* skip */ }
    }

    // LanceDB status
    const statusFile = join(process.cwd(), '.nova-data', 'lancedb-status.json')
    if (existsSync(statusFile)) {
        entries.push({
            id: 'lancedb_status',
            content: 'LanceDB initialized and ready',
            timestamp: Date.now(),
            type: 'system',
        })
    }

    return entries
}

function loadL0Stats(): DashboardState['l0'] {
    try {
        const statsFile = join(DATA_DIR, 'l0-stats.json')
        if (existsSync(statsFile)) {
            return JSON.parse(readFileSync(statsFile, 'utf-8'))
        }
    } catch { }
    return { totalAttempts: 0, successfulRepairs: 0, repairsByType: {} }
}

function loadAgents(): DashboardState['agents'] {
    try {
        const { getSubAgentManager } = require('../layers/L8-sub-agent.js')
        const mgr = getSubAgentManager()
        return mgr.getActiveTasks().map((t: any) => ({
            id: t.id,
            status: t.status,
            query: t.query,
            startedAt: t.startedAt,
        }))
    } catch {
        return []
    }
}

function loadLayers(): DashboardState['layers'] {
    const layers: DashboardState['layers'] = {}
    const layerDir = join(process.cwd(), 'src', 'layers')

    if (!existsSync(layerDir)) return layers

    try {
        const files = readdirSync(layerDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
        for (const file of files) {
            const name = file.replace(/\.(ts|js)$/, '')
            layers[name] = {
                active: true,
                lastUsed: Date.now(),
                callCount: 0,
            }
        }
    } catch { }

    return layers
}

function loadErrors(): DashboardState['errors'] {
    const errorFile = join(DATA_DIR, 'errors.json')
    if (!existsSync(errorFile)) return []

    try {
        const data = JSON.parse(readFileSync(errorFile, 'utf-8'))
        return (data.errors || []).slice(-50)
    } catch {
        return []
    }
}

function loadSelfUpdateProposals(): any[] {
    const historyFile = join(DATA_DIR, 'self-updates', 'history.json')
    if (!existsSync(historyFile)) return []

    try {
        const data = JSON.parse(readFileSync(historyFile, 'utf-8'))
        return data.proposals || []
    } catch {
        return []
    }
}

function loadConfig(): Record<string, any> {
    const configFile = resolveConfigPath()
    if (!existsSync(configFile)) return {}

    try {
        return JSON.parse(readFileSync(configFile, 'utf-8'))
    } catch {
        return {}
    }
}

function saveConfig(config: Record<string, any>): boolean {
    try {
        const configFile = resolveConfigPath()
        writeFileSync(configFile, JSON.stringify(config, null, 2))
        return true
    } catch {
        return false
    }
}

function loadTools(): string[] {
    const toolsDir = join(process.cwd(), 'src', 'tools')
    if (!existsSync(toolsDir)) return []

    try {
        return readdirSync(toolsDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    } catch {
        return []
    }
}

function loadSessions(): any[] {
    const sessionsDir = join(process.cwd(), '.nova-sessions')
    if (!existsSync(sessionsDir)) return []

    try {
        const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
        return files.slice(-20).reverse().map(f => {
            try {
                const filePath = join(sessionsDir, f)
                const raw = readFileSync(filePath, 'utf-8')
                const lines = raw.split('\n').filter(l => l.trim())

                // First line is session header (NDJSON format)
                const header = JSON.parse(lines[0])

                // Count actual messages (type: "message")
                let messageCount = 0
                let userId = ''
                let lastTimestamp = header.timestamp
                for (let i = 1; i < lines.length; i++) {
                    try {
                        const msg = JSON.parse(lines[i])
                        if (msg.type === 'message') {
                            messageCount++
                            if (!userId && msg.role === 'user') {
                                userId = msg.userId || msg.role || ''
                            }
                        }
                        if (msg.timestamp) lastTimestamp = msg.timestamp
                    } catch { /* skip malformed lines */ }
                }

                // Derive channel from header metadata
                const channel = header.channel
                    || (header.modelId?.includes('gpt') ? 'OpenAI' : '')
                    || header.type || 'local'

                return {
                    id: header.id || f.replace('.json', ''),
                    userId: userId || header.userId || 'Sample',
                    channel: channel,
                    messageCount,
                    updatedAt: lastTimestamp || new Date().toISOString(),
                }
            } catch {
                return { id: f.replace('.json', ''), userId: 'Sample', channel: 'local', messageCount: 0, updatedAt: '' }
            }
        })
    } catch {
        return []
    }
}

// ============================================
// Express Server
// ============================================

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

app.disable('x-powered-by')
app.use(express.json({ limit: '256kb' }))
// Prevent stale cached dashboard assets
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
    next()
})
app.use(express.static(join(__dirname, 'public')))

// ============================================
// 🛡️ API Security: Localhost-only guard for write/action endpoints
// Prevents external processes from injecting messages or modifying Nova state.
// ============================================

const WRITE_PROTECTED_PATHS = ['/api/chat', '/api/config', '/api/proposals', '/api/memory', '/api/sessions', '/api/summaries/generate', '/api/core-facts', '/api/trust']
const writeRate = new Map<string, { startedAt: number; count: number }>()
app.use((req, res, next) => {
    if (req.method === 'GET') return next() // reads always ok
    const ip = req.socket.remoteAddress || req.ip || ''
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1')
    const isProtected = WRITE_PROTECTED_PATHS.some(p => req.path.startsWith(p))
    if (isProtected) {
        const key = `${ip}:${Math.floor(Date.now() / 60_000)}`
        const bucket = writeRate.get(key) || { startedAt: Date.now(), count: 0 }
        bucket.count++
        writeRate.set(key, bucket)
        if (bucket.count > 120) return void res.status(429).json({ error: 'Too many dashboard write requests' })
        if (writeRate.size > 1_000) for (const [entry, value] of writeRate) if (Date.now() - value.startedAt > 120_000) writeRate.delete(entry)
    }
    if (isProtected && !isLocalhost) {
        console.warn(`[Dashboard] 🛡️ Blocked write request to ${req.path} from ${ip}`)
        res.status(403).json({ error: 'Forbidden: write access restricted to localhost' })
        return
    }
    next()
})



// Full state
app.get('/api/status', (req, res) => {
    state.thoughts = [...loadVectorMemory(), ...loadLanceDBMemory()]
    state.l0 = loadL0Stats()
    state.agents = loadAgents()
    state.layers = loadLayers()
    state.errors = loadErrors()
    state.stats = loadStats()
    res.json(safeDashboardPayload(state))
})

// Stats
app.get('/api/stats', (req, res) => {
    res.json(loadStats())
})

// Unified live performance view: pipeline, runtime, backpressure, cache and models.
app.get('/api/performance', async (_req, res) => {
    try {
        const [{ getTraceStats }, { getRuntimePerformance }, { interactiveRequestGate }, cache, modelPerf, queue] = await Promise.all([
            import('../core/request-tracer.js'),
            import('../core/performance-budget.js'),
            import('../core/request-gate.js'),
            import('../llm/response-cache.js'),
            import('../llm/model-perf-db.js'),
            import('../channels/message-queue.js'),
        ])
        res.json({
            timestamp: Date.now(),
            pipeline: getTraceStats(),
            runtime: getRuntimePerformance(),
            backpressure: interactiveRequestGate.getStats(),
            cache: cache.getCacheStats(),
            models: modelPerf.getAllModelStats().sort((a, b) => b.totalCalls - a.totalCalls).slice(0, 12),
            messageQueue: queue.getQueueStats(),
        })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// Trust view: this extends the existing dashboard with Nova's canonical
// Outcome Ledger; it is not a second dashboard or a parallel state store.
app.get('/api/trust/runs', async (req, res) => {
    try {
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
        const runs = getOutcomeLedger().listRuns(limit)
        res.json({
            runs,
            summary: {
                total: runs.length,
                running: runs.filter(run => run.status === 'running').length,
                awaitingApproval: runs.filter(run => run.status === 'awaiting_approval').length,
                completed: runs.filter(run => run.status === 'completed').length,
                failed: runs.filter(run => run.status === 'failed').length,
                validated: runs.filter(run => run.validation?.success).length,
            },
        })
    } catch (err) {
        res.status(500).json({ runs: [], error: String(err) })
    }
})

app.get('/api/trust/runs/:id', async (req, res) => {
    try {
        const [{ getOutcomeLedger }, { getPendingExecutionRegistry }] = await Promise.all([
            import('../core/outcome-ledger.js'), import('../core/execution-control.js'),
        ])
        const ledger = getOutcomeLedger()
        const run = ledger.getRun(req.params.id)
        if (!run) return res.status(404).json({ error: 'Outcome run not found' })
        res.json({ ...run, checkpoint: ledger.loadCheckpoint(req.params.id), liveApproval: getPendingExecutionRegistry().get(req.params.id) })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

app.post('/api/trust/runs/:id/:action', async (req, res) => {
    try {
        const [{ getPendingExecutionRegistry }, { getOutcomeLedger }] = await Promise.all([
            import('../core/execution-control.js'), import('../core/outcome-ledger.js'),
        ])
        const action = req.params.action as 'approve' | 'reject' | 'resume'
        if (!['approve', 'reject', 'resume'].includes(action)) return res.status(404).json({ success: false, error: 'Unknown trust action' })
        let result: unknown
        try {
            result = await getPendingExecutionRegistry().act(req.params.id, action, String(req.body?.reason || ''))
        } catch (liveError) {
            const checkpoint = getOutcomeLedger().loadCheckpoint(req.params.id)
            if (!checkpoint?.backendState || !checkpoint.resumeInput || checkpoint.backend !== 'openai-agents') throw liveError
            const [{ OpenAIAgentsBackend }] = await Promise.all([import('../agents/openai-agents-backend.js')])
            result = await new OpenAIAgentsBackend().resumeWithDecision(
                checkpoint.resumeInput as any, checkpoint.backendState, action, String(req.body?.reason || ''),
            )
        }
        getOutcomeLedger().recordApproval(req.params.id, { decision: action, source: 'trust-dashboard', operatorAt: new Date().toISOString() })
        res.json({ success: true, result })
    } catch (err) {
        res.status(409).json({ success: false, error: String(err) })
    }
})

app.post('/api/trust/runs/:id/feedback', async (req, res) => {
    try {
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        const rating = req.body?.rating === undefined ? undefined : Math.max(1, Math.min(5, Number(req.body.rating)))
        getOutcomeLedger().recordFeedback(req.params.id, {
            rating, accepted: req.body?.accepted === true, comment: String(req.body?.comment || '').slice(0, 4000),
            correction: String(req.body?.correction || '').slice(0, 8000), userId: String(req.body?.userId || 'dashboard'),
        })
        res.json({ success: true })
    } catch (err) { res.status(500).json({ success: false, error: String(err) }) }
})

app.post('/api/trust/runs/:id/compensate', async (req, res) => {
    try {
        const { getIdempotencyStore } = await import('../core/execution-control.js')
        const result = await getIdempotencyStore().compensate(String(req.body?.idempotencyKey || ''))
        res.json({ success: true, result })
    } catch (err) { res.status(409).json({ success: false, error: String(err) }) }
})

app.get('/api/trust/capabilities', async (_req, res) => {
    try { const { getCapabilityGraph } = await import('../mesh/capability-graph.js'); res.json(getCapabilityGraph().getSnapshot()) }
    catch (err) { res.status(500).json({ error: String(err) }) }
})

app.get('/api/trust/mesh-transport', async (_req, res) => {
    try {
        const runtime = await import('../mesh/mesh-transport-runtime.js')
        const transport = runtime.getMeshTransport()
        res.json({
            identity: runtime.meshTransportPublicIdentity(),
            router: transport?.health() || { healthy: false, name: 'outbox', queued: 0, connectedPeers: 0 },
            transports: transport?.transportHealth() || [],
            peers: runtime.getMeshPeerStates(),
        })
    } catch (error) { res.status(503).json({ healthy: false, error: String(error) }) }
})

app.get('/api/trust/benchmarks/scenarios', async (_req, res) => {
    try { const { getBenchmarkScenarios } = await import('../benchmark/benchmark-lab.js'); res.json({ scenarios: getBenchmarkScenarios() }) }
    catch (err) { res.status(500).json({ error: String(err) }) }
})

app.get('/api/trust/operator-overview', async (_req, res) => {
    try {
        const [{ getMissionWorkspaceManager }, { getMCPRuntimeStatus }, { getOutcomeRouter }, { getMemoryGovernanceCoordinator }, { getBlueTeamService }, { getLifecyclePolicy }] = await Promise.all([
            import('../runtime/mission-workspace.js'), import('../mcp/mcp-runtime.js'), import('../routing/outcome-router.js'),
            import('../memory/memory-governance.js'), import('../security/blue-team.js'), import('../core/lifecycle-policy.js'),
        ])
        const mcp = getMCPRuntimeStatus()
        res.json(safeDashboardPayload({
            workspaces: getMissionWorkspaceManager().list(),
            mcp: { initialized: mcp.initialized, tools: mcp.tools, servers: mcp.servers.map((item: any) => ({ name: item.name, connected: item.connected, tools: item.tools, resources: item.resources, prompts: item.prompts })) },
            router: getOutcomeRouter().getTrainingStatus(),
            memory: { stats: getMemoryGovernanceCoordinator().getStats(), maintenance: getMemoryGovernanceCoordinator().getMaintenanceReport() },
            blueTeam: { incidents: getBlueTeamService().listIncidents() },
            lifecycle: { hooks: getLifecyclePolicy().list() },
        }))
    } catch (error) { res.status(500).json({ error: String(error) }) }
})

app.get('/api/trust/workspaces/:id/diff', async (req, res) => {
    try {
        const id = z.string().regex(/^[a-zA-Z0-9_.-]{3,100}$/).parse(req.params.id)
        const { getMissionWorkspaceManager } = await import('../runtime/mission-workspace.js')
        res.json({ id, diff: await getMissionWorkspaceManager().diff(id) })
    } catch (error) { res.status(400).json({ error: String(error) }) }
})

app.post('/api/trust/workspaces/:id/promote', async (req, res) => {
    try {
        const input = z.object({ repository: z.string().min(1).max(1_000), approved: z.literal(true) }).parse(req.body)
        const id = z.string().regex(/^[a-zA-Z0-9_.-]{3,100}$/).parse(req.params.id)
        const { getMissionWorkspaceManager } = await import('../runtime/mission-workspace.js')
        res.json({ success: true, result: await getMissionWorkspaceManager().promote(id, input.repository, input.approved) })
    } catch (error) { res.status(409).json({ success: false, error: String(error) }) }
})

app.get('/api/trust/blue-team/incidents', async (_req, res) => {
    try { const { getBlueTeamService } = await import('../security/blue-team.js'); res.json({ incidents: getBlueTeamService().listIncidents() }) }
    catch (error) { res.status(500).json({ incidents: [], error: String(error) }) }
})

app.get('/api/trust/browser/replay', async (req, res) => {
    try {
        const userId = z.string().min(1).max(200).parse(String(req.query.userId || 'dashboard'))
        const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)))
        const { getOperatorBrowserManager } = await import('../tools/operator-browser-manager.js')
        res.json(safeDashboardPayload({ replay: getOperatorBrowserManager().replay(userId, limit), status: getOperatorBrowserManager().status(userId) }))
    } catch (error) { res.status(400).json({ error: String(error) }) }
})

let benchmarkRunning = false
app.get('/api/trust/benchmarks/reports', async (_req, res) => {
    try {
        const { listBenchmarkReports } = await import('../benchmark/benchmark-lab.js')
        res.json({ running: benchmarkRunning, reports: listBenchmarkReports(20) })
    } catch (err) { res.status(500).json({ running: benchmarkRunning, reports: [], error: String(err) }) }
})

app.post('/api/trust/benchmarks/run', async (req, res) => {
    if (benchmarkRunning) return res.status(409).json({ success: false, error: 'Benchmark already running' })
    const mode = req.body?.mode === 'full' ? 'full' : 'smoke'
    benchmarkRunning = true
    void import('../benchmark/nova-benchmark-runner.js')
        .then(({ runNovaBenchmark }) => runNovaBenchmark(mode))
        .catch(error => console.error(`[Benchmark] ${error}`))
        .finally(() => { benchmarkRunning = false })
    res.status(202).json({ success: true, mode })
})

// Sessions
app.get('/api/sessions', (req, res) => {
    res.json(loadSessions())
})

// Single session — load full messages for chat resume
app.get('/api/sessions/:id', (req, res) => {
    try {
        const sessionsDir = join(process.cwd(), '.nova-sessions')
        const filePath = join(sessionsDir, `${req.params.id}.json`)
        if (!existsSync(filePath)) {
            res.status(404).json({ error: 'Session not found' })
            return
        }

        const raw = readFileSync(filePath, 'utf-8')
        const lines = raw.split('\n').filter(l => l.trim())

        const messages: { role: string; content: string; timestamp: string; userId?: string }[] = []
        let sessionMeta: any = {}

        for (let i = 0; i < lines.length; i++) {
            try {
                const parsed = JSON.parse(lines[i])
                if (i === 0 && parsed.type === 'session_start') {
                    sessionMeta = parsed
                    continue
                }
                if (parsed.type === 'message' && parsed.content) {
                    messages.push({
                        role: parsed.role || 'user',
                        content: parsed.content,
                        timestamp: parsed.timestamp || '',
                        userId: parsed.userId,
                    })
                }
            } catch { /* skip malformed lines */ }
        }

        res.json({
            id: req.params.id,
            meta: sessionMeta,
            messages,
        })
    } catch (err) {
        res.json({ error: String(err) })
    }
})

// Resume session — load messages into active chat history
app.post('/api/sessions/:id/resume', (req, res) => {
    try {
        const sessionsDir = join(process.cwd(), '.nova-sessions')
        const filePath = join(sessionsDir, `${req.params.id}.json`)
        if (!existsSync(filePath)) {
            res.status(404).json({ error: 'Session not found' })
            return
        }

        const raw = readFileSync(filePath, 'utf-8')
        const lines = raw.split('\n').filter(l => l.trim())

        // Clear current chat and load session messages
        chatHistory.length = 0

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line)
                if (parsed.type === 'message' && parsed.content) {
                    chatHistory.push({
                        id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        role: parsed.role || 'user',
                        content: parsed.content,
                        timestamp: parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now(),
                        channel: parsed.channel || 'resumed',
                    })
                }
            } catch { /* skip */ }
        }

        saveChatHistory()

        // Broadcast updated chat to all connected clients
        const chatPayload = JSON.stringify({ type: 'chat_history', messages: chatHistory })
        wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(chatPayload)
        })

        res.json({ success: true, loaded: chatHistory.length })
    } catch (err) {
        res.json({ success: false, error: String(err) })
    }
})

// Errors
app.get('/api/errors', (req, res) => {
    res.json(loadErrors())
})

// Memory Browser
app.get('/api/memory', (req, res) => {
    res.json(safeDashboardPayload({
        vector: loadVectorMemory(),
        lancedb: loadLanceDBMemory(),
    }))
})

// Self-Update Proposals
app.get('/api/proposals', (req, res) => {
    res.json(loadSelfUpdateProposals())
})

app.post('/api/proposals/:id/approve', async (req, res) => {
    try {
        const { applyUpdate } = await import('../core/self-update.js')
        const result = await applyUpdate(req.params.id)
        res.json(result)
    } catch (err) {
        res.json({ success: false, message: String(err) })
    }
})

app.post('/api/proposals/:id/reject', async (req, res) => {
    try {
        const { rejectProposal } = await import('../core/self-update.js')
        const success = rejectProposal(req.params.id, req.body.reason)
        res.json({ success })
    } catch (err) {
        res.json({ success: false, message: String(err) })
    }
})

// Config
app.get('/api/config', (req, res) => {
    const config = loadConfig()
    // Dashboard is localhost-only, no need to mask tokens
    res.json(config)
})

// Models — capability probe results + perf summary
app.get('/api/models', async (req, res) => {
    try {
        const forceProbe = req.query.probe === '1'
        const { probeAllModels, getOnlineModels, getProbeStatusSummary } = await import('../llm/capability-probe.js')
        const { getPerfSummary, getDisabledModels } = await import('../llm/model-perf-db.js')

        if (forceProbe) {
            // run in background — respond immediately with current cache
            probeAllModels(true).catch(() => { })
        }

        const probeResults = getOnlineModels()
        res.json({
            probeResults,
            probeSummary: getProbeStatusSummary(),
            perfSummary: getPerfSummary(),
            disabledModels: getDisabledModels(),
        })
    } catch (err) {
        res.json({ probeResults: [], probeSummary: '', perfSummary: '', disabledModels: [], error: String(err) })
    }
})

// Node LLM topology — per-node model overview
app.get('/api/nodes/topology', async (req, res) => {
    try {
        const { discoverNodes, getLocalNodeId } = await import('../mesh/mesh-registry.js')
        const { getLastScanResult } = await import('../mesh/ai-scanner.js')
        const { detectHardwareTier, hardwareFromMeshNode, DEPRECATED_MODELS } = await import('../mesh/model-recommender.js')

        const meshNodes = await discoverNodes()
        const localId = getLocalNodeId()
        const scanResult = getLastScanResult()

        // Group scan models by sourceNode
        const modelsByNode = new Map<string, string[]>()
        if (scanResult) {
            for (const svc of scanResult.services) {
                if (svc.type === 'llm' && svc.models.length > 0) {
                    const node = svc.sourceNode || 'local'
                    const existing = modelsByNode.get(node) || []
                    for (const m of svc.models) {
                        if (!existing.includes(m)) existing.push(m)
                    }
                    modelsByNode.set(node, existing)
                }
            }
        }

        const topology = meshNodes.map(n => {
            const label = n.hostname || n.node_id
            const fromScan = modelsByNode.get(label) || modelsByNode.get(n.ip || '') || []
            const fromRegistry = n.software?.ollama_models || []
            const models = [...new Set([...fromScan, ...fromRegistry])]
            const hwProfile = hardwareFromMeshNode(n)
            const deprecated = models.filter(m =>
                DEPRECATED_MODELS.some(dep => m === dep || m.startsWith(dep) || m.startsWith(dep + ':'))
            )
            return {
                nodeId: n.node_id,
                name: label,
                isLocal: n.node_id === localId,
                status: n.status,
                ip: n.ip,
                tier: hwProfile.ramGb > 0 ? detectHardwareTier(hwProfile) : 'unknown',
                hardware: n.hardware ? {
                    ramGb: n.hardware.ram_gb,
                    vramGb: n.hardware.gpu_vram_mb ? Math.round(n.hardware.gpu_vram_mb / 1024) : undefined,
                    gpu: n.hardware.gpu,
                    cores: n.hardware.cores,
                } : undefined,
                models,
                deprecatedModels: deprecated,
                lastHeartbeat: n.last_heartbeat,
            }
        })

        res.json({
            topology,
            totalModels: topology.reduce((acc, n) => acc + n.models.length, 0),
            onlineNodes: topology.filter(n => n.status !== 'offline').length,
            lastScan: scanResult?.lastScan,
        })
    } catch (err) {
        res.json({ topology: [], totalModels: 0, onlineNodes: 0, error: String(err) })
    }
})

// Model recommendations for a specific node
app.get('/api/nodes/recommend/:name', async (req, res) => {
    try {
        const { discoverNodes, getLocalNodeId } = await import('../mesh/mesh-registry.js')
        const { getLastScanResult } = await import('../mesh/ai-scanner.js')
        const { getRecommendations, hardwareFromMeshNode } = await import('../mesh/model-recommender.js')

        const nodes = await discoverNodes()
        const localId = getLocalNodeId()
        const targetName = req.params.name

        const node = targetName === 'local'
            ? nodes.find(n => n.node_id === localId)
            : nodes.find(n =>
                n.hostname.toLowerCase() === targetName.toLowerCase() ||
                n.node_id === targetName
            )

        if (!node) {
            res.status(404).json({ error: `Node "${targetName}" not found` })
            return
        }

        const scanResult = getLastScanResult()
        const label = node.hostname || node.node_id
        const installedModels: string[] = []
        if (scanResult) {
            for (const svc of scanResult.services) {
                if ((svc.sourceNode === label || svc.sourceNode === node.ip) && svc.type === 'llm') {
                    installedModels.push(...svc.models)
                }
            }
        }
        const fromRegistry = node.software?.ollama_models || []
        const allInstalled = [...new Set([...installedModels, ...fromRegistry])]

        const hwProfile = hardwareFromMeshNode(node)
        const result = getRecommendations(label, hwProfile, allInstalled)
        res.json(result)
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// Message Queue stats
app.get('/api/queue', async (req, res) => {
    try {
        const { getQueueStats } = await import('../channels/message-queue.js')
        const { getDisabledModels } = await import('../llm/model-perf-db.js')
        const stats = getQueueStats()
        const disabled = getDisabledModels()
        res.json({ ...stats, disabledModels: disabled.length })
    } catch (err) {
        res.json({ total: 0, pending: 0, done: 0, failed: 0, disabledModels: 0 })
    }
})

// Doctor — run self-diagnostics
app.post('/api/doctor', async (req, res) => {
    try {
        const { runSelfDoctor } = await import('../core/self-doctor.js')
        const result = await runSelfDoctor()
        res.json(result)
    } catch (err) {
        res.json({ healthy: false, summary: String(err), findings: [], generated: 0, open: 0 })
    }
})

// Doctor — get cached findings (GET)
app.get('/api/doctor', async (req, res) => {
    try {
        const { getDoctorFindings } = await import('../core/self-doctor.js')
        const findings = getDoctorFindings({ limit: 20 })
        res.json({ findings })
    } catch (err) {
        res.json({ findings: [] })
    }
})

// Task Tracker
app.get('/api/tasks', (req, res) => {
    try {
        const trackerFile = join(process.cwd(), '.nova-data', 'task-tracker.json')
        if (existsSync(trackerFile)) {
            const data = JSON.parse(readFileSync(trackerFile, 'utf-8'))
            res.json(data)
        } else {
            res.json({ current: null, history: [] })
        }
    } catch {
        res.json({ current: null, history: [] })
    }
})

// Log Viewer
app.get('/api/logs', (req, res) => {
    try {
        const count = parseInt(req.query.count as string) || 100

        // Primary: Read from live session logs
        const sessionDir = join(process.cwd(), '.nova-data', 'sessions')
        if (existsSync(sessionDir)) {
            const files = readdirSync(sessionDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({
                    name: f,
                    path: join(sessionDir, f),
                    mtime: statSync(join(sessionDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mtime - a.mtime)

            if (files.length > 0) {
                const allEntries: Array<{ ts: string; channel: string; role: string; content: string }> = []
                for (const file of files.slice(0, 5)) {
                    const lines = readFileSync(file.path, 'utf-8').split('\n').filter((l: string) => l.trim())
                    for (const line of lines.slice(-count)) {
                        try { allEntries.push(JSON.parse(line)) } catch { /* skip */ }
                    }
                }
                allEntries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
                const formatted = allEntries.slice(-Math.min(count, 500)).map(e => {
                    const time = new Date(e.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    const icon = e.role === 'user' ? '👤' : '🤖'
                    const text = e.content.length > 200 ? e.content.slice(0, 197) + '...' : e.content
                    return `[${time}] [${e.channel}] ${icon} ${text}`
                })
                res.json({ lines: formatted })
                return
            }
        }

        // Fallback: nova.log
        const logFile = join(process.cwd(), 'nova.log')
        if (existsSync(logFile)) {
            const content = readFileSync(logFile, 'utf-8')
            const lines = content.split('\n').filter((l: string) => l.trim())
            res.json({ lines: lines.slice(-Math.min(count, 500)) })
        } else {
            res.json({ lines: ['Keine Logs gefunden.'] })
        }
    } catch (err) {
        res.json({ lines: [`Error: ${err}`] })
    }
})

app.post('/api/config', (req, res) => {
    const currentConfig = loadConfig()
    const newConfig = { ...currentConfig }

    // Allow updating top-level config fields
    const allowedFields = [
        'provider', 'model', 'internalModel', 'personality',
        'voiceEnabled', 'dashboardPort',
    ]
    for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
            (newConfig as any)[field] = req.body[field]
        }
    }

    // Deep-merge channels config (don't wipe existing token when only changing enabled)
    if (req.body.channels) {
        newConfig.channels = newConfig.channels || {}
        for (const [channelName, channelUpdate] of Object.entries(req.body.channels)) {
            const existing = (newConfig.channels as any)[channelName] || {}
                ; (newConfig.channels as any)[channelName] = { ...existing, ...(channelUpdate as object) }
        }
    }

    const success = saveConfig(newConfig)
    res.json({ success })
})

// Tools
app.get('/api/tools', (req, res) => {
    res.json(loadTools())
})

// Layers
app.get('/api/layers', (req, res) => {
    res.json(loadLayers())
})

// NOTE: Core Facts and Cold Storage endpoints moved below (lines 842+)
// to use direct file reads with correct field naming

// Session Summaries (Tier 2)
app.get('/api/summaries', async (req, res) => {
    try {
        const summariesDir = join(process.cwd(), '.nova-data', 'summaries')
        if (existsSync(summariesDir)) {
            const files = readdirSync(summariesDir).filter(f => f.endsWith('.json'))
            const summaries = files.map(f => {
                try {
                    const data = JSON.parse(readFileSync(join(summariesDir, f), 'utf-8'))
                    return { file: f, ...data }
                } catch { return { file: f, error: true } }
            })
            res.json({ summaries })
        } else {
            // Count available sessions
            const sessionsDir = join(process.cwd(), '.nova-sessions')
            const sessionCount = existsSync(sessionsDir)
                ? readdirSync(sessionsDir).filter(f => f.endsWith('.json')).length
                : 0
            res.json({
                summaries: [],
                note: `Noch keine Summaries. ${sessionCount} Sessions vorhanden — klicke "Jetzt zusammenfassen" um Summaries zu generieren.`,
            })
        }
    } catch (err) {
        res.json({ summaries: [], error: String(err) })
    }
})

// Generate summaries from existing sessions
app.post('/api/summaries/generate', async (req, res) => {
    try {
        const sessionsDir = join(process.cwd(), '.nova-sessions')
        if (!existsSync(sessionsDir)) {
            res.json({ generated: 0, error: 'No sessions directory found' })
            return
        }

        const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
        let generated = 0

        for (const f of files) {
            try {
                const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'))
                const messages = data.messages || []
                if (messages.length < 5) continue // Not enough messages

                const { processSessionForLLM } = await import('../layers/L6-session-summary.js')
                const userId = data.userId || f.replace('.json', '')
                const channel = data.channel || 'unknown'
                const history = messages.map((m: any) => ({
                    role: m.role || 'user',
                    content: m.content || '',
                }))

                await processSessionForLLM(userId, channel, history)
                generated++
                console.log(`[Dashboard] Generated summary for ${userId} (${messages.length} msgs)`)
            } catch (err) {
                console.log(`[Dashboard] Summary generation failed for ${f}: ${err}`)
            }
        }

        res.json({ generated, total: files.length })
    } catch (err) {
        res.json({ generated: 0, error: String(err) })
    }
})

// Knowledge Graph (GraphRAG)
app.get('/api/graph', async (req, res) => {
    try {
        const { getFullGraph, getStats } = await import('../memory/knowledge-graph.js')
        const graph = getFullGraph()
        const stats = getStats()
        res.json({ ...graph, stats })
    } catch (err) {
        res.json({ nodes: [], edges: [], error: String(err) })
    }
})

// Journal
app.get('/api/journal', async (req, res) => {
    try {
        const { getRecentEntries, getStats } = await import('../memory/journal.js')
        const entries = getRecentEntries(7)
        const stats = getStats()
        res.json({ entries, stats })
    } catch (err) {
        res.json({ entries: [], error: String(err) })
    }
})

// Watchdog
app.get('/api/watchdog', async (req, res) => {
    // Simple health check - watchdog is separate process
    try {
        const watchdogLogFile = join(process.cwd(), '.nova-data', 'watchdog.log')
        if (existsSync(watchdogLogFile)) {
            const log = readFileSync(watchdogLogFile, 'utf-8')
            const lines = log.split('\n').slice(-10)
            const hasErrors = lines.some(l => l.includes('ERROR'))
            res.json({
                healthy: !hasErrors,
                lastLines: lines,
                issues: hasErrors ? ['Recent errors in watchdog log'] : []
            })
        } else {
            res.json({ healthy: true, issues: [], message: 'Watchdog log not found' })
        }
    } catch (err) {
        res.json({ healthy: false, issues: [String(err)] })
    }
})

// ============================================
// Mesh Network API
// ============================================

app.get('/api/mesh/nodes', async (req, res) => {
    try {
        const { discoverNodes } = await import('../mesh/mesh-registry.js')
        const includeHistorical = req.query.all === '1' || req.query.all === 'true'
        const nodes = await discoverNodes({ includeHistorical })
        res.json({ nodes })
    } catch (err) {
        res.json({ nodes: [], error: String(err) })
    }
})

app.get('/api/mesh/services', async (_req, res) => {
    try {
        const { formatMeshServices } = await import('../mesh/mesh-registry.js')
        res.json({ report: await formatMeshServices() })
    } catch (err) {
        res.status(500).json({ report: '', error: String(err) })
    }
})

app.get('/api/mesh/tasks', async (req, res) => {
    try {
        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))
        const supabaseUrl = config.supabase?.meshUrl || process.env.NOVA_MESH_SUPABASE_URL || ''
        const supabaseKey = config.supabase?.meshKey || process.env.NOVA_MESH_SUPABASE_KEY || ''
        if (!supabaseUrl || !supabaseKey) return res.status(503).json({ tasks: [], error: 'Mesh Supabase is not configured' })

        const result = await fetch(`${supabaseUrl}/nova_mesh_tasks?order=created_at.desc&limit=50`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
            },
        })
        if (!result.ok) {
            res.json({ tasks: [], error: `Supabase ${result.status}` })
            return
        }
        const tasks = await result.json()
        res.json({ tasks })
    } catch (err) {
        res.json({ tasks: [], error: String(err) })
    }
})

app.post('/api/mesh/delegate', async (req, res) => {
    try {
        const { targetNode, task } = req.body
        if (!targetNode || !task) {
            res.status(400).json({ error: 'targetNode and task required' })
            return
        }
        const { delegateTask } = await import('../mesh/mesh-registry.js')
        const delegation = await delegateTask(targetNode, task)
        if (delegation) {
            res.json({ success: true, taskId: delegation.id })
        } else {
            res.json({ success: false, error: 'Task delegation failed' })
        }
    } catch (err) {
        res.json({ success: false, error: String(err) })
    }
})

app.get('/api/mesh/tasks/:id', async (req, res) => {
    try {
        const { getTaskResult } = await import('../mesh/mesh-registry.js')
        const task = await getTaskResult(req.params.id)
        if (task) {
            res.json(task)
        } else {
            res.status(404).json({ error: 'Task not found' })
        }
    } catch (err) {
        res.json({ error: String(err) })
    }
})

// Mesh: Serve update bundle (tar.gz of dist/ + public/)
app.get('/api/mesh/bundle', async (req, res) => {
    try {
        const { execSync } = await import('child_process')
        const { join } = await import('path')
        const { readFileSync, unlinkSync } = await import('fs')
        const { tmpdir } = await import('os')

        // Resolve project root (where dist/ and src/ live)
        const baseDir = join(import.meta.dirname || __dirname, '..', '..')
        const tmpFile = join(tmpdir(), `nova-bundle-${Date.now()}.tar.gz`)

        // Build list of files that exist
        const files = ['dist', 'src/dashboard/public', 'package.json']
        // Runtime configuration may contain credentials. It never belongs in a
        // distributable bundle, under either the current or legacy filename.

        execSync(
            `tar czf "${tmpFile}" ${files.join(' ')}`,
            { cwd: baseDir, timeout: 30_000 }
        )

        const data = readFileSync(tmpFile)
        res.setHeader('Content-Type', 'application/gzip')
        res.setHeader('Content-Disposition', 'attachment; filename="nova-bundle.tar.gz"')
        res.setHeader('Content-Length', data.length)
        res.send(data)

        // Cleanup
        try { unlinkSync(tmpFile) } catch { }
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// Mesh: Trigger self-update on a remote node
app.post('/api/mesh/update-node', async (req, res) => {
    try {
        const { targetNode } = req.body
        if (!targetNode) {
            return res.status(400).json({ error: 'targetNode required' })
        }

        // Get the dashboard URL this request came from
        const sourceHost = req.headers.host?.split(':')[0] || req.socket.localAddress || '100.64.0.10'
        const sourcePort = '3001'
        const bundleUrl = `http://${sourceHost}:${sourcePort}/api/mesh/bundle`

        // Send a shell task to the node: download bundle, extract, restart
        const { delegateTask } = await import('../mesh/mesh-registry.js')
        const updateCmd = `cd ~/nova-core && curl -sL "${bundleUrl}" -o /tmp/nova-bundle.tar.gz && tar xzf /tmp/nova-bundle.tar.gz --overwrite && rm /tmp/nova-bundle.tar.gz && echo "UPDATE_OK: $(date)" && (killall -q node; sleep 2; cd ~/nova-core && nohup node dist/daemon.js > nova.log 2>&1 &)`

        const task = await delegateTask(targetNode, updateCmd)
        if (task) {
            res.json({ success: true, taskId: task.id, bundleUrl })
        } else {
            res.json({ success: false, error: 'Task delegation failed' })
        }
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// ============================================
// Mesh: Model Discovery & Switch API
// ============================================

// GET /api/mesh/models — all probe-discovered models + current active model
app.get('/api/mesh/models', async (req, res) => {
    try {
        const { availableLLMs } = await import('../core/llm-factory.js')
        // Try to get active model from the global llm wrapper
        let activeModel = 'unknown'
        let activeProvider = 'unknown'
        try {
            const daemon = (globalThis as any).__novaState
            if (daemon?.llm) {
                activeModel = daemon.llm.modelId || 'unknown'
                activeProvider = daemon.llm.provider || 'unknown'
            }
        } catch { /* daemon not available */ }

        const models = availableLLMs.map(l => ({
            id: l.model,
            provider: l.provider,
            local: l.local,
            active: l.model === activeModel,
        }))
        res.json({ models, activeModel, activeProvider, total: models.length })
    } catch (err) {
        res.json({ models: [], activeModel: 'unknown', error: String(err) })
    }
})

// POST /api/mesh/switch-model — switch the active model on this node
app.post('/api/mesh/switch-model', async (req, res) => {
    try {
        const { model, provider } = req.body
        if (!model) {
            return res.status(400).json({ error: 'model required' })
        }
        const daemon = (globalThis as any).__novaDaemon
        if (!daemon?.llm?.switchModel) {
            return res.status(503).json({ error: 'LLM not initialized yet' })
        }
        const success = await daemon.llm.switchModel(model, provider)
        res.json({ success, model, provider: daemon.llm.provider })
    } catch (err) {
        res.json({ success: false, error: String(err) })
    }
})

// ============================================
// Sandbox — Code Execution (almostnode-inspired)
// ============================================

app.post('/api/sandbox/run', async (_req, res) => {
    res.status(410).json({ error: 'Dashboard sandbox is disabled.' })
})

/*
app.post('/api/sandbox/run', async (req, res) => {
    const { code, lang } = req.body
    if (!code) {
        res.status(400).json({ error: 'No code provided' })
        return
    }

    const startTime = Date.now()

    try {
        const { execSync } = await import('child_process')
        const { tmpdir } = await import('os')
        const { writeFileSync, unlinkSync } = await import('fs')
        const tempFile = join(tmpdir(), `nova-sandbox-${Date.now()}.${lang === 'typescript' ? 'mts' : lang === 'shell' ? 'sh' : 'mjs'}`)

        // Wrap JS/TS code to capture console output
        let execCode = code
        if (lang === 'javascript' || lang === 'typescript') {
            execCode = `
const __logs = []
const __origLog = console.log
console.log = (...args) => { __logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')); __origLog(...args) }
console.error = console.log
console.warn = console.log
console.info = console.log
;(async () => {
${code}
})().then(() => {
    // noop — output already printed
}).catch(err => {
    console.log('❌ Error:', err.message || err)
    process.exit(1)
})`
        }

        writeFileSync(tempFile, execCode)

        let stdout = ''
        let stderr = ''

        try {
            if (lang === 'shell') {
                stdout = execSync(`bash "${tempFile}"`, {
                    timeout: 5000,
                    encoding: 'utf-8',
                    cwd: process.cwd(),
                })
            } else {
                stdout = execSync(`node --experimental-vm-modules "${tempFile}"`, {
                    timeout: 5000,
                    encoding: 'utf-8',
                    cwd: process.cwd(),
                    env: { ...process.env, NODE_NO_WARNINGS: '1' },
                })
            }
        } catch (err: any) {
            stdout = err.stdout || ''
            stderr = err.stderr || err.message || 'Execution failed'
        }

        try { unlinkSync(tempFile) } catch { }

        res.json({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            durationMs: Date.now() - startTime,
        })
    } catch (err: any) {
        res.json({
            error: err.message || String(err),
            durationMs: Date.now() - startTime,
        })
    }
})
*/

// ============================================
// ROI Dashboard API
// ============================================

app.get('/api/roi', async (req, res) => {
    try {
        const roiFile = join(process.cwd(), '.nova-data', 'roi-dashboard.json')
        if (existsSync(roiFile)) {
            const data = JSON.parse(readFileSync(roiFile, 'utf-8'))
            res.json(data)
        } else {
            // No ROI data file yet — return defaults
            try {
                const { getROIDashboard } = await import('../intelligence/roi-dashboard.js')
                // getROIDashboard returns a formatted string, not JSON
                res.json({
                    totalCost: 0,
                    totalValue: 0,
                    totalTasks: 0,
                    daily: {},
                    recentTasks: [],
                    summary: getROIDashboard(),
                })
            } catch {
                res.json({
                    totalCost: 0,
                    totalValue: 0,
                    totalTasks: 0,
                    daily: {},
                    recentTasks: [],
                })
            }
        }
    } catch (err) {
        res.json({ totalCost: 0, totalValue: 0, error: String(err) })
    }
})

// POST /api/mesh/login-init — configure OpenAI API key
app.post('/api/mesh/login-init', async (_req, res) => {
    try {
        res.json({
            method: 'api_key',
            message: 'Öffne platform.openai.com/api-keys und erstelle einen API Key. Gib ihn dann hier ein.',
        })
    } catch (err) {
        res.json({ error: String(err) })
    }
})

// POST /api/mesh/login-callback
app.post('/api/mesh/login-callback', async (req, res) => {
    try {
        const { code } = req.body
        if (!code) {
            return res.status(400).json({ error: 'Authorization code required' })
        }

        // Store the API key
        const { getOAuthManager } = await import('../auth/oauth.js')
        const oauth = getOAuthManager()
        oauth.setApiKey('openai', 'openai', code)

        const tokenData = { access_token: code } as {
            access_token?: string
            refresh_token?: string
            expires_in?: number
            error?: string
            error_description?: string
        }
        if (tokenData.error) {
            return res.json({ success: false, error: tokenData.error_description || tokenData.error })
        }

        // Save tokens to .nova-data/auth.json
        const authDir = join(process.cwd(), '.nova-data')
        const authPath = join(authDir, 'auth.json')
        if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true })

        let authData: Record<string, unknown> = {}
        if (existsSync(authPath)) {
            try { authData = JSON.parse(readFileSync(authPath, 'utf-8')) } catch { /* fresh */ }
        }

        authData['local'] = {
            access: tokenData.access_token,
            refresh: tokenData.refresh_token,
            expires: Date.now() + ((tokenData.expires_in || 3600) * 1000),
        }
        writeFileSync(authPath, JSON.stringify(authData, null, 2), 'utf-8')

        res.json({
            success: true,
            message: 'Auth tokens saved! Nova kann jetzt Cloud-Models nutzen. Restart empfohlen.',
        })
    } catch (err) {
        res.json({ success: false, error: String(err) })
    }
})

// GET /api/mesh/auth-status — check if auth tokens exist and are valid
app.get('/api/mesh/auth-status', async (_req, res) => {
    try {
        const authPath = join(process.cwd(), '.nova-data', 'auth.json')
        if (!existsSync(authPath)) {
            return res.json({ authenticated: false, message: 'Keine Auth-Tokens gefunden' })
        }
        const authData = JSON.parse(readFileSync(authPath, 'utf-8'))
        const tokens = authData['local']
        if (!tokens?.access) {
            return res.json({ authenticated: false, message: 'Kein OpenAI Token' })
        }
        const expiresIn = Math.max(0, Math.round(((tokens.expires || 0) - Date.now()) / 1000))
        res.json({
            authenticated: true,
            expiresIn,
            expired: expiresIn <= 0,
            hasRefresh: !!tokens.refresh,
        })
    } catch (err) {
        res.json({ authenticated: false, error: String(err) })
    }
})

// ============================================
// LanceDB Memory API
// ============================================

app.get('/api/memory/stats', async (req, res) => {
    try {
        const lancedb = (await import('../memory/lancedb-memory.js')).default
        const stats = await lancedb.getStats()
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        res.json({ ...stats, governance: getMemoryGovernanceCoordinator().getStats() })
    } catch (err) {
        res.json({ initialized: false, totalEntries: 0, error: String(err) })
    }
})

app.get('/api/memory/governance', async (req, res) => {
    try {
        const status = req.query.status ? z.enum(['candidate', 'verified', 'canonical', 'superseded', 'rejected', 'expired']).parse(String(req.query.status)) : undefined
        const scope = req.query.scope ? z.string().min(1).max(300).parse(String(req.query.scope)) : undefined
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        res.json(safeDashboardPayload({ records: getMemoryGovernanceCoordinator().list({ status, scope }) }))
    } catch (error) { res.status(400).json({ error: String(error) }) }
})

app.post('/api/memory/governance/:id/:action', async (req, res) => {
    try {
        const id = z.string().regex(/^mem_[a-zA-Z0-9-]+$/).parse(req.params.id)
        const action = z.enum(['approve', 'reject', 'correct']).parse(req.params.action)
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        const current = governance.list().find(record => record.id === id)
        if (!current) return void res.status(404).json({ success: false, error: 'Memory record not found' })
        if (action === 'approve') {
            const approved = governance.approve(id, 'trust-dashboard')
            return void res.json({ success: true, record: approved ? await governance.publish(approved.id) : null })
        }
        if (action === 'reject') return void res.json({ success: true, record: await governance.rejectAndRetract(id, 'trust-dashboard') })
        const input = z.object({ content: z.string().min(3).max(20_000) }).parse(req.body)
        const replacement = await governance.record({
            content: input.content, kind: current.kind, scope: current.scope, source: 'trust-dashboard', evidence: 'correction', confidence: 1,
            verified: true, subject: current.subject, predicate: current.predicate, value: current.value, replacesContent: current.content,
        })
        res.json({ success: true, record: replacement })
    } catch (error) { res.status(400).json({ success: false, error: String(error) }) }
})

app.post('/api/memory/evaluate', async (req, res) => {
    try {
        const schema = z.array(z.object({
            id: z.string().min(1).max(100), scope: z.string().min(1).max(300), query: z.string().min(1).max(2_000),
            expectedIds: z.array(z.string()).max(100), forbiddenIds: z.array(z.string()).max(100).optional(), topK: z.number().int().min(1).max(50).optional(),
        })).min(1).max(500)
        const cases = schema.parse(req.body?.cases)
        const { MemoryRetrievalEvaluator, defaultMemoryEvalReportPath } = await import('../memory/retrieval-evaluator.js')
        res.json(new MemoryRetrievalEvaluator().run(cases, defaultMemoryEvalReportPath()))
    } catch (error) { res.status(400).json({ error: String(error) }) }
})

app.get('/api/memory/search', async (req, res) => {
    try {
        const query = String(req.query.q || '')
        const limit = parseInt(String(req.query.limit || '20'))
        const lancedb = (await import('../memory/lancedb-memory.js')).default
        const results = await lancedb.recall(query || 'recent conversations', limit)
        res.json(safeDashboardPayload({ results: results.map(r => ({ ...r.entry, score: r.score })) }))
    } catch (err) {
        res.json({ results: [], error: String(err) })
    }
})

app.delete('/api/memory/:id', async (req, res) => {
    try {
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        const governed = governance.list().find(record => record.backends.lancedbId === req.params.id)
        if (governed) governance.reject(governed.id, 'dashboard-delete')
        const lancedb = (await import('../memory/lancedb-memory.js')).default
        const deleted = await lancedb.forget(req.params.id)
        res.json({ deleted })
    } catch (err) {
        res.json({ deleted: false, error: String(err) })
    }
})

app.post('/api/memory', async (req, res) => {
    try {
        const { content, type, source, scope } = req.body
        if (!content) {
            res.status(400).json({ error: 'content required' })
            return
        }
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const kind = type === 'learning' ? 'learning' : type === 'conversation' ? 'context' : 'fact'
        const record = await getMemoryGovernanceCoordinator().record({
            content: String(content), kind, scope: String(scope || 'global'),
            source: String(source || 'dashboard'), evidence: 'manual', confidence: 1, verified: true,
        })
        res.json({ id: record?.backends.lancedbId, governanceId: record?.id, lifecycle: record?.status, stored: !!record })
    } catch (err) {
        res.json({ stored: false, error: String(err) })
    }
})

// ============================================
// Scheduler API (Cron Jobs)
// ============================================

app.get('/api/scheduler', async (req, res) => {
    try {
        const { getScheduler } = await import('../scheduler/nova-scheduler.js')
        const scheduler = getScheduler()
        res.json({ jobs: scheduler.listJobs() })
    } catch (err) {
        res.json({ jobs: [], error: String(err) })
    }
})

app.post('/api/scheduler', async (req, res) => {
    try {
        const { action, cron, userId } = req.body
        if (!action || !cron) {
            res.status(400).json({ error: 'action and cron required' })
            return
        }
        const { getPatternStore } = await import('../learning/pattern-store.js')
        const store = getPatternStore()
        const patternId = `dashboard:dashboard:${action}:${cron}`
        store.enableAutomation(patternId, cron)

        // Also record the action so the pattern exists
        store.recordAction(userId || 'dashboard', 'dashboard', action)
        store.enableAutomation(patternId, cron)

        const { getScheduler } = await import('../scheduler/nova-scheduler.js')
        const scheduler = getScheduler()
        const pattern = {
            id: patternId,
            userId: userId || 'dashboard',
            channel: 'dashboard',
            action,
            timeHint: undefined,
            count: 1,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            automated: true,
            cronExpression: cron,
        }
        scheduler.schedulePattern(pattern)

        res.json({ success: true, id: pattern.id })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

app.delete('/api/scheduler/:id', async (req, res) => {
    try {
        const { getScheduler } = await import('../scheduler/nova-scheduler.js')
        const scheduler = getScheduler()
        const cancelled = scheduler.cancelJob(req.params.id)
        res.json({ success: cancelled })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// ============================================
// Task Manager API — live state
// ============================================

app.get('/api/tasks', (req, res) => {
    // Load user-created tasks from storage
    const tasksFile = join(DATA_DIR, 'tasks.json')
    let userTasks: any[] = []
    if (existsSync(tasksFile)) {
        try {
            userTasks = JSON.parse(readFileSync(tasksFile, 'utf-8'))
        } catch { /* ignore */ }
    }

    res.json({
        nova: state.nova,
        thoughts: state.thoughts.slice(0, 10),
        errors: state.errors.slice(0, 5),
        stats: state.stats,
        tasks: userTasks,
    })
})

app.post('/api/tasks', (req, res) => {
    try {
        const { name, description, priority } = req.body
        if (!name) {
            res.status(400).json({ error: 'name required' })
            return
        }

        const tasksFile = join(DATA_DIR, 'tasks.json')
        let tasks: any[] = []
        if (existsSync(tasksFile)) {
            try {
                tasks = JSON.parse(readFileSync(tasksFile, 'utf-8'))
            } catch { /* ignore */ }
        }

        const task = {
            id: `task-${Date.now()}`,
            name,
            description: description || '',
            priority: priority || 'normal',
            status: 'pending',
            createdAt: Date.now(),
        }
        tasks.push(task)
        writeFileSync(tasksFile, JSON.stringify(tasks, null, 2))

        res.json({ success: true, task })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// ============================================
// Core Facts API (Tier 0 — Never Forget)
// ============================================

const CORE_FACTS_PATH = join(DATA_DIR, 'CORE_FACTS.json')

app.get('/api/core-facts', async (req, res) => {
    try {
        const { initCoreFacts, getAllFacts } = await import('../layers/L6-core-facts.js')
        initCoreFacts()
        const facts = getAllFacts()
        res.json({ facts })
    } catch (err) {
        res.json({ facts: [], error: String(err) })
    }
})

app.post('/api/core-facts', (req, res) => {
    void (async () => { try {
        const { fact, category, priority } = req.body
        if (!fact) {
            res.status(400).json({ error: 'fact required' })
            return
        }

        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const record = await getMemoryGovernanceCoordinator().record({
            content: String(fact),
            kind: category === 'identity' ? 'identity' : category === 'preference' ? 'preference'
                : category === 'project' ? 'project' : 'fact',
            scope: 'global', source: 'dashboard:core-facts', evidence: 'manual', confidence: 1, verified: true,
        })
        res.json({ success: Boolean(record), fact: record, priority: priority || 'normal' })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    } })()
})

app.delete('/api/core-facts/:id', async (req, res) => {
    try {
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        const record = governance.get(req.params.id)
            || governance.list().find(item => item.backends.coreFact && item.content === req.params.id)
        const rejected = record ? await governance.rejectAndRetract(record.id, 'dashboard:core-facts') : null
        res.json({ success: Boolean(rejected), remaining: governance.getStats().canonical })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// ============================================
// Cold Storage API (USER.md + MEMORY.md)
// ============================================

app.get('/api/cold-storage', (req, res) => {
    try {
        const userMdPath = join(DATA_DIR, 'USER.md')
        const memoryMdPath = join(DATA_DIR, 'MEMORY.md')

        const userMd = existsSync(userMdPath) ? readFileSync(userMdPath, 'utf-8') : ''
        const memoryMd = existsSync(memoryMdPath) ? readFileSync(memoryMdPath, 'utf-8') : ''

        res.json({ user: userMd, memory: memoryMd })
    } catch (err) {
        res.json({ user: '', memory: '', error: String(err) })
    }
})

app.put('/api/cold-storage/:type', (req, res) => {
    try {
        const { type } = req.params
        const { content } = req.body

        if (type !== 'user' && type !== 'memory') {
            res.status(400).json({ error: 'type must be user or memory' })
            return
        }

        const filePath = join(DATA_DIR, type === 'user' ? 'USER.md' : 'MEMORY.md')
        writeFileSync(filePath, content || '', 'utf-8')

        res.json({ success: true, bytes: (content || '').length })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// ============================================
// GraphRAG Management API
// ============================================

const GRAPH_PATH = join(DATA_DIR, 'knowledge-graph.json')

app.delete('/api/graph/reset', (req, res) => {
    try {
        const emptyGraph = { nodes: [], edges: [], version: 1, lastUpdated: Date.now() }
        writeFileSync(GRAPH_PATH, JSON.stringify(emptyGraph, null, 2))
        res.json({ success: true, message: 'Graph reset to empty' })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

app.delete('/api/graph/node/:id', (req, res) => {
    try {
        if (!existsSync(GRAPH_PATH)) {
            res.json({ success: false, error: 'Graph not found' })
            return
        }
        const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'))
        const nodeId = req.params.id
        graph.nodes = graph.nodes.filter((n: any) => n.id !== nodeId)
        graph.edges = graph.edges.filter((e: any) => e.source !== nodeId && e.target !== nodeId)
        graph.lastUpdated = Date.now()
        writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2))
        res.json({ success: true, nodes: graph.nodes.length, edges: graph.edges.length })
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// ============================================
// Chat Session History API
// ============================================

app.get('/api/chat/sessions', async (req, res) => {
    try {
        const sessionsDir = join(DATA_DIR, 'sessions')
        if (!existsSync(sessionsDir)) {
            res.json({ sessions: [] })
            return
        }
        const { readdirSync, statSync } = await import('node:fs')
        const files = readdirSync(sessionsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const stat = statSync(join(sessionsDir, f))
                return {
                    id: f.replace('.json', ''),
                    filename: f,
                    date: stat.mtime.toISOString(),
                    size: stat.size,
                }
            })
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 50)
        res.json({ sessions: files })
    } catch (err) {
        res.json({ sessions: [], error: String(err) })
    }
})

app.get('/api/chat/sessions/:id', async (req, res) => {
    try {
        const sessionFile = join(DATA_DIR, 'sessions', `${req.params.id}.json`)
        if (!existsSync(sessionFile)) {
            res.status(404).json({ error: 'Session not found' })
            return
        }
        const content = readFileSync(sessionFile, 'utf-8')
        res.json(JSON.parse(content))
    } catch (err) {
        res.status(500).json({ error: String(err) })
    }
})

// NOTE: PUT /api/core-facts and PUT /api/cold-storage/:type
// are now handled above (lines ~908-925) with correct paths

// Chat History
app.get('/api/chat', (req, res) => {
    res.json(chatHistory.slice(-100))
})

// ============================================
// WebSocket
// ============================================

const clients: Set<WebSocket> = new Set()

// Message handler for chat
let novaMessageHandler: ((message: string, channel: string) => Promise<string>) | null = null

export function setNovaMessageHandler(handler: (message: string, channel: string) => Promise<string>): void {
    novaMessageHandler = handler
}

const { registerDesktopApi } = await import('../desktop/desktop-api.js')
registerDesktopApi(app, () => novaMessageHandler)

wss.on('connection', (ws) => {
    clients.add(ws)
    console.log('[Dashboard] Client connected')

    // Send initial state
    ws.send(JSON.stringify({ type: 'state', data: state }))
    ws.send(JSON.stringify({ type: 'chat', data: chatHistory.slice(-50) }))

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString())

            if (msg.type === 'chat' && msg.content) {
                // User sent a chat message
                const userMessage: ChatMessage = {
                    id: `msg_${Date.now()}`,
                    role: 'user',
                    content: msg.content,
                    timestamp: Date.now(),
                    channel: 'dashboard',
                }

                chatHistory.push(userMessage)
                saveChatHistory()
                broadcast('chat_message', userMessage)

                // Process with Nova
                if (novaMessageHandler) {
                    broadcast('typing', { typing: true })

                    try {
                        const response = await novaMessageHandler(msg.content, 'dashboard')

                        const assistantMessage: ChatMessage = {
                            id: `msg_${Date.now()}`,
                            role: 'assistant',
                            content: response,
                            timestamp: Date.now(),
                            channel: 'dashboard',
                        }

                        chatHistory.push(assistantMessage)
                        saveChatHistory()
                        broadcast('chat_message', assistantMessage)
                    } catch (err) {
                        broadcast('chat_error', { error: String(err) })
                    }

                    broadcast('typing', { typing: false })
                } else {
                    broadcast('chat_error', { error: 'Nova handler not connected' })
                }
            }
        } catch (err) {
            console.error('[Dashboard] WebSocket message error:', err)
        }
    })

    ws.on('close', () => {
        clients.delete(ws)
        console.log('[Dashboard] Client disconnected')
    })
})

export function broadcast(type: string, data: any): void {
    const message = JSON.stringify({ type, data })
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message)
        }
    })
}

// ============================================
// WebSocket Heartbeat — prevents silent disconnects
// ============================================

const aliveClients = new WeakSet<WebSocket>()

setInterval(() => {
    clients.forEach(client => {
        if (!aliveClients.has(client)) {
            // Didn't respond to last ping — terminate
            console.log('[Dashboard] Terminating dead WebSocket client')
            client.terminate()
            clients.delete(client)
            return
        }
        aliveClients.delete(client)
        client.ping()
    })
}, 30_000)

// Track pong responses
wss.on('connection', (ws) => {
    aliveClients.add(ws)
    ws.on('pong', () => {
        aliveClients.add(ws)
    })
})

// ============================================
// State Update Functions
// ============================================

export function updateNovaStatus(status: DashboardState['nova']['status'], task?: string): void {
    state.nova.status = status
    if (task) state.nova.currentTask = task
    broadcast('nova', state.nova)
}

export function updateLastMessage(message: string): void {
    state.nova.lastMessage = message
    broadcast('message', { message })
}

export function addThought(content: string, type: string = 'thought'): void {
    state.thoughts.unshift({
        id: `thought_${Date.now()}`,
        content,
        timestamp: Date.now(),
        type,
    })
    state.thoughts = state.thoughts.slice(0, 50)
    broadcast('thought', state.thoughts[0])
}

export function trackTokens(tokens: number, cost: number): void {
    state.stats.tokensToday += tokens
    state.stats.tokensMonth += tokens
    state.stats.costToday += cost
    state.stats.costMonth += cost
    state.stats.requestsToday++
    state.stats.requestsMonth++
    saveStats()
    broadcast('stats', state.stats)
}

export function logError(message: string, stack?: string): void {
    const error = {
        id: `err_${Date.now()}`,
        message,
        stack,
        timestamp: Date.now(),
        resolved: false,
    }
    state.errors.unshift(error)
    state.errors = state.errors.slice(0, 50)

    // Save to file
    const errorFile = join(DATA_DIR, 'errors.json')
    try {
        writeFileSync(errorFile, JSON.stringify({ errors: state.errors }, null, 2))
    } catch { }

    broadcast('error', error)
}

// ============================================
// Start Server
// ============================================

let dashboardStarted = false
let dashboardPort = 3011
let dashboardUrl = ''

export function getDashboardAddress(): string | null { return dashboardAddress(server) }

export async function startDashboard(port: number = 3011, host: string = '127.0.0.1'): Promise<string> {
    if (dashboardStarted) return dashboardUrl
    state.stats = loadStats()
    dashboardUrl = await listenDashboard(server, port, host)
    dashboardStarted = true
    dashboardPort = Number(new URL(dashboardUrl).port)
    console.log(`\n✨ Xaventra Dashboard: ${dashboardUrl}\n`)
    return dashboardUrl
}

export async function stopDashboard(): Promise<void> {
    if (!dashboardStarted) return
    for (const client of wss.clients) client.close(1012, 'Nova mesh leadership moved')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    dashboardStarted = false
    console.log(`[Dashboard] Stopped port ${dashboardPort} after leadership loss`)
}

export default {
    startDashboard,
    stopDashboard,
    setNovaMessageHandler,
    updateNovaStatus,
    updateLastMessage,
    addThought,
    trackTokens,
    logError,
    broadcast,
}
