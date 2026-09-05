/**
 * Nova Daemon - Background Service
 * 
 * Runs all channels (Telegram, WhatsApp, Discord) and Dashboard
 * as a persistent background service.
 */

// Load .env file FIRST before anything else
import 'dotenv/config'

// Fix Windows terminal encoding for emoji/unicode output
if (process.platform === 'win32') {
    process.stdout.setEncoding?.('utf8')
    process.stderr.setEncoding?.('utf8')
    try { (await import('node:child_process')).execSync('chcp 65001', { stdio: 'ignore' }) } catch { /* non-critical */ }
}

// Install structured logger SECOND — all console.log calls get timestamps + file rotation
import { installGlobalLogger } from './core/nova-logger.js'
installGlobalLogger()

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isNovaDaemonPid } from './core/pid-guard.js'

// ============================================
// Build-freshness guard — warn if dist is stale vs src
// ============================================
;(function checkBuildFreshness() {
    try {
        const distEntry = join(process.cwd(), 'dist', 'daemon.js')
        if (!existsSync(distEntry)) {
            console.warn('[Nova] ⚠️  dist/daemon.js missing — run "npm run build" before starting')
            return
        }
        const distMtime = statSync(distEntry).mtimeMs
        const srcDir = join(process.cwd(), 'src')
        let newestSrc = 0
        const scan = (dir: string) => {
            try {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    const full = join(dir, entry.name)
                    if (entry.isDirectory()) { scan(full); continue }
                    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                        const mtime = statSync(full).mtimeMs
                        if (mtime > newestSrc) newestSrc = mtime
                    }
                }
            } catch { /* ignore unreadable dirs */ }
        }
        scan(srcDir)
        const staleSec = Math.round((newestSrc - distMtime) / 1000)
        if (staleSec > 10) {
            console.warn(`[Nova] ⚠️  dist is ${staleSec}s behind src — run "npm run build" or use "npm run dev" for live reload`)
        } else {
            console.log(`[Nova] ✅ Build is current (dist/daemon.js up to date)`)
        }
    } catch { /* non-critical */ }
})()

// Install log interceptor FIRST — captures all console.log into ring buffer for /log command
import { installLogInterceptor } from './core/task-tracker.js'
installLogInterceptor()

// ============================================
// Types
// ============================================

interface NovaConfig {
    provider: string
    model: string
    internalModel?: string
    channels: {
        telegram?: { enabled: boolean; token: string; allowFrom?: string[] }
        whatsapp?: { enabled: boolean; authPath?: string }
        discord?: { enabled: boolean; token?: string }
        cli?: { enabled: boolean }
    }
    dashboard?: { enabled: boolean; port: number; password?: string }
    runtime?: { profile?: 'home' | 'server' | 'nas' | 'worker' | 'developer'; bundles?: string[]; hotReload?: boolean; acpEnabled?: boolean }
}

// ============================================
// Daemon State
// ============================================

const state = {
    running: false,
    runtimeReady: false,
    channels: {
        telegram: null as any,
        whatsapp: null as any,
        discord: null as any,
    },
    llm: null as any,
    internalLlm: null as any,  // Local LLM for ALL autonomous layer tasks (L7, L8-meta, L9, L12, L15, L16, L17, journal, graph)
    // Layer 6 - Memory
    memory: null as any,
    // Layer 7 - Learning
    learning: null as any,
    // Layer 2 - Tools/Commands
    tools: null as any,
    // Layer 0 - Resilience
    resilience: null as any,
    startTime: Date.now(),
}

// ============================================
// LLM Factory (imported from core/llm-factory.ts)
// ============================================
import { detectAvailableLLMs, createLLM, availableLLMs, currentLLMIndex } from './core/llm-factory.js'
import type { LLMEntry } from './core/llm-factory.js'

// ============================================
// Message Pipeline (imported from core/message-pipeline.ts)
// ============================================
import { NOVA_PERSONA, logSession, handleMessage as _handleMessage, preloadPipelineModules } from './core/message-pipeline.js'
import { initMeshTransportRuntime, startMeshDataPlane, stopMeshTransportRuntime } from './mesh/mesh-transport-runtime.js'
import { initNovaState, getNovaState } from './core/nova-state.js'
import { startTrace, endTrace, runWithTrace, traceLog } from './core/request-tracer.js'
import { interactiveRequestGate } from './core/request-gate.js'
import { getMessageBus } from './core/message-bus.js'
import { setNovaConfig } from './core/config.js'
import { recordChannelMessage, recordExecutionStage, withSpan } from './infra/telemetry.js'
import { markStartupReady, startStartupPhase } from './core/startup-performance.js'

export async function handleMessage(
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
    image?: { data: string; mimeType: string }
) {
    const traceId = startTrace(channel, from, content)
    recordChannelMessage({ channel, direction: 'inbound' })
    const { getStateMachine } = await import('./core/state-machine.js')
    const runtimeState = getStateMachine()
    if (runtimeState.isIdle()) runtimeState.startThinking(`message:${channel}`)
    getMessageBus().emitSync('user:message', { channel, userId: from, content, hasImage: Boolean(image) }, { source: 'daemon', correlationId: traceId })
    try {
        const priority = channel === 'internal' || from === 'Nova-Autonomy' ? -10 : 10
        return await withSpan('nova.channel.message', {
            'nova.trace.id': traceId,
            'nova.channel': channel,
            'nova.has_image': Boolean(image),
            'nova.system_authored': channel === 'internal' || from === 'Nova-Autonomy',
        }, async () => interactiveRequestGate.run(() => runWithTrace(traceId, async () => {
                traceLog(traceId, 'pipeline:start')
                recordExecutionStage({ stage: 'pipeline.started', success: true })
                const observedReply = async (message: string): Promise<void> => {
                    try {
                        await replyFn(message)
                        recordChannelMessage({ channel, direction: 'outbound', success: true })
                    } catch (error) {
                        recordChannelMessage({ channel, direction: 'outbound', success: false })
                        throw error
                    }
                }
                const result = await _handleMessage(channel, from, content, observedReply, state as any, handleCommand, image)
                traceLog(traceId, 'pipeline:complete')
                recordExecutionStage({ stage: 'pipeline.completed', success: true })
                getMessageBus().emitSync('llm:response', { channel, userId: from, completed: true }, { source: 'pipeline', correlationId: traceId })
                return result
            }), priority))
    } catch (error) {
        recordExecutionStage({ stage: 'pipeline.failed', success: false })
        runtimeState.fail(String(error).slice(0, 200))
        getMessageBus().emitSync('system:error', { channel, userId: from, error: String(error) }, { source: 'pipeline', correlationId: traceId })
        throw error
    } finally {
        if (runtimeState.isError()) runtimeState.recover('message completed with error')
        else if (!runtimeState.isIdle()) runtimeState.finish('message completed')
        endTrace(traceId)
    }
}


// ============================================
// Command Handler (Layer 2)
// ============================================

async function handleCommand(cmd: string, args: string, from: string, context?: import('./users/principal-id.js').PrincipalContext): Promise<string | null> {
    const { handleCommand: handleCmd } = await import('./core/slash-commands.js')
    return handleCmd(cmd, args, from, state as any, availableLLMs, context)
}

// ============================================
// Channel Starters (extracted to core/daemon-channels.ts)
// ============================================
import { getChannelGateway } from './core/channel-gateway.js'
import { resolveConfigPath } from './config/config-path.js'


// ============================================
// Daemon Main
// ============================================

async function startDaemon() {
    console.log('')
    console.log('╔═══════════════════════════════════════════════════════╗')
    console.log('║           ✨ Xaventra Core Starting ✨                 ║')
    console.log('╚═══════════════════════════════════════════════════════╝')
    console.log('')

    // One-way security migration: remove Nova's historical copies of Codex
    // OAuth credentials. The new app-server profiles remain untouched and are
    // stored outside .nova-data per canonical user x node.
    try {
        const { purgeLegacyCodexCredentialCopies } = await import('./auth/legacy-codex-migration.js')
        const purged = purgeLegacyCodexCredentialCopies()
        if (purged.removedFiles || purged.removedProfiles) {
            console.log(`[Nova] Legacy Codex credential copies removed (${purged.removedFiles} file, ${purged.removedProfiles} profile)`)
        }
    } catch (error) {
        console.warn(`[Nova] Legacy Codex credential cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // === PID File: Prevent duplicate daemons ===
    const pidFile = join(process.cwd(), '.nova.pid')
    try {
        if (existsSync(pidFile)) {
            const oldPid = parseInt(readFileSync(pidFile, 'utf-8').trim())
            if (oldPid) {
                if (isNovaDaemonPid(oldPid)) {
                    console.error(`[Nova] ❌ Daemon läuft bereits (PID ${oldPid})! Erst killen oder .nova.pid löschen.`)
                    process.exit(1)
                } else {
                    // Process doesn't exist — stale PID file
                    console.log(`[Nova] ⚠ Stale PID-File gefunden (PID ${oldPid} nicht mehr aktiv) — wird überschrieben`)
                }
            }
        }
        writeFileSync(pidFile, String(process.pid))
        // Always remove our own PID marker on normal exit, including startup
        // failures that happen before graceful signal handlers are registered.
        process.once('exit', () => {
            try {
                if (existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim() === String(process.pid)) {
                    unlinkSync(pidFile)
                }
            } catch { /* best effort */ }
        })
        console.log(`[Nova] PID: ${process.pid}`)
    } catch (err) {
        console.warn(`[Nova] PID-File konnte nicht geschrieben werden: ${err}`)
    }

    // Open the authenticated mesh listener immediately after single-process
    // protection. Agent work remains unavailable until the pipeline handler is
    // attached after config validation below.
    try {
        initMeshTransportRuntime()
        console.log('[Nova] Mesh listener ready; worker execution waits for runtime readiness')
    } catch (err) {
        console.log(`[Nova] Early mesh listener failed: ${err}`)
    }

    // === Offline-Duration Tracking ===
    // Record shutdown time on exit, read it on startup to know how long Nova was down.
    const offlineTrackFile = join(process.cwd(), '.nova-data', 'last-heartbeat.json')
    let _offlineDurationMs = 0
    try {
        if (!existsSync(join(process.cwd(), '.nova-data'))) mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true })
        if (existsSync(offlineTrackFile)) {
            const hb = JSON.parse(readFileSync(offlineTrackFile, 'utf-8'))
            if (hb.shutdownAt) {
                _offlineDurationMs = Date.now() - new Date(hb.shutdownAt).getTime()
                const offlineH = Math.round(_offlineDurationMs / 1000 / 60 / 60 * 10) / 10
                console.log(`[Nova] ⏱ Offline-Dauer seit letztem Shutdown: ${offlineH}h`)
            }
        }
        // Write heartbeat file — updated every 5 min while running, shutdown time on exit
        writeFileSync(offlineTrackFile, JSON.stringify({ startedAt: new Date().toISOString(), shutdownAt: null, pid: process.pid }))
        // Keep heartbeat fresh every 5 minutes
        setInterval(() => {
            try { writeFileSync(offlineTrackFile, JSON.stringify({ startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(), pid: process.pid })) } catch { /* ignore */ }
        }, 5 * 60 * 1000)
    } catch { /* non-critical */ }
    ;(state as any)._offlineDurationMs = _offlineDurationMs

    // === Preload hot-path modules in background (reduces first-message latency) ===
    preloadPipelineModules().catch(() => {})

    // === Trace Analyzer: start hourly analysis of agent traces ===
    import('./learning/trace-analyzer.js').then(m => m.startTraceAnalyzer()).catch(() => {})

    // === Version Detection ===
    let novaVersion = '0.0.0'
    let gitHash = ''
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'))
        novaVersion = pkg.version || '0.0.0'
    } catch { /* ok */ }
    try {
        const { execSync } = await import('node:child_process')
        gitHash = execSync('git rev-parse --short HEAD', { cwd: process.cwd(), timeout: 3000 }).toString().trim()
    } catch { /* no git */ }
    const versionTag = gitHash ? `${novaVersion} (${gitHash})` : novaVersion
        ; (globalThis as any).__novaVersion = versionTag
    getNovaState().version = versionTag
    console.log(`[Nova] Version: ${versionTag}`)

    // === OpenTelemetry (OTel JS SDK 2.0) ===
    const finishTelemetryStartup = startStartupPhase('telemetry')
    try {
        const { initTelemetry } = await import('./infra/telemetry.js')
        await initTelemetry()
        finishTelemetryStartup()
    } catch (err) {
        finishTelemetryStartup('failed', String(err).slice(0, 160))
        console.warn(`[Nova] OTel init skipped: ${err}`)
    }

    // === Gateway Auth Token ===
    try {
        const { initGatewayAuth } = await import('./infra/gateway-auth.js')
        const auth = initGatewayAuth()
        if (auth.mode === 'token') {
            console.log(`[Nova] 🔑 Gateway auth: Bearer token active`)
        }
    } catch (err) {
        console.warn(`[Nova] Gateway auth init skipped: ${err}`)
    }

    // === Config Validation ===
    try {
        const { validateConfig } = await import('./core/config-validator.js')
        const validation = validateConfig()
        if (validation.warnings.length > 0) {
            validation.warnings.forEach(w => console.warn(`[Config] ⚠ ${w}`))
        }
        if (!validation.valid) {
            validation.errors.forEach(e => console.error(`[Config] ❌ ${e}`))
            console.error('[Nova] ❌ Konfiguration ungültig — Daemon wird nicht gestartet.')
            process.exit(1)
        }
        console.log('[Nova] ✓ Config validiert')
    } catch (err) {
        console.warn(`[Nova] Config-Validator nicht verfügbar: ${err}`)
    }

    // Load config
    const configPath = resolveConfigPath()
    if (!existsSync(configPath)) {
        console.error('[Nova] ❌ Keine Konfiguration gefunden. Führe npm run setup aus.')
        process.exit(1)
    }

    const config: NovaConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        ; (state as any).config = config  // Store for runtime access (userAliases, etc.)
    setNovaConfig(config as any)  // Publish to getNovaConfig() singleton (used by plugins)
    try {
        const { resolveRuntimeProfile } = await import('./runtime/runtime-profiles.js')
        const runtimeProfile = resolveRuntimeProfile(config.runtime)
        ;(state as any).runtimeProfile = runtimeProfile
        if (config.runtime?.hotReload && runtimeProfile.name === 'developer') process.env.NOVA_PLUGIN_HOT_RELOAD = '1'
        console.log(`[Nova] Runtime profile: ${runtimeProfile.name} (${runtimeProfile.bundles.join(', ')})`)
    } catch (error) {
        console.error(`[Nova] Invalid runtime profile: ${error}`)
        process.exit(1)
    }

    // Attach the execution pipeline only after validated config is available.
    // Coordination stays separate in leader-election; transport health never
    // elects a main node by itself.
    try {
        initMeshTransportRuntime(handleMessage)
        console.log('[Nova] Mesh worker execution enabled (Direct/Supabase/Relay/Local)')
    } catch (err) {
        console.log(`[Nova] Mesh Transport early startup failed: ${err}`)
    }

    // Load cold storage files into state for memory pipeline
    try {
        const coldFiles: Record<string, string> = {}
        const filesToCheck = [
            join(process.cwd(), 'USER.md'),
            join(process.cwd(), 'MEMORY.md'),
            join(process.cwd(), '.nova-data', 'USER.md'),
            join(process.cwd(), '.nova-data', 'MEMORY.md'),
        ]
        for (const f of filesToCheck) {
            if (existsSync(f)) {
                const key = f.endsWith('USER.md') ? 'userProfile' : 'longTermMemory'
                coldFiles[key] = readFileSync(f, 'utf-8')
                console.log(`[Nova] ✓ Cold storage geladen: ${f}`)
            }
        }
        if (Object.keys(coldFiles).length > 0) {
            (state as any).coldStorage = coldFiles
        }
    } catch (err) {
        console.log(`[Nova] Cold storage nicht gefunden: ${err}`)
    }

    // Merge environment variables into config (secrets from .env)
    if (process.env.TELEGRAM_BOT_TOKEN) {
        config.channels = config.channels || {}
        config.channels.telegram = {
            ...config.channels.telegram,
            enabled: true,
            token: process.env.TELEGRAM_BOT_TOKEN,
            allowFrom: process.env.TELEGRAM_ALLOW_FROM?.split(',') || config.channels.telegram?.allowFrom || [],
        }
    }

    // ============================================
    // Hardware-Aware Role Distribution
    // Detect platform and assign role (Full/Bridge/Vision/Compute)
    // ============================================
    try {
        const { detectPlatformRole } = await import('./core/hardware-role.js')
        const role = detectPlatformRole()
            ; (state as any).hardwareRole = role
    } catch (err) {
        console.log(`[Nova] ⚠ Hardware-Role detection failed, defaulting to Full Mode: ${err}`)
            ; (state as any).hardwareRole = { role: 'full', roleName: 'Full Mode', roleEmoji: '🖥️' }
    }

    // Initialize LLM
    console.log('[Nova] Initialisiere LLM...')
    const finishLlmStartup = startStartupPhase('llm-ready')
    try {
        state.llm = await createLLM(config)
            // Initialize centralized state store (also sets globalThis.__novaState for legacy compat)
            ; initNovaState(state as any)
        console.log(`[Nova] ✓ LLM verbunden: ${config.provider}/${state.llm.modelId}`)
        finishLlmStartup()
    } catch (err) {
        finishLlmStartup('failed', String(err).slice(0, 160))
        console.error(`[Nova] ❌ LLM Fehler: ${err}`)
        process.exit(1)
    }

    // ============================================
    // Message Queue — init BEFORE Telegram connects so incoming messages are logged
    // ============================================
    try {
        const { initMessageQueue } = await import('./channels/message-queue.js')
        const pendingMessages = initMessageQueue()
        if (pendingMessages.length > 0) {
            console.log(`[Nova] 📬 ${pendingMessages.length} unprocessed message(s) from last session — will replay after channels are ready`)
            // Store for replay after channel boot
            ;(state as any)._pendingReplayMessages = pendingMessages
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Message queue init: ${err}`)
    }

    // ============================================
    // Plugin Discovery — must run after config is loaded
    // ============================================
    try {
        const { getPluginManager } = await import('./plugins/plugin-sdk.js')
        const pluginMgr = getPluginManager()
        const loaded = await pluginMgr.discover()
        if (loaded > 0) {
            const stats = pluginMgr.getStats()
            console.log(`[Nova] 🔌 Plugins: ${stats.active} active, ${stats.tools} tools, ${stats.hooks} hooks`)
        }
    } catch (err) {
        console.warn(`[Nova] Plugin discovery skipped: ${err}`)
    }

    // ============================================
    // FAST-PATH: Connect Telegram immediately after LLM is ready
    // This ensures offline messages (sent while Nova was down) are received
    // as soon as possible — BEFORE the slow layer/discovery init below.
    // Messages that arrive before tools are loaded still get LLM answers.
    // ============================================
    const isNodeOnly = process.env.NOVA_NODE_ONLY === 'true'
    const noTelegram = process.env.NOVA_NO_TELEGRAM === 'true'
    const telegramMode = process.env.NOVA_TELEGRAM_MODE || (isNodeOnly ? 'disabled' : 'primary')
    const telegramEligible = !noTelegram && telegramMode !== 'disabled' && (!isNodeOnly || telegramMode === 'standby')
    if (telegramEligible) {
        console.log(`[Nova] ⚡ Fast-path: Telegram ${telegramMode === 'standby' ? 'standby' : 'early connect'}...`)
        const finishTelegramStartup = startStartupPhase('telegram-ready')
        // runtimeReady gates incoming work. Channel integration can finish
        // concurrently instead of holding boot behind HA hydration and
        // optional reminder/self-check callback imports.
        void getChannelGateway().start('telegram', config.channels?.telegram, handleMessage, state)
            .then(() => {
                finishTelegramStartup()
                console.log(state.channels.telegram
                    ? '[Nova] ✓ Telegram verbunden (early — Offline-Nachrichten werden empfangen)'
                    : '[Nova] ✓ Telegram-Standby aktiv (wartet auf gültige Main-Lease)')
            })
            .catch(err => {
                finishTelegramStartup('failed', String(err).slice(0, 160))
                console.log(`[Nova] ⚠ Telegram early-connect fehlgeschlagen: ${err}`)
            })
    }

    // ============================================
    // Ollama Auto-Start (async — does not block startup)
    // ============================================
    ;(async () => {
        if (process.env.NOVA_AUTO_START_OLLAMA !== '1') {
            console.log('[Nova] Ollama auto-start disabled (set NOVA_AUTO_START_OLLAMA=1 to enable)')
            return
        }
        try {
            const ollamaRunning = await fetch('http://localhost:11434/api/tags', {
                signal: AbortSignal.timeout(2000),
            }).then(r => r.ok).catch(() => false)

            if (!ollamaRunning) {
                const { execSync, spawn } = await import('node:child_process')
                let ollamaPath: string | null = null

                try {
                    if (process.platform === 'win32') {
                        ollamaPath = execSync('where ollama 2>nul', { encoding: 'utf-8' }).trim().split('\n')[0]
                    } else {
                        ollamaPath = execSync('which ollama 2>/dev/null', { encoding: 'utf-8' }).trim()
                    }
                } catch {
                    const { existsSync } = await import('node:fs')
                    const commonPaths = process.platform === 'win32'
                        ? ['C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
                            'C:\\Program Files\\Ollama\\ollama.exe']
                        : ['/usr/local/bin/ollama', '/usr/bin/ollama',
                            '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']
                    ollamaPath = commonPaths.find(p => existsSync(p)) || null
                }

                if (ollamaPath) {
                    console.log(`[Nova] 🦙 Ollama gefunden: ${ollamaPath} — starte...`)
                    const child = spawn(ollamaPath, ['serve'], { detached: true, stdio: 'ignore' })
                    child.unref()
                    for (let i = 0; i < 10; i++) {
                        await new Promise(r => setTimeout(r, 500))
                        const ok = await fetch('http://localhost:11434/api/tags', {
                            signal: AbortSignal.timeout(1000),
                        }).then(r => r.ok).catch(() => false)
                        if (ok) { console.log('[Nova] ✓ Ollama automatisch gestartet'); break }
                    }
                } else {
                    console.log('[Nova] ℹ Ollama nicht installiert — überspringe lokale Modelle')
                }
            } else {
                console.log('[Nova] ✓ Ollama bereits aktiv')
            }
        } catch { /* Non-critical */ }
    })()

    // ============================================
    // Internal LLM (Local, for autonomous tasks) — sync
    // ============================================
    try {
        const internalModel = config.internalModel || 'auto'
        if (internalModel === 'auto') {
            console.log('[Nova] ✓ Internal LLM: Cloud (auto)')
            state.internalLlm = state.llm
        } else {
            const { createOllamaLLM } = await import('./llm/custom.js')
            const testRes = await fetch('http://localhost:11434/api/tags').catch(() => null)
            if (testRes?.ok) {
                const payload: any = await testRes.json().catch(() => ({ models: [] }))
                const installed = (payload.models || [])
                    .map((model: any) => String(model?.name || model?.model || ''))
                    .filter(Boolean)
                const normalize = (name: string) => name.replace(/:latest$/i, '').toLowerCase()
                const configured = installed.find((name: string) => normalize(name) === normalize(internalModel))

                if (configured) {
                    state.internalLlm = createOllamaLLM('http://localhost:11434', configured)
                    console.log(`[Nova] ✓ Internal LLM: ${configured} via Ollama (lokal, autonom)`)
                } else {
                    // A reachable Ollama server does not imply that the configured
                    // model exists. Prefer another explicitly configured fallback
                    // that is actually installed; otherwise use the cloud client.
                    const fallback = undefined
                    if (fallback) {
                        state.internalLlm = createOllamaLLM('http://localhost:11434', fallback)
                        console.log(`[Nova] ⚠ Internal Model ${internalModel} fehlt — nutze installiertes ${fallback}`)
                    } else {
                        state.internalLlm = null
                        console.log(`[Nova] ⚠ Internal Model ${internalModel} nicht installiert — Cloud Fallback`)
                    }
                }
            } else {
                console.log('[Nova] ⚠ Ollama nicht erreichbar - Internal LLM nutzt Cloud Fallback')
                state.internalLlm = state.llm
            }
        }
    } catch {
        console.log('[Nova] ⚠ Internal LLM nicht verfügbar - Fallback auf Cloud LLM')
        state.internalLlm = state.llm
    }

    // Independent model runtimes: separate health, timeout and budget domains.
    // They may initially share a provider endpoint, but never share lifecycle
    // state or silently fall back into the main agent.
    const { getServiceRuntime } = await import('./runtime/service-runtime.js')
    const serviceRuntime = getServiceRuntime()
    // Report the client that actually survived provider readiness/failover.
    // Showing the requested MiniMax profile here when no credential exists made
    // Trust/health claim that MiniMax was healthy while calls used local-auto.
    const activeMainModel = String((state.llm as any)?.modelId || (config as any).model || 'auto')
    const activeMainProvider = String((state.llm as any)?.providerId || (state.llm as any)?.provider || (config as any).provider || 'auto')
    serviceRuntime.register({ role: 'main', model: activeMainModel, provider: activeMainProvider, timeoutMs: 60_000, dailyTokenBudget: 2_000_000 }, state.llm)
    // Create distinct provider clients for the autonomous services. Even when
    // both roles use the same Ollama daemon/model, they no longer share a
    // mutable client instance or the main agent's failover chain.
    const createAutonomousClient = async (requested: string) => {
        const normalize = (name: string) => name.replace(/:latest$/i, '').toLowerCase()
        const vllmNode = ((config as any).nodes || []).find((node: any) => node?.services?.vllm)
        const vllmBase = String(vllmNode?.services?.vllm || '').replace(/\/$/, '')
        if (vllmBase) {
            const response = await fetch(`${vllmBase}/v1/models`, {
                signal: AbortSignal.timeout(3_000),
            }).catch(() => null)
            if (response?.ok) {
                const payload: any = await response.json().catch(() => ({ data: [] }))
                const models = (payload.data || []).map((entry: any) => String(entry?.id || '')).filter(Boolean)
                const selected = requested !== 'auto'
                    ? models.find((name: string) => normalize(name) === normalize(requested))
                    : models.find((name: string) => /qwen/i.test(name)) || models[0]
                if (selected) {
                    const { createLocalLLM } = await import('./llm/local-llm.js')
                    return {
                        // Autonomous runtimes need native function/tool calling;
                        // CustomLLM's legacy signature treats the tools argument
                        // as options and silently drops tool definitions.
                        client: createLocalLLM({ baseUrl: vllmBase, model: selected, name: 'Nova autonomous vLLM', requestTimeoutMs: 45_000 }),
                        model: selected,
                        provider: 'vllm',
                    }
                }
            }
        }
        const response = await fetch('http://localhost:11434/api/tags', {
            signal: AbortSignal.timeout(2_000),
        }).catch(() => null)
        if (!response?.ok) return null
        const payload: any = await response.json().catch(() => ({ models: [] }))
        const installed = (payload.models || [])
            .map((entry: any) => String(entry?.name || entry?.model || ''))
            .filter(Boolean)
        const internal = String((config as any).internalModel || '')
        const preferred = requested !== 'auto' ? requested : (internal !== 'auto' ? internal : '')
        // Never replace an explicitly configured autonomous model with an
        // arbitrary larger installed model. Presence in /api/tags does not
        // prove that it can serve Nova's real prompt within the role deadline.
        const selected = preferred
            ? installed.find((name: string) => normalize(name) === normalize(preferred))
            : null
        if (!selected) return null
        const { createOllamaLLM } = await import('./llm/custom.js')
        return { client: createOllamaLLM('http://localhost:11434', selected), model: selected, provider: 'ollama' }
    }
    const learningRequested = String((config as any).learningModel || 'auto')
    const repairRequested = String((config as any).repairModel || 'auto')
    const learningRuntime = await createAutonomousClient(learningRequested)
    const repairRuntime = await createAutonomousClient(repairRequested)
    if (learningRuntime) {
        serviceRuntime.register({ role: 'learning', model: learningRuntime.model, provider: learningRuntime.provider, timeoutMs: 45_000, dailyTokenBudget: 250_000, localOnly: true }, learningRuntime.client)
    } else {
        console.log('[Nova] ⚠ Learning Runtime offline — kein eigenes lokales Modell erreichbar')
    }
    if (repairRuntime) {
        serviceRuntime.register({ role: 'repair', model: repairRuntime.model, provider: repairRuntime.provider, timeoutMs: 30_000, dailyTokenBudget: 100_000, localOnly: true }, repairRuntime.client)
    } else {
        console.log('[Nova] ⚠ Repair Runtime offline — kein eigenes lokales Modell erreichbar')
    }
    ;(state as any).serviceRuntime = serviceRuntime
    // Central responsibility boundary for autonomous consumers. Production
    // modules receive these monitored facades and never bypass them through
    // the legacy shared internalLlm client.
    const serviceModels = Object.freeze({
        learning: serviceRuntime.getClient('learning'),
        repair: serviceRuntime.getClient('repair'),
    })

    // External supervisor heartbeat. The supervisor is a separate process and
    // remains able to restart Nova when this event loop or process dies.
    const supervisorUrl = process.env.NOVA_SUPERVISOR_URL || 'http://127.0.0.1:3099'
    const sendSupervisorHeartbeat = async () => {
        try {
            await fetch(`${supervisorUrl}/api/heartbeat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ pid: process.pid, services: serviceRuntime.getStatus(), timestamp: Date.now() }),
                signal: AbortSignal.timeout(2000),
            })
        } catch { /* supervisor is optional when Nova is started standalone */ }
    }
    void sendSupervisorHeartbeat()
    setInterval(() => void sendSupervisorHeartbeat(), 20_000).unref()

    // ============================================
    // Nova Doctor Llama Engine — in-process GGUF (models/ dir)
    // Loads nova-doctor-1.5b-q5km.gguf (or 0.5b fallback) as local backup LLM
    // Used by L0-self-repair, L15-self-check, L36-auto-bug-fix
    // ============================================
    try {
        const { getLlamaEngine, hasLocalModel } = await import('./llm/llama-engine.js')
        if (hasLocalModel()) {
            // Lazy-init in background — don't block startup (model loading ~5-15s)
            getLlamaEngine().then(engine => {
                if (engine) {
                    serviceRuntime.register({ role: 'doctor', model: engine.modelName, provider: 'llama.cpp', timeoutMs: 20_000, dailyTokenBudget: 80_000, localOnly: true }, {
                        complete: async (input: any) => {
                            const messages = Array.isArray(input) ? input : [{ role: 'user', content: String(input) }]
                            return { content: await engine.chat(messages) }
                        },
                    })
                    console.log(`[Nova] ✅ Nova Doctor online: ${engine.modelName} (isolated runtime)`)
                }
            }).catch(err => console.warn(`[Nova] ⚠ Nova Doctor Engine Fehler: ${err.message}`))
        } else {
            console.log('[Nova] ℹ Nova Doctor: kein GGUF in models/ — nur Cloud-Fallback')
        }
    } catch (err) {
        console.warn(`[Nova] ⚠ Nova Doctor nicht verfügbar: ${err}`)
    }

    // ============================================
    // Model Discovery + L18 Router Init
    // Use cached models if fresh (< 30min) — do NOT block startup for a fresh scan.
    // Background refresh happens after all layers are loaded.
    // ============================================
    const _configureRouterWithModels = async (fresh: boolean) => {
        try {
            const { discoverAllModels, getAvailableModels } = await import('./llm/model-discovery.js')
            const models = await discoverAllModels(fresh)
            const cloudCount = models.filter((m: any) => m.source === 'cloud-api').length
            const localCount = models.filter((m: any) => m.source === 'local').length
            const meshCount = models.filter((m: any) => m.source === 'mesh').length
            console.log(`[Nova] ✓ Model Discovery: ${models.length} Models (☁️${cloudCount} 🖥️${localCount} 🌐${meshCount})`)

            try {
                const { configureRouter } = await import('./layers/L18-llm-router.js')
                const available = getAvailableModels()
                const availableModelIds = [...new Set([
                    ...availableLLMs.map((m: any) => m.model),
                    ...available.map((m: any) => m.id),
                ])]
                // preferLocal: false — MiniMax/Cloud APIs are primary, local models are fallback only.
                // Local models (qwen2.5:3b, gemma, etc.) are only used when cloud APIs are unavailable.
                const hasMiniMax = availableModelIds.some(id => id.toLowerCase().startsWith('minimax'))
                const hasCloudApi = availableModelIds.some(id =>
                    id.toLowerCase().startsWith('minimax') ||
                    id.toLowerCase().startsWith('gpt') ||
                    id.toLowerCase().startsWith('claude')
                )

                // Use already-parsed config (don't re-read xaventra.config.json — it may be stale or mid-write)
                // `config` is the authoritative in-memory config loaded at daemon startup
                const preferredModel: string | undefined = (config as any).model && (config as any).model !== 'auto'
                    ? (config as any).model
                    : undefined
                const preferredProvider: string | undefined = (config as any).preferredProvider || (config as any).provider

                configureRouter({
                    availableModels: availableModelIds,
                    preferLocal: !hasCloudApi,
                    maxCostTier: 'high',
                    preferSpeed: false,
                    preferredModel,
                    preferredProvider,
                })
                if (preferredModel) {
                    const preferredIsLocal = ['local', 'ollama'].includes(String(preferredProvider || '').toLowerCase())
                        || availableLLMs.some((entry: any) => entry.model === preferredModel && entry.local)
                    console.log(preferredIsLocal
                        ? `[Nova] 🖥️ Primärmodell: ${preferredModel} — lokales Runtime-Modell aktiv`
                        : `[Nova] 🌐 Primärmodell: ${preferredModel} — lokale Modelle dienen als Fallback`)
                }
                console.log(`[Nova] ✓ L18 Router konfiguriert (${available.length} Models verfügbar)`)
            } catch (err) {
                console.log(`[Nova] ⚠ L18 Router nicht verfügbar: ${err}`)
            }
        } catch (err) {
            console.log(`[Nova] ⚠ Model Discovery nicht verfügbar: ${err}`)
        }
    }
    // Cache-only startup: never turn a first boot or expired cache into a blocking
    // network/SSH scan. The configured primary model remains immediately usable.
    let hasCachedModels = false
    try {
        const { getAvailableModels } = await import('./llm/model-discovery.js')
        hasCachedModels = getAvailableModels().length > 0
        if (hasCachedModels) await _configureRouterWithModels(false)
        else console.log('[Nova] Model cache empty — discovery deferred to background')
    } catch { /* configured model remains active */ }
    // First boot starts quickly; discovery begins as soon as the event loop is free.
    setTimeout(() => _configureRouterWithModels(true).catch(() => {}), hasCachedModels ? 10_000 : 2_000)
    // Enrich MODEL_REGISTRY with live-discovered models from ProviderRegistry
    setTimeout(async () => {
        try {
            const { enrichRegistryFromProviders } = await import('./layers/L18-llm-router.js')
            await enrichRegistryFromProviders()
        } catch { /* non-critical */ }
    }, 12_000)
    // After fresh discovery, run capability probe in background (no await)
    // Probes every discovered endpoint: online? tools? vision? latency? → roles
    setTimeout(() => {
        import('./llm/capability-probe.js')
            .then(m => m.probeAllModels())
            .catch(err => console.log(`[Nova] ⚠ Capability probe: ${err}`))
    }, 15_000)

    // Periodic re-probe every 2h — detects new/updated/changed models and
    // re-classifies what each one is good for. This is how Nova keeps her
    // self-knowledge current as models are added/updated on the mesh.
    setInterval(() => {
        import('./llm/capability-probe.js')
            .then(m => m.probeAllModels(true))  // forceRefresh — re-probe everything
            .then(results => {
                const online = results.filter(r => r.online).length
                console.log(`[Nova] 🔄 Periodic capability re-probe: ${online}/${results.length} models online`)
            })
            .catch(() => { })
    }, 2 * 60 * 60 * 1000)

    // ProviderRegistry: Auto-detect TTS engine based on available providers
    setTimeout(async () => {
        try {
            const { getProviderRegistry } = await import('./llm/provider-registry.js')
            const reg = getProviderRegistry()
            const ttsProv = reg.getBestTTSProvider()
            if (ttsProv) {
                const cfg = (state as any).config
                if (cfg?.voice?.enabled && cfg.voice.ttsEngine !== ttsProv.provider.id) {
                    cfg.voice.ttsEngine = ttsProv.provider.id
                    console.log(`[Nova] 🎙 Auto-detected TTS provider: ${ttsProv.provider.name}`)
                }
            }
            // Auto-detect preferCloud based on live connectivity
            const preferCloud = await reg.shouldPreferCloud()
            if (preferCloud) {
                const { configureRouter } = await import('./layers/L18-llm-router.js')
                configureRouter({ preferLocal: false })
                console.log(`[Nova] 🌐 ProviderRegistry: Cloud verfügbar — preferLocal=false gesetzt`)
            }
        } catch { /* non-critical */ }
    }, 5_000)

    // VRAM Manager (async, non-blocking)
    import('./layers/vram-manager.js').then(m => {
        const ollamaHost = (state as any).config?.ollama?.host || 'http://localhost:11434'
        return m.initVRAMManager(ollamaHost)
    }).catch(err => console.log(`[Nova] ⚠ VRAM Manager: ${err}`))

    // ============================================
    // Scan Environment - Find Python, Pip, Node etc. (async)
    // ============================================
    import('./startup/environment-scanner.js')
        .then(m => m.scanEnvironment())
        .catch(err => console.log(`[Nova] ⚠ Environment-Scan nicht verfügbar: ${err}`))

    // ============================================
    // Global Environment Detection (Self-Awareness)
    // ============================================
    try {
        const { detectEnvironment, getCapabilities } = await import('./core/environment.js')
        const env = detectEnvironment(true)  // Force fresh detection on startup
        console.log(`[Nova] ✓ Environment: ${env.os}/${env.arch} on ${env.hostname}`)

        // Inject capabilities into system prompt so LLM knows what Nova can do
        const { setEnvironmentCapabilities } = await import('./core/soul.js')
        setEnvironmentCapabilities(getCapabilities(), getCapabilities)
    } catch (err) {
        console.log(`[Nova] ⚠ Environment detection nicht verfügbar: ${err}`)
    }

    // ============================================
    // Self-Setup Autopilot (read-only scan + plan)
    // ============================================
    try {
        const { runSelfSetupScan } = await import('./core/self-setup-orchestrator.js')
        const setup = await runSelfSetupScan()
        console.log(`[Nova] ✓ Self-Setup Scan: ${setup.summary} (${setup.mode})`)
    } catch (err) {
        console.log(`[Nova] ⚠ Self-Setup Scan nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Layer 0 - Resilience & Self-Repair
    // ============================================
    try {
        const { ResilienceManager } = await import('./resilience/manager.js')
        state.resilience = new ResilienceManager()
        state.resilience.start()

        // Add Self-Repair Engine
        const { getSelfRepairEngine, handleUncaughtError } = await import('./layers/L0-self-repair.js')
        const _repairEngine = getSelfRepairEngine() // Triggered for initialization

        // Global error handler for self-repair
        process.on('uncaughtException', (error) => {
            console.error('[L0] Uncaught Exception:', error.message)
            handleUncaughtError(error)
        })

        process.on('unhandledRejection', (reason) => {
            console.error('[L0] Unhandled Rejection:', reason)
            if (reason instanceof Error) {
                handleUncaughtError(reason)
            }
        })

        console.log('[Nova] ✓ Layer 0 (Resilience + Self-Repair) aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ Resilience nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Layer 3 - Core Runtime
    // ============================================
    try {
        const { getCoreRuntime } = await import('./layers/L03-core-runtime.js')
        const runtime = getCoreRuntime()

        // Start watchdog and message bus
        runtime.start()

        // Wire up state transitions
        runtime.bus.subscribe('state.transition', (msg) => {
            console.log(`[L03] State: ${JSON.stringify(msg.payload)}`)
        })

            // Store in state
            ; (state as any).coreRuntime = runtime

        const status = runtime.getStatus()
        console.log(`[Nova] ✓ Layer 3 (Core Runtime) aktiv - State: ${status.state}`)
    } catch (err) {
        console.log(`[Nova] ⚠ Core Runtime nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Layer 6 - Memory (Local + Vector)
    // ============================================
    try {
        const { LocalMemoryManager } = await import('./memory/local-memory.js')
        const { getVectorMemory } = await import('./memory/vector-memory.js')

        // Local keyword-based memory
        const localMemory = new LocalMemoryManager({
            dbPath: join(process.cwd(), '.nova-memory'),
            maxEntriesPerUser: 500,
        })

        // Vector semantic memory
        const vectorMemory = getVectorMemory({
            dataDir: join(process.cwd(), '.nova-vector-memory'),
            maxEntriesPerUser: 1000,
            similarityThreshold: 0.3,
        })
        await vectorMemory.initialize()

        // Combine both memory systems
        state.memory = {
            // Use vector for semantic search
            recall: async (query: string, userId: string, limit: number) => {
                const vectorResults = await vectorMemory.recall(query, userId, limit)
                const localResults = await localMemory.recall(query, userId, limit)

                // Also try LanceDB if available
                let lanceResults: Array<{ content: string; score: number }> = []
                try {
                    const lance = (state as any).lanceMemory
                    if (lance) {
                        const results = await lance.recall(query, limit)
                        lanceResults = results.map((r: any) => ({
                            content: r.entry?.content || r.content || '',
                            score: r.score || 0.5,
                        }))
                    }
                } catch { /* lance optional */ }

                // Combine and deduplicate
                const seen = new Set<string>()
                const combined = []
                for (const r of [...vectorResults, ...localResults, ...lanceResults]) {
                    const key = r.content.slice(0, 50)
                    if (!seen.has(key)) {
                        seen.add(key)
                        combined.push(r)
                    }
                }
                return combined.slice(0, limit)
            },
            // Store in ALL systems (local + vector + LanceDB)
            store: async (entry: any) => {
                await localMemory.store(entry)
                await vectorMemory.store(entry)

                // NOTE: LanceDB storage is handled exclusively by message-pipeline.ts
                // (extracts facts, filters noise, avoids duplicates)
                // Do NOT write to LanceDB here — it caused double-writes
            },
            getStats: () => ({
                ...localMemory.getStats(),
                vectorStats: vectorMemory.getStats(),
            }),
        }

        const stats = localMemory.getStats()
        const vStats = vectorMemory.getStats()
        console.log(`[Nova] ✓ Layer 6 (Memory) aktiv (${stats.totalUsers} Users, ${stats.totalEntries}+${vStats.totalEntries} Einträge)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Memory nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize L6-core-facts (Tier-0 — always injected into every system prompt)
    // ============================================
    try {
        const { initCoreFacts } = await import('./layers/L6-core-facts.js')
        initCoreFacts()
        console.log('[Nova] ✓ L6 Core Facts initialisiert')
    } catch (err) {
        console.log(`[Nova] ⚠ Core Facts nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Layer 7 - Learning & Swarm
    // ============================================
    try {
        const { createFeedbackCollector } = await import('./learning/feedback.js')
        const { getCorrectionLearner, getSkillSynthesizer, getAgentSwarm } = await import('./layers/L7-learning.js')
        const { getMultiBotManager } = await import('./layers/multi-bot.js')

        // Basic feedback collector
        const feedbackCollector = createFeedbackCollector()

        // Advanced learners
        const correctionLearner = getCorrectionLearner()
        const skillSynthesizer = getSkillSynthesizer()
        const agentSwarm = getAgentSwarm()
        const botManager = getMultiBotManager()

        // One-way, idempotent bridge from legacy L7 corrections into the
        // governed, user-scoped memory authority. Only explicitly parseable
        // corrections are accepted; duplicate proposals merely add provenance.
        try {
            const { recordUserCorrectionMemory } = await import('./memory/correction-memory.js')
            const { principalScope } = await import('./users/principal-id.js')
            let migratedCorrections = 0
            for (const correction of correctionLearner.getRecentCorrections(200)) {
                const record = await recordUserCorrectionMemory({
                    scope: principalScope(correction.userId),
                    message: correction.correctedResponse,
                    priorAssistantResponse: correction.originalResponse,
                    sessionId: `legacy-correction:${correction.id}`,
                })
                if (record) migratedCorrections++
            }
            if (migratedCorrections > 0) {
                console.log(`[Memory] ${migratedCorrections} legacy corrections reconciled with governance`)
            }
        } catch (err) {
            console.debug(`[Memory] Legacy correction reconciliation skipped: ${err}`)
        }

        // Load persisted feedback
        const feedbackPath = join(process.cwd(), '.nova-learning', 'feedback.json')
        if (existsSync(feedbackPath)) {
            feedbackCollector.importFromJSON(readFileSync(feedbackPath, 'utf-8'))
        }

        // Register main Nova as agent in swarm
        agentSwarm.registerAgent({
            name: 'Nova-Main',
            role: 'coordinator',
            channel: 'system',
        })

        // Combine all learning systems
        state.learning = {
            feedback: feedbackCollector,
            corrections: correctionLearner,
            skills: skillSynthesizer,
            swarm: agentSwarm,
            bots: botManager,

            // Learn from user correction
            recordCorrection: (userId: string, original: string, corrected: string) => {
                correctionLearner.recordCorrection({
                    userId,
                    originalResponse: original,
                    correctedResponse: corrected,
                    context: '',
                })
            },

            // Find matching skill for query
            findSkill: (query: string) => skillSynthesizer.findMatchingSkill(query),

            getStats: () => ({
                feedback: feedbackCollector.getStats(),
                corrections: correctionLearner.getStats(),
                skills: skillSynthesizer.getStats(),
                swarm: agentSwarm.getStats(),
                bots: botManager.getStats(),
            }),
        }

        const cStats = correctionLearner.getStats()
        const sStats = skillSynthesizer.getStats()
        const bStats = botManager.getStats()
        console.log(`[Nova] ✓ Layer 7 (Learning) aktiv (${cStats.totalCorrections} Korrekturen, ${sStats.totalSkills} Skills, ${bStats.totalBots} Bots)`)

        // Bind the monitored learning service to L7.
        if (serviceModels.learning) {
            const { setInternalLLM: setL7LLM } = await import('./layers/L7-learning.js')
            setL7LLM(serviceModels.learning)
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Learning nicht verfügbar: ${err}`)
    }

    // Learning Engine — unified self-improvement
    try {
        const { getLearningCoordinator } = await import('./learning/learning-coordinator.js')
        const learningCoordinator = getLearningCoordinator()
        await learningCoordinator.start()
        ;(state as any).learningCoordinator = learningCoordinator
        console.log('[Daemon] ✅ LearningCoordinator started')
    } catch (err) {
        console.log('[Daemon] LearningCoordinator not available:', err)
    }

    // ============================================
    // Initialize Orchestrator & Factory (Sub-Agent Systems)
    // ============================================
    try {
        const { getOrchestrationAuthority } = await import('./core/orchestration-authority.js')
        const { getFactory } = await import('./core/factory.js')

        const orchestrator = getOrchestrationAuthority({
            defaultTimeoutMs: 30000,   // 30s before spawning helpers
            maxAgentsPerTask: 3,
            maxTotalAgents: 10,
            checkIntervalMs: 5000,
        })

        // Start the orchestrator's timeout watcher
        orchestrator.start()

        // Register callback so Nova gets notified of sub-agent results
        orchestrator.registerNovaCallback(async (event: string, data: unknown) => {
            console.log(`[Orchestrator] Event: ${event}`, typeof data === 'string' ? data.slice(0, 100) : '')
            // If a sub-agent completed a task, send result to user via Telegram
            if (event === 'task:completed' && state.channels.telegram) {
                try {
                    const result = data as { taskId: string; result: string }
                    if (result.result) {
                        const tg = state.channels.telegram
                        // Notify admin about completed sub-agent task
                        console.log(`[Orchestrator] ✅ Sub-agent completed: ${result.result.slice(0, 100)}`)
                    }
                } catch { /* non-critical */ }
            }
        })

        const factory = getFactory({
            taskTimeoutMs: 30000,
            maxSubAgents: 5,
            enableAutoDecompose: true,
        })

            // Store on state for pipeline access
            ; (state as any).orchestrator = orchestrator
            ; (state as any).factory = factory

        const oStats = orchestrator.getStats()
        console.log(`[Nova] ✓ Orchestrator aktiv (timeout: 30s, max ${10} agents)`)
        console.log(`[Nova] ✓ Factory aktiv (auto-decompose: on, max ${5} sub-agents)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Orchestrator/Factory nicht verfügbar: ${err}`)
    }

    // ============================================
    // Layer 8 starts once, after the complete tool registry is available.
    // ============================================
    if (false) try {
        const { getMetaLearningSystem } = await import('./layers/L8-meta-learning.js')
        const toolNames = state.tools ? Object.keys(state.tools) : []
        const metaLearning = getMetaLearningSystem(toolNames)

            // Attach to state for use in message handling
            ; (state as any).metaLearning = metaLearning

        const skills = metaLearning.getLearnedSkills()
        console.log(`[Nova] ✓ Layer 8 (Meta-Learning) aktiv (${skills.length} gelernte Skills)`)

        // Bind the monitored learning service to L8.
        if (serviceModels.learning) {
            const { setInternalLLM: setL8LLM } = await import('./layers/L8-meta-learning.js')
            setL8LLM(serviceModels.learning)
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Meta-Learning nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Layer 2 - Complete Tool Registry
    // ============================================
    try {
        const { getToolRegistry } = await import('./tools/complete-registry.js')
        const registry = getToolRegistry()
        state.tools = registry
        const stats = registry.getStats()
        console.log(`[Nova] ✓ Layer 2 (${stats.total} Tools) geladen: ${Object.entries(stats.byCategory).map(([k, v]) => `${k}:${v}`).join(', ')}`)
    } catch (err) {
        console.log(`[Nova] ⚠ Tools nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Security: Code Guardian
    // ============================================
    try {
        const { initCodeGuardian } = await import('./security/code-guardian.js')
        initCodeGuardian()
    } catch (err) {
        console.log(`[Nova] ⚠ Code Guardian nicht verfügbar: ${err}`)
    }

    // ============================================
    // Initialize Security: SSRF Guard
    // ============================================
    try {
        const { initSSRFGuard } = await import('./security/ssrf-guard.js')
        initSSRFGuard()
    } catch (err) {
        console.log(`[Nova] ⚠ SSRF Guard: ${err}`)
    }

    // ============================================
    // Initialize Mesh Event Hub (Real-time Pub/Sub)
    // ============================================
    if (isNodeOnly) {
        console.log('[Nova] Legacy Mesh Event Hub disabled on node-only worker; signed mesh transport is authoritative')
    } else try {
        const { initMeshEvents } = await import('./mesh/event-hub.js')
        const isMain = !(state as any).config?.edge
        initMeshEvents(isMain, 9090,
            isMain ? undefined : 'ws://100.64.0.21:9090',
            isMain ? undefined : `nova-${require('os').hostname()}`)
    } catch (err) {
        console.log(`[Nova] ⚠ Mesh Events: ${err}`)
    }

    // ============================================
    // Initialize Heartbeat — Nova's internal Cron ❤️
    // Runs INDEPENDENTLY of any channel (Telegram, etc.)
    // ============================================
    try {
        const { initHeartbeat } = await import('./core/heartbeat.js')
        await initHeartbeat()
        console.log('[Nova] ✓ Heartbeat ❤️ — interner Cron aktiv (unabhängig von Channels)')
    } catch (err) {
        console.log(`[Nova] ⚠ Heartbeat: ${err}`)
    }

    // ============================================
    // Initialize Subconscious Reflector ("Dreaming")
    // ============================================
    try {
        const dreamEnabled = (config as any).autonomy?.triggers?.['dream-cycle'] === true
        if (dreamEnabled) {
            const { initReflector, setReflectorLLM } = await import('./layers/subconscious-reflector.js')
            initReflector()
            if (serviceModels.repair) {
                setReflectorLLM(serviceModels.repair)
                console.log('[Nova] ✓ Reflector LLM connected')
            }
        } else {
            console.log('[Nova] Reflector disabled by autonomy.triggers.dream-cycle')
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Reflector: ${err}`)
    }

    // ============================================
    // Initialize L23 — Instinct Layer
    // ============================================
    try {
        const { initInstincts } = await import('./layers/L23-instincts.js')
        initInstincts()
    } catch (err) {
        console.log(`[Nova] ⚠ L23 Instincts: ${err}`)
    }

    // ============================================
    // Initialize Auto-Provisioner
    // ============================================
    try {
        const { initProvisioner } = await import('./mesh/auto-provisioner.js')
        initProvisioner()
    } catch (err) {
        console.log(`[Nova] ⚠ Auto-Provisioner: ${err}`)
    }

    // ============================================
    // Initialize Predictive Provisioning
    // ============================================
    try {
        const { initPredictiveProvisioning } = await import('./layers/predictive-provisioning.js')
        initPredictiveProvisioning()
    } catch (err) {
        console.log(`[Nova] ⚠ Predictive Provisioning: ${err}`)
    }

    // ============================================
    // Initialize Vibe Regler
    // ============================================
    try {
        const { initVibeRegler } = await import('./layers/vibe-regler.js')
        initVibeRegler()
    } catch (err) {
        console.log(`[Nova] ⚠ Vibe Regler: ${err}`)
    }

    // ============================================
    // Initialize L24 — Prompt Self-Optimization
    // ============================================
    try {
        const { initPromptOptimizer } = await import('./layers/L24-prompt-optimizer.js')
        initPromptOptimizer()
    } catch (err) {
        console.log(`[Nova] ⚠ L24 Prompt Optimizer: ${err}`)
    }

    // ============================================
    // Initialize Mesh Memory Sync
    // ============================================
    try {
        const { initMeshMemory } = await import('./mesh/mesh-memory-sync.js')
        await initMeshMemory()
    } catch (err) {
        console.log(`[Nova] ⚠ Mesh Memory: ${err}`)
    }

    // ============================================
    // Initialize Mesh Tool Share
    // ============================================
    try {
        const { initToolShare, broadcastLocalTools } = await import('./mesh/mesh-tool-share.js')
        await initToolShare()
        // Broadcast local tools to mesh on boot
        const nodeName = process.env.NOVA_NODE_NAME || 'master'
        const tools = (state as any).registeredTools || []
        if (tools.length > 0) {
            await broadcastLocalTools(tools.map((t: any) => ({ name: t.name || t, description: t.description || '' })), nodeName)
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Tool Share: ${err}`)
    }

    // ============================================
    // Initialize Skills Loader (npx skills add)
    // ============================================
    try {
        const { initSkillsLoader } = await import('./core/skills-loader.js')
        initSkillsLoader()
    } catch (err) {
        console.log(`[Nova] ⚠ Skills Loader: ${err}`)
    }

    // ============================================
    // Initialize LLM Batch Processor
    // ============================================
    try {
        const { initBatchProcessor } = await import('./core/batch-processor.js')
        initBatchProcessor()
    } catch (err) {
        console.log(`[Nova] ⚠ Batch Processor: ${err}`)
    }

    // ============================================
    // Initialize Auto Bug-Fix
    // ============================================
    try {
        const { initAutoFix } = await import('./layers/auto-bug-fix.js')
        initAutoFix()
    } catch (err) {
        console.log(`[Nova] ⚠ Auto Bug-Fix: ${err}`)
    }

    // ============================================
    // Initialize Mesh Remote Execution
    // ============================================
    if (!isNodeOnly) try {
        const { initRemoteExec } = await import('./mesh/mesh-remote-exec.js')
        await initRemoteExec()
    } catch (err) {
        console.log(`[Nova] ⚠ Remote Exec: ${err}`)
    }

    // ============================================
    // Initialize Mesh LLM Proxy
    // ============================================
    if (!isNodeOnly) try {
        const { initLLMProxy, registerLLMHandlers } = await import('./mesh/mesh-llm-proxy.js')
        initLLMProxy()
        await registerLLMHandlers()
    } catch (err) {
        console.log(`[Nova] ⚠ LLM Proxy: ${err}`)
    }

    // ============================================
    // Initialize Mesh Capability Orchestrator
    // ============================================
    const finishCapabilitiesStartup = startStartupPhase('capability-projection')
    try {
        const { initCapabilityOrchestrator } = await import('./mesh/capability-orchestrator.js')
        await initCapabilityOrchestrator()
        finishCapabilitiesStartup()
    } catch (err) {
        finishCapabilitiesStartup('failed', String(err).slice(0, 160))
        console.log(`[Nova] ⚠ Capability Orchestrator: ${err}`)
    }

    // ============================================
    // Initialize Visual Mesh Memory
    // ============================================
    try {
        const { initVisualMemory } = await import('./mesh/visual-mesh-memory.js')
        initVisualMemory()
    } catch (err) {
        console.log(`[Nova] ⚠ Visual Memory: ${err}`)
    }

    // ============================================
    // Initialize Multi-User Worker Pool
    // ============================================
    try {
        const { getWorkerPool } = await import('./layers/multi-user-workers.js')
        const workerPool = getWorkerPool({
            maxTotalWorkers: 10,
            idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
        })

            // Store in state for access
            ; (state as any).workerPool = workerPool

        console.log(`[Nova] ✓ Multi-User Worker Pool bereit (max ${workerPool.getStats().config.maxTotalWorkers} Workers)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Worker Pool nicht aktiviert: ${err}`)
    }

    // ============================================
    // Initialize HEARTBEAT Scheduler (Layer 0)
    // ============================================
    try {
        const { startHeartbeat, getDueTasks } = await import('./layers/L0-supervisor.js')

        // Health Monitor — runs with heartbeat
        let healthMonitorReady = false
        try {
            const { runHealthCheck, setWarningCallback } = await import('./layers/L0-health-monitor.js')

            // Run initial health check
            const initialHealth = runHealthCheck()
            console.log(`[Nova] ✓ Health Monitor aktiv — Disk: ${initialHealth.disk.freeGB}GB frei, RAM: ${initialHealth.memory.usedPercent}%, .nova-data: ${initialHealth.novaData.sizeMB}MB`)

            // Route transitions through the governed proactive path. Direct
            // adapter sends would bypass Main/Telegram fencing and duplicate
            // the autonomy loop's view of the same health evidence.
            setWarningCallback((warnings) => {
                const governed = (state as any).sendGovernedProactive
                const msg = `🏥 **System Health Warning:**\n${warnings.join('\n')}`
                const conditionKey = warnings
                    .map(item => item.replace(/\d+(?:[.,]\d+)?/g, '#'))
                    .sort()
                    .join('|')
                if (typeof governed === 'function') {
                    void governed(msg, 'health-monitor', 'warning', 0.99, `health:${conditionKey}`).catch(() => undefined)
                } else {
                    console.log('[HealthMonitor] Governed notifier not ready; warning retained in health state')
                }
            })
            healthMonitorReady = true
        } catch (err) {
            console.log(`[Nova] ⚠ Health Monitor nicht verfügbar: ${err}`)
        }

        startHeartbeat(async (task) => {
            console.log(`[L0 Heartbeat] Task fällig: ${task.description}`)

            // Find the channel to send to
            if (task.channel === 'Telegram' && state.channels.telegram) {
                try {
                    await state.channels.telegram.send({ to: task.userId, content: `⏰ Erinnerung: ${task.description}` })
                    console.log(`[L0 Heartbeat] ✓ Erinnerung gesendet an ${task.userId}`)
                } catch (err) {
                    console.error(`[L0 Heartbeat] Fehler: ${err}`)
                }
            }

            // Run health check with each heartbeat tick
            if (healthMonitorReady) {
                try {
                    const { runHealthCheck } = await import('./layers/L0-health-monitor.js')
                    runHealthCheck()
                } catch { /* silent */ }
            }

            // Generate daily journal summary (once per hour, if events accumulated)
            try {
                const journal = (state as any).journal
                if (journal) {
                    const entry = journal.getTodayEntry()
                    if (entry.events.length >= 5 && !entry.dailySummary) {
                        console.log('[L0 Heartbeat] Generating daily journal summary...')
                        const summary = await journal.generateDailySummary()
                        if (summary) {
                            console.log(`[L0 Heartbeat] ✅ Daily summary generated (${summary.length} chars)`)
                        }
                    }
                }
            } catch { /* non-critical */ }

            // Dream Daily Digest — send once per day after 20:00 if not yet sent
            try {
                const { buildDailyDigest, isDigestSent, markDigestSent } = await import('./layers/dream-daily-digest.js')
                const hour = new Date().getHours()
                if (hour >= 20 && !isDigestSent()) {
                    const digest = buildDailyDigest()
                    if (digest) {
                        const governed = (state as any).sendGovernedProactive
                        const sent = typeof governed === 'function'
                            ? await governed(digest, 'dream-digest', 'info', 0.95, `dream-digest:${new Date().toISOString().slice(0, 10)}`)
                            : false
                        if (sent) {
                            markDigestSent()
                            console.log('[Heartbeat] ✅ Daily Digest governed gesendet')
                        }
                    }
                }
            } catch { /* non-critical */ }
        }, 5 * 60 * 1000)  // Check every 5 minutes

        const pending = getDueTasks().length
        console.log(`[Nova] ✓ HEARTBEAT Scheduler aktiv (${pending} fällige Tasks)`)
    } catch (err) {
        console.log(`[Nova] ⚠ HEARTBEAT nicht verfügbar: ${err}`)
    }

    // Telegram was already started in the fast-path above (right after LLM init).
    // Here we only start the remaining channels (WhatsApp, Discord).
    if (isNodeOnly) {
        console.log('[Nova] 🔇 NODE-ONLY Modus — keine weiteren Channels')
    } else {
        await getChannelGateway().start('whatsapp', config.channels?.whatsapp, handleMessage, state)
        await getChannelGateway().start('discord', config.channels?.discord, handleMessage, state)
    }

    // ============================================
    // Initialize Plugin SDK
    // ============================================
    try {
        const { initializeMissionWorkspacePolicy } = await import('./runtime/mission-workspace.js')
        initializeMissionWorkspacePolicy()
        console.log('[Nova] Mission workspace boundary active')
    } catch (err) {
        console.log(`[Nova] Mission workspace policy unavailable: ${err}`)
    }

    try {
        const { getPluginManager } = await import('./plugins/plugin-sdk.js')
        const pluginManager = getPluginManager()
        const { getToolRegistry } = await import('./tools/complete-registry.js')
        const pluginRegistry = getToolRegistry()
        const pluginOwnedTools = new Map<string, string>()
        pluginManager.on('toolRegistered', ({ plugin, tool, handler }: any) => {
            const owner = pluginOwnedTools.get(tool.name)
            if (pluginRegistry.get(tool.name) && !owner) throw new Error(`Plugin ${plugin} cannot replace built-in tool ${tool.name}`)
            if (owner && owner !== plugin) throw new Error(`Plugin tool collision: ${tool.name}`)
            pluginOwnedTools.set(tool.name, plugin)
            pluginRegistry.register({ ...tool, category: 'other', handler })
        })
        pluginManager.on('toolUnregistered', ({ plugin, name }: any) => {
            if (pluginOwnedTools.get(name) !== plugin) return
            pluginOwnedTools.delete(name)
            pluginRegistry.unregister(name)
        })
        const discovered = await pluginManager.discover()
        const hotReloaded = pluginManager.startHotReload()
        if (hotReloaded) console.log(`[Nova] Plugin HMR watches ${hotReloaded} development plugin(s)`)
        console.log(`[Nova] ✓ Plugin SDK: ${discovered} Plugins entdeckt`)

        const stats = pluginManager.getStats()
        console.log(`[Nova] ✓ Plugins: ${stats.active} aktiv, ${stats.tools} Tools, ${stats.commands} Commands`)
    } catch (err) {
        console.log(`[Nova] ⚠ Plugin SDK nicht verfügbar: ${err}`)
    }

    // MCP servers publish tools into the same authoritative registry and pass
    // through the same lifecycle policy as every built-in tool.
    try {
        const { initializeMCPRuntime } = await import('./mcp/mcp-runtime.js')
        const mcp = await initializeMCPRuntime()
        if (mcp.connected.length || mcp.failed.length) {
            console.log(`[Nova] MCP: ${mcp.connected.length} server(s), ${mcp.tools} tool(s), ${mcp.failed.length} isolated failure(s)`)
        }
    } catch (err) {
        console.log(`[Nova] MCP runtime unavailable: ${err}`)
    }

    // ============================================
    // Initialize Proactive Messaging System
    // ============================================
    try {
        const { getProactiveMessenger } = await import('./core/proactive.js')
        const { assessmentFromEvent } = await import('./core/proactive-policy.js')
        const { getSubAgentManager } = await import('./agents/sub-agent.js')
        const { getScheduler } = await import('./scheduler/nova-scheduler.js')

        const proactive = getProactiveMessenger()
        const subAgentManager = getSubAgentManager()
        const scheduler = getScheduler()
        const proactiveOwner = config.channels?.telegram?.allowFrom?.[0]
        ;(state as any).sendGovernedProactive = async (
            content: string,
            source: string,
            severity: 'info' | 'warning' | 'error' | 'critical' = 'info',
            confidence = 0.9,
            dedupeKey?: string,
            evidenceRefs?: string[],
        ): Promise<boolean> => {
            if (!proactiveOwner) return false
            const { getOperationalEventBus } = await import('./core/operational-event-bus.js')
            const event = getOperationalEventBus().ingest({
                source, summary: content.slice(0, 500), severity, confidence, dedupeKey, evidenceRefs,
            })
            if (!event.actionable) {
                console.log(`[Proactive] Suppressed ${source}: ${event.reason}`)
                return false
            }
            try {
                const { MAIN_SERVICE, verifyLiveServiceLeadership } = await import('./mesh/leader-election.js')
                if (!await verifyLiveServiceLeadership(MAIN_SERVICE)) return false
                if (!await verifyLiveServiceLeadership('telegram')) return false
            } catch {
                return false
            }
            return proactive.send({
                userId: String(proactiveOwner), channel: 'telegram', content,
                priority: severity === 'critical' ? 'urgent' : severity === 'error' ? 'high' : 'normal',
                type: severity === 'error' || severity === 'critical' ? 'error' : 'notification',
                assessment: assessmentFromEvent({ source, summary: content.slice(0, 500), severity, confidence, dedupeKey, actionAvailable: severity !== 'info' }),
            })
        }

        // Register Telegram channel
        if (state.channels.telegram) {
            proactive.registerChannel({
                name: 'telegram',
                isConnected: () => !!state.channels.telegram,
                send: async (userId, content) => {
                    const { MAIN_SERVICE, verifyLiveServiceLeadership } = await import('./mesh/leader-election.js')
                    if (!await verifyLiveServiceLeadership(MAIN_SERVICE)) return false
                    if (!await verifyLiveServiceLeadership('telegram')) return false
                    await state.channels.telegram.send({ to: userId, content })
                    return true
                },
            })
        }

        // Register WhatsApp channel
        if (state.channels.whatsapp) {
            proactive.registerChannel({
                name: 'whatsapp',
                isConnected: () => !!state.channels.whatsapp,
                send: async (userId, content) => {
                    await state.channels.whatsapp.send({ to: userId, content })
                    return true
                },
            })
        }

        // Wire sub-agent events to proactive messenger (auto-report)
        subAgentManager.on('task-complete', async (event: any) => {
            console.log(`[Proactive] 📣 Auto-reporting task completion to ${event.config.userId}`)
            await proactive.send({
                userId: event.config.userId,
                channel: event.config.channel as any,
                content: event.message,
                priority: 'normal',
                type: 'notification',
                assessment: assessmentFromEvent({ source: 'subagent-orchestrator', summary: `Task ${event.config?.taskId || event.taskId || 'unknown'} emitted a completion event`, severity: 'info', confidence: 0.98 }),
            })
        })

        subAgentManager.on('task-error', async (event: any) => {
            console.log(`[Proactive] 🚨 Auto-reporting task error to ${event.config.userId}`)
            await proactive.send({
                userId: event.config.userId,
                channel: event.config.channel as any,
                content: event.message,
                priority: 'high',
                type: 'error',
                assessment: assessmentFromEvent({ source: 'subagent-orchestrator', summary: `Task ${event.config?.taskId || event.taskId || 'unknown'} emitted an error event`, severity: 'error', confidence: 0.98, actionAvailable: true }),
            })
        })

        // Wire scheduler to proactive messenger
        scheduler.setMessageSender(async (userId, channel, content) => {
            await proactive.send({
                userId,
                channel: channel as any,
                content,
                priority: 'normal',
                type: 'notification',
                assessment: assessmentFromEvent({ source: 'scheduler', summary: 'A persisted scheduled job reached its due time', severity: 'info', confidence: 1 }),
            })
        })

        // Load scheduled jobs from pattern store
        await scheduler.loadFromPatternStore()

        console.log(`[Nova] ✓ Proaktives Messaging aktiv (${proactive.getStats().channels.length} Channels)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Proaktives Messaging nicht verfügbar: ${err}`)
    }

    // Start Dashboard
    console.log('')
    if (!isNodeOnly) {
        await getChannelGateway().start('dashboard', config.dashboard, handleMessage, state)
    } else {
        console.log('[Nova] ⏭️ Dashboard übersprungen (NODE-ONLY Mode)')
    }

    // ============================================
    // REST API Server (server.enabled in xaventra.config.json)
    // ============================================
    const serverCfg = (config as any).server
    if (serverCfg?.enabled) {
        try {
            const { startRestApi } = await import('./server/rest-api.js')
            await startRestApi(
                { enabled: true, port: serverCfg.port ?? 18789, host: serverCfg.host ?? '127.0.0.1' },
                handleMessage,
                () => ({
                    version: (globalThis as any).__novaVersion || '?',
                    uptime: Math.round((Date.now() - state.startTime) / 1000),
                    provider: state.llm?.provider || 'unknown',
                    model: state.llm?.modelId || 'unknown',
                }),
            )
        } catch (err) {
            console.warn(`[Nova] REST API nicht verfügbar: ${err}`)
        }
    }

    // ============================================
    // Replay pending messages from last session (queue drain)
    // ============================================
    const pendingReplay = (state as any)._pendingReplayMessages as Array<{ id: string; chatId: string; from: string; content: string; channel: string }> | undefined
    if (pendingReplay && pendingReplay.length > 0) {
        console.log(`[Nova] 📬 ${pendingReplay.length} Replay-Nachricht(en) warten persistent auf runtimeReady`)
        void (async () => {
            try {
                const { awaitRuntimeReady } = await import('./core/runtime-readiness.js')
                await awaitRuntimeReady()
                const { markProcessing, markDone, incrementRetry, isMessageProcessable } = await import('./channels/message-queue.js')
                for (const pending of pendingReplay) {
                    if (!isMessageProcessable(pending.id)) continue
                    try {
                        markProcessing(pending.id)
                        await handleMessage(pending.channel, pending.from, pending.content, async (reply) => {
                            const tgAdapter = state.channels?.telegram
                            if (tgAdapter && pending.channel === 'Telegram') {
                                try { await (tgAdapter.send as any)({ to: pending.chatId, content: reply }) } catch { /* ignore */ }
                            }
                        })
                        markDone(pending.id)
                    } catch (err) {
                        console.log(`[Nova] ⚠ Replay failed for msg ${pending.id}: ${err}`)
                        incrementRetry(pending.id)
                    }
                }
            } catch (err) {
                console.log(`[Nova] ⚠ Message replay: ${err}`)
            }
        })()
        delete (state as any)._pendingReplayMessages
    }

    // Start L9 Idle Learning
    try {
        const { getIdleLearningManager } = await import('./layers/L9-idle-learning.js')
        const idleLearning = getIdleLearningManager()
        idleLearning.start()
        console.log('[Nova] ✓ L9 Idle Learning aktiv')

        // Bind the monitored learning service to L9.
        if (serviceModels.learning) {
            const { setInternalLLM: setL9LLM } = await import('./layers/L9-idle-learning.js')
            setL9LLM(serviceModels.learning)
        }
    } catch (err) {
        console.log(`[Nova] ⚠ L9 Idle Learning nicht verfügbar: ${err}`)
    }

    // Start L7 Correction Learning
    try {
        const { getCorrectionLearner, setInternalLLM: setL7LLM } = await import('./layers/L7-learning.js')
        const learner = getCorrectionLearner()
            ; (state as any).correctionLearner = learner
        if (serviceModels.learning) setL7LLM(serviceModels.learning)
        const stats = learner.getStats()
        console.log(`[Nova] ✓ L7 Correction Learning aktiv (${stats.totalCorrections} Korrekturen, ${stats.appliedCorrections} angewendet)`)
    } catch (err) {
        console.log(`[Nova] ⚠ L7 Learning nicht verfügbar: ${err}`)
    }

    // Start L8 Meta-Learning
    try {
        const { getMetaLearningSystem, setInternalLLM: setL8LLM } = await import('./layers/L8-meta-learning.js')
        const toolNames = state.tools?.getAll?.().map((tool: any) => tool.name) || []
        const meta = getMetaLearningSystem(toolNames)
            ; (state as any).metaLearning = meta
        if (serviceModels.learning) setL8LLM(serviceModels.learning)
        const skills = meta.getLearnedSkills()
        console.log(`[Nova] ✓ L8 Meta-Learning aktiv (${skills.length} gelernte Skills)`)
    } catch (err) {
        console.log(`[Nova] ⚠ L8 Meta-Learning nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L15 Self-Check (Proactive Self-Awareness)
    // ============================================
    try {
        const { getSelfCheckManager } = await import('./layers/L15-self-check.js')
        const selfCheck = getSelfCheckManager()

        // Start auto-check every 60 seconds
        selfCheck.startAutoCheck(60)

        // Listen for 'shouldAct' events - auto-fix via internal LLM
        selfCheck.on('shouldAct', async (result: { issues: string[]; suggestions: string[] }) => {
            console.log('[L15] ⚠️ Self-Check Issues detected:')
            result.issues.forEach(i => console.log(`  - ${i}`))

            // Use internal LLM to diagnose and attempt fix
            const doctor = {
                complete: async (_messages?: unknown) => {
                    const { diagnose } = await import('./intelligence/doctor-client.js')
                    const finding = await diagnose({
                        error: result.issues.join('\n'),
                        context: { suggestions: result.suggestions.join(' | '), source: 'L15-self-check' },
                    })
                    return { content: `${finding.diagnosis}\n${finding.fix}` }
                },
            }
            const llm = doctor
            if (result.issues.some(i =>
                i.toLowerCase().includes('critical') ||
                i.toLowerCase().includes('error') ||
                i.toLowerCase().includes('versagt') ||
                i.toLowerCase().includes('blockiere')
            )) {
                console.log('[L15] 🔧 Critical issue detected — asking internal LLM for diagnosis...')
                try {
                    const diagnosis = await llm.complete([
                        { role: 'system', content: 'Du bist Novas Self-Repair-Modul. Analysiere das Problem und gib eine KURZE Diagnose + konkreten Fix-Vorschlag. Max 3 Sätze.' },
                        { role: 'user', content: `Folgende Issues wurden erkannt:\n${result.issues.join('\n')}\n\nVorschläge:\n${result.suggestions.join('\n')}\n\nWas ist die wahrscheinlichste Ursache und was sollte Nova tun?` },
                    ])

                    const fix = diagnosis.content?.trim()
                    if (fix) {
                        console.log(`[L15] 🧠 LLM Diagnosis: ${fix}`)

                        // Log to journal for long-term learning
                        try {
                            const journal = (state as any).journal
                            if (journal) {
                                journal.recordEvent('self-repair', `Auto-Diagnose: ${fix.slice(0, 200)}`)
                            }
                        } catch { /* journal optional */ }

                        // If the issue is about a broken tool, try to disable/reset it
                        const toolIssue = result.issues.find(i => i.includes('Tool'))
                        if (toolIssue && state.tools) {
                            const toolMatch = toolIssue.match(/"([^"]+)"/)
                            if (toolMatch) {
                                console.log(`[L15] 🔄 Resetting tool failure counter for "${toolMatch[1]}"`)
                                const { reportToolSuccess } = await import('./layers/L15-self-check.js')
                                reportToolSuccess(toolMatch[1])
                            }
                        }

                        // If stuck (consecutive silences), log recovery action
                        if (result.issues.some(i => i.includes('leere Antworten'))) {
                            console.log('[L15] 🔄 Resetting silence counter after diagnosis')
                            selfCheck.responseGenerated(true) // Reset the counter
                        }
                    }
                } catch (err) {
                    console.log(`[L15] Auto-fix LLM call failed: ${err}`)
                }
            } else {
                console.log('[L15] 💡 Non-critical issues logged, monitoring...')
            }
        })

        console.log('[L15] ✓ Self-Check aktiv (internal only, no user spam)')

        // Bind the monitored repair service to L15.
        if (serviceModels.repair) {
            const { setInternalLLM: setL15LLM } = await import('./layers/L15-self-check.js')
            setL15LLM(serviceModels.repair)
        }

        // NOTE: L7 and L8 LLMs are wired in their own init blocks above (lines ~2099-2125)
    } catch (err) {
        console.log(`[Nova] ⚠ L15 Self-Check nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start Autonomy Loop (Check-Evaluate-Act)
    // ============================================
    try {
        // Record startTime for uptime tracking
        if ((globalThis as any).__novaState) {
            (globalThis as any).__novaState.startTime = Date.now()
        }

        const { startAutonomyLoop } = await import('./core/autonomy-loop.js')

        // Build the notification function — sends to admin via best available channel
        const notifyFn = async (message: string) => {
            const governed = (state as any).sendGovernedProactive
            if (governed) {
                await governed(message, 'autonomy-loop', 'warning', 0.9)
                return
            }
            // Fail closed until the fenced proactive path is ready.
            console.log(`[Autonomy] Governed notifier unavailable; notification retained in report: ${message.slice(0, 160)}`)
        }

        const autonomyCfg = (config as any).autonomy || {}
        const quietCfg = autonomyCfg.quietHours || {}
        const quietEnabled = quietCfg.enabled !== false // default: true

        await startAutonomyLoop(notifyFn, {
            intervalMinutes: autonomyCfg.intervalMinutes || 10,
            quietHoursStart: quietEnabled ? (quietCfg.start ?? 23) : -1,
            quietHoursEnd: quietEnabled ? (quietCfg.end ?? 7) : -1,
            maxNotificationsPerHour: autonomyCfg.selfThinkMaxPerHour || 3,
            socialCheckIns: autonomyCfg.socialCheckIns === true,
        })

        console.log(`[Nova] ✓ Autonomy Loop aktiv (alle ${autonomyCfg.intervalMinutes || 10}min, Quiet Hours: ${quietEnabled ? `${quietCfg.start ?? 23}:00-${quietCfg.end ?? 7}:00` : 'AUS'})`)

        // Wire self-thinking callback — Nova can now think autonomously
        try {
            const { setAutonomyThinkCallback } = await import('./core/autonomy-loop.js')
            setAutonomyThinkCallback(async (selfPrompt: string): Promise<string> => {
                // Resolve chatId for reply
                const replyTo = config.channels?.telegram?.allowFrom?.[0]
                    || state.channels.telegram?.getLastActiveChat?.()
                    || (globalThis as any).__novaState?.lastActiveChatId

                if (!replyTo) {
                    console.log('[Autonomy] 🧠 No chatId for self-think reply — skipping')
                    return ''
                }

                let capturedReply = ''
                const silentAutonomy = selfPrompt.startsWith('[SELF-GOAL]') || selfPrompt.startsWith('[SELF-DOCTOR]')

                // Content guard: block financially/transactionally sensitive content from being
                // proactively pushed to Telegram — even if the LLM ignores the system prompt.
                const isSafeToSend = (text: string): boolean => {
                    const blocked = [
                        /\b(kauf|verkauf|kaufen|verkaufen|bestell|bezahl|überweise|zahlung|transaktion)\b/i,
                        /\b(buy|sell|order|payment|transfer|transaction|checkout|purchase)\b/i,
                        /\b(login|passwort|password|credentials|secret|token)\b/i,
                        /\b(deploy|restart|shutdown|kill.*process)\b/i,
                        /GOAL_DONE:/i,   // internal marker — never user-facing
                    ]
                    return !blocked.some(re => re.test(text))
                }

                await handleMessage('Telegram', 'Nova-Autonomy', selfPrompt, async (reply) => {
                    capturedReply = reply   // capture for goal result validation
                    if (silentAutonomy) {
                        console.log(`[Autonomy] 🧠 Internal reply captured (${reply.length} chars, not sent)`)
                        return
                    }
                    if (!isSafeToSend(reply)) {
                        console.warn(`[Autonomy] 🚫 Self-think reply blocked by content filter (${reply.slice(0, 80)})`)
                        return
                    }
                    try {
                        const governed = (state as any).sendGovernedProactive
                        if (typeof governed === 'function') {
                            await governed(reply, 'self-thinking', 'info', 0.85)
                        } else {
                            console.log('[Autonomy] Self-think reply retained: governed notifier unavailable')
                        }
                    } catch (err) {
                        console.error(`[Autonomy] 🧠 Reply send failed: ${err}`)
                    }
                })
                return capturedReply
            })
            console.log('[Nova] ✓ Self-Thinking aktiv (autonome Pipeline-Injection)')
        } catch (err) {
            console.log(`[Nova] ⚠ Self-Think Callback nicht verfügbar: ${err}`)
        }

        // === Mission Engine (Autonomous Task Chaining) ===
        try {
            const { initMissionEngine } = await import('./core/autonomous-executor.js')
            initMissionEngine({
                handleMessage: async (ch: string, from: string, content: string, replyFn: (msg: string) => Promise<void>, st: any) => {
                    return _handleMessage(ch, from, content, replyFn, st || state as any, handleCommand)
                },
                notifyFn,
                llm: state.llm,
                state: state as any,
            })
            console.log('[Nova] ✓ Mission Engine aktiv (autonome Task-Chains bereit)')
        } catch (err) {
            console.log(`[Nova] ⚠ Mission Engine nicht verfügbar: ${err}`)
        }

    } catch (err) {
        console.log(`[Nova] ⚠ Autonomy Loop nicht verfügbar: ${err}`)
    }

    // Start Learning Hub immediately (fetch shared knowledge from other Novas)
    try {
        const { startLearningSync, fetchSharedKnowledge } = await import('./intelligence/learning-hub.js')

        // Fetch immediately on startup
        const knowledge = await fetchSharedKnowledge()
        if (knowledge.size > 0) {
            console.log(`[Nova] ✓ Learning Hub: ${knowledge.size} Topics vom Kollektiv geladen`)
        } else {
            console.log('[Nova] ✓ Learning Hub: Verbunden (noch keine Topics im Kollektiv)')
        }

        // Start background sync every 30 min
        startLearningSync(30)
    } catch (err) {
        console.log(`[Nova] ⚠ Learning Hub nicht verfügbar: ${err}`)
    }

    // Register in Nova Mesh Network (auto-discovery)
    try {
        const { registerNode, startTaskPoller } = await import('./mesh/mesh-registry.js')
        const { ALL_TOOLS } = await import('./tools/complete-registry.js')
        await registerNode(ALL_TOOLS.length)
        startTaskPoller()
        const { startCapabilityGraphSync } = await import('./mesh/capability-graph-sync.js')
        startCapabilityGraphSync()
        startMeshDataPlane()
        console.log(`[Nova] ✓ Mesh Registry: Node registriert (${ALL_TOOLS.length} Tools) + Task Poller aktiv`)
    } catch (err) {
        console.log(`[Nova] ⚠ Mesh Registry nicht verfügbar: ${err}`)
    }

    // Release and native mission recovery follow the same fenced Main lease as
    // Telegram. A worker may watch for takeover, but cannot publish or deploy
    // until it owns nova-main. This also lets a promoted Spark resume a signed
    // rollout whose checkpoint and artifact are already present there.
    try {
        const updateConfig = (config as any).mesh?.update
        const {
            MAIN_SERVICE, shouldStartExclusiveService, watchForServiceLeadership,
            onLeadershipLost,
        } = await import('./mesh/leader-election.js')
        const withControlPlaneTimeout = async <T>(label: string, operation: Promise<T>, timeoutMs = 12_000): Promise<T> => {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
                return await Promise.race([
                    operation,
                    new Promise<T>((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
                        timer.unref?.()
                    }),
                ])
            } finally {
                if (timer) clearTimeout(timer)
            }
        }
        const activateMainControlPlane = async (): Promise<void> => {
            console.log('[Nova] Main-Control-Plane activation started')
            // Mission recovery is safety-critical and must not wait behind
            // optional ledger, release, or Codex hydration.
            const { startMissionRecoveryWatcher: startNativeMissionRecovery } = await import('./core/autonomous-executor.js')
            startNativeMissionRecovery()
            console.log('[Nova] Native Mission-Recovery-Watcher active')
            try {
                const { getSessionContinuityStore } = await import('./memory/session-summarizer.js')
                const hydratedContinuity = await withControlPlaneTimeout(
                    'Session continuity hydration',
                    getSessionContinuityStore().hydrateShared(),
                )
                if (hydratedContinuity > 0) {
                    console.log(`[Nova] HA Session-Kontinuität hydriert: ${hydratedContinuity} Profile`)
                }
                const { getWorkflowEpisodeStore } = await import('./memory/workflow-episode-store.js')
                const hydratedEpisodes = await withControlPlaneTimeout(
                    'Workflow episode hydration',
                    getWorkflowEpisodeStore().hydrateShared(),
                )
                if (hydratedEpisodes > 0) {
                    console.log(`[Nova] HA Workflow-Episoden hydriert: ${hydratedEpisodes}`)
                }
                const { hydrateOutcomeLedgerFromHa } = await import('./core/outcome-ledger.js')
                const hydratedOutcomes = await withControlPlaneTimeout('Outcome Ledger hydration', hydrateOutcomeLedgerFromHa())
                if (hydratedOutcomes.events || hydratedOutcomes.checkpoints) {
                    console.log(`[Nova] HA Outcome Ledger hydriert: ${hydratedOutcomes.events} Events, ${hydratedOutcomes.checkpoints} Checkpoints`)
                }
                const { hydrateUpdateCheckpointFromMesh, startUpdateChecker } = await import('./core/auto-updater.js')
                if (updateConfig?.enabled) {
                    await withControlPlaneTimeout('Release checkpoint hydration', hydrateUpdateCheckpointFromMesh())
                    startUpdateChecker(updateConfig, message => {
                        console.log(`[MeshUpdate] ${message}`)
                        void (state as any).sendGovernedProactive?.(
                            message, 'mesh-updater', 'warning', 0.99, `mesh-update:${message}`,
                        ).catch(() => undefined)
                    })
                    console.log(`[Nova] ✓ Fenced Mesh Release Updater aktiv (${updateConfig.nodes?.length || 0} Nodes)`)
                }
                const continuityOwner = (config as any).channels?.telegram?.allowFrom?.[0]
                if ((config as any).codex?.enabled && continuityOwner) {
                    const { syncCapabilityGraphOnce } = await import('./mesh/capability-graph-sync.js')
                    await syncCapabilityGraphOnce().catch(() => undefined)
                    const { startCodexContinuityMonitor } = await import('./auth/codex-continuity.js')
                    const { resolvePrincipalId } = await import('./users/principal-id.js')
                    startCodexContinuityMonitor({
                        principalId: resolvePrincipalId(config as any, 'telegram', String(continuityOwner)),
                        config: (config as any).codex,
                        send: (content, severity, dedupeKey) => (state as any).sendGovernedProactive(
                            content, 'codex-continuity', severity, 0.99, dedupeKey,
                        ),
                    })
                    console.log('[Nova] ✓ Codex Continuity Monitor aktiv (User × Node → vLLM)')
                }
            } catch (error) {
                console.log(`[Nova] ⚠ Main-Control-Plane konnte nicht aktiviert werden: ${error}`)
            }
        }
        onLeadershipLost(MAIN_SERVICE, async () => {
            const { stopUpdateChecker } = await import('./core/auto-updater.js')
            stopUpdateChecker()
            const { stopCodexContinuityMonitor } = await import('./auth/codex-continuity.js')
            stopCodexContinuityMonitor()
            const { suspendMissionForLeadershipLoss } = await import('./core/autonomous-executor.js')
            suspendMissionForLeadershipLoss()
            console.warn('[Nova] Main-Lease verloren: Release-Autorität gestoppt')
            watchForServiceLeadership(MAIN_SERVICE, activateMainControlPlane)
        })
        if (await shouldStartExclusiveService(MAIN_SERVICE)) await activateMainControlPlane()
        else watchForServiceLeadership(MAIN_SERVICE, activateMainControlPlane)

        const preferStrongestMain = (config as any).mesh?.preferStrongestMain === true
            || process.env.NOVA_PREFER_STRONGEST_MAIN === 'true'
        if (preferStrongestMain) {
            const evaluatePlannedHandover = async (): Promise<void> => {
                const { yieldMainToPreferredIfSafe } = await import('./mesh/leader-election.js')
                const decision = await yieldMainToPreferredIfSafe(async () => {
                    const { getUpdateStatus } = await import('./core/auto-updater.js')
                    if (getUpdateStatus().running) return false
                    const { getMissionData } = await import('./core/autonomous-executor.js')
                    const mission = getMissionData().active
                    if (mission && ['planning', 'active'].includes(mission.status)) return false
                    const { getOutcomeLedger } = await import('./core/outcome-ledger.js')
                    const ledger = getOutcomeLedger()
                    ledger.failStaleRuns()
                    return !ledger.listRuns(200).some(run => run.status === 'running')
                })
                if (!decision.leader && decision.reason !== 'local node is not Main') {
                    console.log(`[Nova] Planned Main handover: ${decision.reason}`)
                }
            }
            const handoverTimer = setInterval(() => { void evaluatePlannedHandover().catch(() => undefined) }, 30_000)
            handoverTimer.unref?.()
            setTimeout(() => { void evaluatePlannedHandover().catch(() => undefined) }, 45_000).unref?.()
            console.log('[Nova] ✓ Leistungsbasierter Main-Handover aktiv')
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Fenced Main-Control-Plane nicht verfügbar: ${err}`)
    }

    // AI Service Discovery — runs in background, does NOT block startup
    // (SSH mesh scanning takes 20+ seconds — blocking this delays all layer init)
    setTimeout(async () => {
        try {
            const { scanAllAIServices, startPeriodicScan } = await import('./mesh/ai-scanner.js')
            const scanResult = await scanAllAIServices({ skipMesh: false })
            startPeriodicScan(5 * 60 * 1000)
            console.log(`[Nova] ✓ AI Scanner: ${scanResult.services.filter((s: any) => s.status === 'running').length} running, ${scanResult.services.filter((s: any) => s.status !== 'running').length} installed`)
        } catch (err) {
            console.log(`[Nova] ⚠ AI Scanner nicht verfügbar: ${err}`)
        }
    }, 8_000)

    try {
        const { startBenchmarkSchedule } = await import('./benchmark/nova-benchmark-runner.js')
        startBenchmarkSchedule()
        if (process.env.NOVA_BENCHMARK_AUTO === '1') console.log('[Nova] ✓ Benchmark Lab: weekly smoke schedule active')
    } catch (err) {
        console.log(`[Nova] ⚠ Benchmark schedule unavailable: ${err}`)
    }

    // Start L(-1) Supervisor
    try {
        const { getSupervisor } = await import('./supervisor/supervisor-manager.js')
        const supervisor = getSupervisor({ autoFix: false })  // Manual approval by default
        supervisor.start()
        console.log('[Nova] ✓ L(-1) Supervisor aktiv (Manual Mode)')
    } catch (err) {
        console.log(`[Nova] ⚠ Supervisor nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L6 Cold Storage (USER.md + MEMORY.md)
    // ============================================
    try {
        const { ensureColdStorage } = await import('./layers/L6-cold-storage.js')
        ensureColdStorage()
        console.log('[Nova] ✓ L6 Cold Storage aktiv (USER.md + MEMORY.md)')
    } catch (err) {
        console.log(`[Nova] ⚠ L6 Cold Storage nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L6 Memory (LanceDB Vector Memory)
    // ============================================
    try {
        const lanceMemory = await import('./memory/lancedb-memory.js')
        await lanceMemory.default.ensureInitialized()
            ; (state as any).lanceMemory = lanceMemory.default
        const stats = await lanceMemory.default.getStats()
        console.log(`[Nova] ✓ L6 LanceDB Memory aktiv (${stats.totalEntries} Einträge)`)
    } catch (err) {
        console.log(`[Nova] ⚠ L6 LanceDB Memory nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start GraphRAG Knowledge Graph
    // ============================================
    try {
        const knowledgeGraph = await import('./memory/knowledge-graph.js')
        knowledgeGraph.default.initKnowledgeGraph()
        if (serviceModels.learning) {
            knowledgeGraph.default.setInternalLLM(serviceModels.learning)
        }
        ; (state as any).knowledgeGraph = knowledgeGraph.default
        const gStats = knowledgeGraph.default.getStats()
        console.log(`[Nova] ✓ GraphRAG aktiv (${gStats.nodes} Nodes, ${gStats.edges} Edges)`)
    } catch (err) {
        console.log(`[Nova] ⚠ GraphRAG nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start Journal (Episodic Memory)
    // ============================================
    try {
        const journal = await import('./memory/journal.js')
        journal.default.initJournal()
        if (serviceModels.learning) {
            journal.default.setInternalLLM(serviceModels.learning)
        }
        ; (state as any).journal = journal.default
        journal.default.recordEvent('system', 'Nova gestartet')
        console.log(`[Nova] ✓ Journal aktiv (Episodisches Gedächtnis)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Journal nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start Memory Distiller (Nightly 02:00 AM)
    // ============================================
    try {
        const { initMemoryDistiller, setDistillerLlm } = await import('./layers/memory-distiller.js')
        if (serviceModels.learning) setDistillerLlm(serviceModels.learning)
        await initMemoryDistiller(() => serviceModels.learning)
    } catch (err) {
        console.log(`[Nova] ⚠ Memory Distiller nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start Resilience Manager (Self-Healing Layer)
    // ============================================
    try {
        const { createResilienceManager } = await import('./resilience/manager.js')
        const resilience = createResilienceManager()
        resilience.start()
            ; (state as any).resilience = resilience

        // Mark healthy components (uses ErrorCategory types)
        // Note: constructor already inits auth, llm, memory, channels, learning
        if (state.llm) resilience.reportSuccess('llm')
        if (state.channels.telegram) resilience.reportSuccess('channel')
        if ((state as any).lanceMemory) resilience.reportSuccess('memory')

        const health = resilience.getHealthStatus()
        console.log(`[Nova] ✓ Resilience Manager aktiv (Status: ${health.overall}, ${Object.keys(health.components).length} Components)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Resilience Manager nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L10 Vision (Screenshot + UI Analysis)
    // ============================================
    try {
        const { getVisionAnalyzer } = await import('./layers/L10-vision.js')
        const vision = getVisionAnalyzer()
            ; (state as any).vision = vision
        console.log('[Nova] ✓ L10 Vision aktiv (Screenshot + UI-Analyse)')
    } catch (err) {
        console.log(`[Nova] ⚠ L10 Vision nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L12 Anti-Hallucination Guard
    // ============================================
    try {
        const antiHalluc = await import('./layers/L12-anti-hallucination.js')
            ; (state as any).antiHallucination = antiHalluc.default

        // Wire internal LLM for deep fact-checking
        if (serviceModels.repair) {
            antiHalluc.setInternalLLM(serviceModels.repair)
        }

        console.log('[Nova] ✓ L12 Anti-Hallucination Guard aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ L12 Anti-Hallucination nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L13 AST Analyzer (Code Impact Analysis)
    // ============================================
    try {
        const { getASTAnalyzer } = await import('./layers/L13-ast-analyzer.js')
        const ast = getASTAnalyzer()
            ; (state as any).astAnalyzer = ast
        console.log('[Nova] ✓ L13 AST Analyzer aktiv (Code-Impact-Analyse)')
    } catch (err) {
        console.log(`[Nova] ⚠ L13 AST Analyzer nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L14 Cost Tracker (Token & Budget)
    // ============================================
    try {
        const { getCostTracker } = await import('./layers/L14-cost-tracker.js')
        const costTracker = getCostTracker()
            ; (state as any).costTracker = costTracker
        console.log('[Nova] ✓ L14 Cost Tracker aktiv (Token-Budget-Tracking)')
    } catch (err) {
        console.log(`[Nova] ⚠ L14 Cost Tracker nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L16 Business Sense (Requirement Clarification)
    // ============================================
    try {
        const { getBusinessSenseAnalyzer } = await import('./layers/L16-business-sense.js')
        const bizSense = getBusinessSenseAnalyzer()
            ; (state as any).businessSense = bizSense
        console.log('[Nova] ✓ L16 Business Sense aktiv (Requirement-Klärung)')

        // Bind the monitored learning service to L16.
        if (serviceModels.learning) {
            const { setInternalLLM: setL16LLM } = await import('./layers/L16-business-sense.js')
            setL16LLM(serviceModels.learning)
        }
    } catch (err) {
        console.log(`[Nova] ⚠ L16 Business Sense nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L17 Autonomous Learning
    // ============================================
    try {
        const { getLearner, setInternalLLM } = await import('./layers/L17-autonomous-learning.js')
        const autoLearner = getLearner()
            ; (state as any).autonomousLearner = autoLearner
        if (serviceModels.learning) {
            setInternalLLM(serviceModels.learning)
        }
        console.log('[Nova] ✓ L17 Autonomous Learning aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ L17 Autonomous Learning nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L15 Security Scanner
    // ============================================
    try {
        const { getSecurityScanner } = await import('./layers/L15-security-scanner.js')
        const secScanner = getSecurityScanner()
            ; (state as any).securityScanner = secScanner
        console.log('[Nova] ✓ L15 Security Scanner aktiv (OWASP Checks)')
    } catch (err) {
        console.log(`[Nova] ⚠ L15 Security Scanner nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L19 Service Monitoring
    // ============================================
    try {
        const { getServiceMonitor } = await import('./layers/L19-monitoring.js')
        const monitor = getServiceMonitor()
            ; (state as any).serviceMonitor = monitor

        // Wire alerts to the fenced proactive channel.
        if (state.channels.telegram) {
            monitor.setAlertCallback(async (target, status) => {
                const msg = status === 'down'
                    ? `🚨 *ALERT: ${target.name} ist DOWN!*\n\nURL: ${target.url}\nSeit: ${target.downSince ? new Date(target.downSince).toLocaleString('de-DE') : 'jetzt'}\nFehlversuche: ${target.consecutiveFailures}`
                    : `✅ *RECOVERED: ${target.name} ist wieder ONLINE!*\n\nURL: ${target.url}`
                try {
                    const governed = (state as any).sendGovernedProactive
                    if (typeof governed !== 'function') throw new Error('governed notifier unavailable')
                    await governed(
                        msg,
                        'service-monitor',
                        status === 'down' ? 'error' : 'info',
                        0.98,
                        `service:${target.name}:${status}`,
                    )
                } catch {
                    console.log(`[L19] Alert could not be sent: ${msg.slice(0, 100)}`)
                }
            })
        }

        monitor.start()
        console.log('[Nova] ✓ L19 Service Monitoring aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ L19 Monitoring nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L21 Cross-Node Health Monitor
    // ============================================
    try {
        const { getNodeHealthMonitor } = await import('./layers/L21-node-health.js')
        const nodeHealth = getNodeHealthMonitor()
            ; (state as any).nodeHealth = nodeHealth

        // Wire alerts to Telegram proactive messaging
        if (state.channels.telegram) {
            nodeHealth.setAlertCallback(async (message: string) => {
                try {
                    await (state as any).sendGovernedProactive?.(message, 'node-health', 'error', 0.98)
                } catch {
                    console.log(`[L21] Alert could not be sent: ${message.slice(0, 100)}`)
                }
            })
        }

        nodeHealth.start()
        console.log('[Nova] ✓ L21 Node Health Monitor aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ L21 Node Health nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L22 Federated Memory (Knowledge Graph Sync)
    // ============================================
    try {
        const { initFederatedMemory } = await import('./layers/L22-federated-memory.js')
        initFederatedMemory()
        console.log('[Nova] ✓ L22 Federated Memory aktiv (KG/Supabase Sync)')
    } catch (err) {
        console.log(`[Nova] ⚠ L22 Federated Memory nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L20 Self-Improvement Loop
    // ============================================
    try {
        const { getSelfImprovementEngine, setInternalLLM: setL20LLM } = await import('./layers/L20-self-improvement.js')
        const selfImprove = getSelfImprovementEngine()
            ; (state as any).selfImprovement = selfImprove
        if (serviceModels.learning) setL20LLM(serviceModels.learning)
        selfImprove.start()
        console.log('[Nova] ✓ L20 Self-Improvement Loop aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ L20 Self-Improvement nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L0 Tool Auto-Repair (Self-Healing Tools)
    // ============================================
    try {
        const { getToolAutoRepairEngine } = await import('./layers/L0-tool-autorepair.js')
        const autoRepair = getToolAutoRepairEngine()
            ; (state as any).toolAutoRepair = autoRepair
        console.log('[Nova] ✓ L0 Tool Auto-Repair aktiv')
    } catch (err) {
        console.log(`[Nova] ⚠ L0 Tool Auto-Repair nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L8 Sub-Agent (Google Fallback + Safety)
    // ============================================
    try {
        const { default: subAgentModule } = await import('./layers/L8-sub-agent.js')
            ; (state as any).subAgent = subAgentModule
        console.log('[Nova] ✓ L8 Sub-Agent aktiv (Google-Fallback + Safety Guards)')
    } catch (err) {
        console.log(`[Nova] ⚠ L8 Sub-Agent nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L8 Prisma Guards (Database Safety)
    // ============================================
    try {
        const prismaGuards = await import('./layers/L8-prisma-guards.js')
            ; (state as any).prismaGuards = prismaGuards.default
        console.log('[Nova] ✓ L8 Prisma Guards aktiv (DB-Sicherheit)')
    } catch (err) {
        console.log(`[Nova] ⚠ L8 Prisma Guards nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L11 Project Manager (Workspace-aware)
    // ============================================
    try {
        const { getProjectManager } = await import('./layers/L11-project-manager.js')
        const projManager = getProjectManager()
            ; (state as any).projectManager = projManager
        const projects = projManager.getAllProjects()
        console.log(`[Nova] ✓ L11 Project Manager aktiv (${projects.length} Projekte)`)
    } catch (err) {
        console.log(`[Nova] ⚠ L11 Project Manager nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start L12 QA Agent (TDD Test Generation)
    // ============================================
    try {
        const { getQAAgent } = await import('./layers/L12-qa-agent.js')
        const qa = getQAAgent()
            ; (state as any).qaAgent = qa
        console.log(`[Nova] ✓ L12 QA Agent aktiv (Framework: ${qa.detectFramework()})`)
    } catch (err) {
        console.log(`[Nova] ⚠ L12 QA Agent nicht verfügbar: ${err}`)
    }

    // ============================================
    // L18 LLM Router — already configured dynamically from discovery at startup
    // ============================================
    try {
        const { getModelStats } = await import('./layers/L18-llm-router.js')
            ; (state as any).llmRouter = { getModelStats }
        const stats = getModelStats()
        console.log(`[Nova] ✓ L18 LLM Router aktiv (${Object.keys(stats).length} Models tracked)`)
    } catch (err) {
        console.log(`[Nova] ⚠ L18 LLM Router nicht verfügbar: ${err}`)
    }

    // ============================================
    // Start Autonomy Engine (Self-Goals, Insights, Memory Consolidation)
    // ============================================
    try {
        const autonomy = await import('./intelligence/autonomy-engine.js')
        if (serviceModels.learning) autonomy.setInternalLLM(serviceModels.learning)
        autonomy.startAll()
            ; (state as any).autonomy = {
                goals: autonomy.getSelfGoalEngine(),
                insights: autonomy.getInsightEngine(),
                consolidation: autonomy.getMemoryConsolidator(),
            }

        // Wire L19 monitoring alerts to insight engine
        const insightEngine = autonomy.getInsightEngine()
        const monitor = (state as any).serviceMonitor
        if (monitor) {
            const originalCallback = monitor.alertCallback
            monitor.setAlertCallback(async (target: any, status: string) => {
                // Forward to insight engine
                insightEngine.recordInsight(
                    status === 'down' ? 'warning' : 'observation',
                    status === 'down'
                        ? `Service "${target.name}" ist offline seit ${new Date().toLocaleTimeString('de-DE')}`
                        : `Service "${target.name}" ist wieder online`
                )
                // Also call original callback
                if (originalCallback) await originalCallback(target, status)
            })
        }

        // Wire L21 node health alerts to insight engine
        const nodeHealth = (state as any).nodeHealth
        if (nodeHealth) {
            const origHealthAlert = nodeHealth.alertCallback
            nodeHealth.setAlertCallback(async (message: string) => {
                insightEngine.recordInsight('warning', message.replace(/\*/g, '').slice(0, 200))
                if (origHealthAlert) await origHealthAlert(message)
            })
        }

        // === FEATURE 5: Wire insight delivery to Telegram ===
        if (state.channels.telegram) {
            insightEngine.setSendFunction(async (userId: string, channel: string, content: string) => {
                try {
                    const { isInternalOutboundArtifact } = await import('./core/outbound-content-guard.js')
                    if (isInternalOutboundArtifact(content)) {
                        console.log('[Insights] Internal planner/reasoning artifact suppressed')
                        return
                    }
                    await (state as any).sendGovernedProactive?.(content, 'insight-engine', 'info', 0.9)
                } catch (err) {
                    console.log(`[Insights] Delivery failed: ${err}`)
                }
            })
            console.log('[Nova] ✓ Insight Delivery → Telegram aktiv')
        }

        const goalStats = autonomy.getSelfGoalEngine().getStats()
        const consStats = autonomy.getMemoryConsolidator().getStats()
        console.log(`[Nova] ✓ Autonomy Engine aktiv (${goalStats.pending} Goals pending, ${consStats.totalConsolidations} Consolidations)`)
    } catch (err) {
        console.log(`[Nova] ⚠ Autonomy Engine nicht verfügbar: ${err}`)
    }

    // ============================================
    // Pre-initialize Intelligence Modules (Faster First Request)
    // ============================================
    try {
        const [entityExtractor, taskPlanner, toolChainer, selfReflection, proactiveSuggestions] = await Promise.all([
            import('./intelligence/entity-extractor.js'),
            import('./intelligence/task-planner.js'),
            import('./intelligence/tool-chainer.js'),
            import('./intelligence/self-reflection.js'),
            import('./intelligence/proactive-suggestions.js'),
        ])
            ; (state as any).intelligence = {
                entityExtractor: entityExtractor.default,
                taskPlanner: taskPlanner.default,
                toolChainer: toolChainer.default,
                selfReflection: selfReflection.default,
                proactiveSuggestions: proactiveSuggestions.default,
            }
        console.log('[Nova] ✓ Intelligence Module vorgeladen (5 Module)')
    } catch (err) {
        console.log(`[Nova] ⚠ Intelligence Pre-Load nicht verfügbar: ${err}`)
    }

    // ============================================
    // nova Module Integration
    // ============================================
    try {
        const { initAllnovaModules } = await import('./integration/nova-integration.js')
        await initAllnovaModules()
    } catch (err) {
        console.log(`[Nova] ⚠ nova-Integration nicht verfügbar: ${err}`)
    }

    // Mark as running
    state.running = true
    state.runtimeReady = true
    const { markRuntimeReady } = await import('./core/runtime-readiness.js')
    markRuntimeReady()
    ;(state as any).startupPerformance = markStartupReady()

    // ============================================
    // Startup Health Report (Feature 2)
    // ============================================
    // Send a single Telegram message summarizing system state after boot
    setTimeout(async () => {
        try {
            const { getNodeHealthMonitor } = await import('./layers/L21-node-health.js')
            const nodeHealth = getNodeHealthMonitor()
            const snapshots = await nodeHealth.checkAllNodes()

            const { availableLLMs } = await import('./core/llm-factory.js')
            // Show the ACTUAL active model (config primary), not availableLLMs[0]
            // which is just the first discovered model (was wrongly showing M2.7).
            const currentModel = state.llm?.modelId
                || (state as any).config?.model
                || availableLLMs[0]?.model
                || 'auto'

            const now = new Date().toLocaleString('de-DE', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna'
            })

            // Determine dashboard URL with local LAN IP for remote access
            let dashboardUrl = `http://localhost:${(state as any).config?.dashboard?.port || 3001}`
            try {
                const { networkInterfaces } = await import('node:os')
                const nets = networkInterfaces()
                for (const iface of Object.values(nets)) {
                    for (const net of (iface || [])) {
                        if (net.family === 'IPv4' && !net.internal) {
                            dashboardUrl = `http://${net.address}:${(state as any).config?.dashboard?.port || 3001}`
                            break
                        }
                    }
                    if (!dashboardUrl.includes('localhost')) break
                }
            } catch { /* use localhost fallback */ }

            const lines = [
                '✨ *Nova Online!*',
                '',
                `📦 Version: \`${(globalThis as any).__novaVersion || 'unknown'}\``,
                `🤖 Aktives Modell: \`${currentModel}\``,
                `🕐 Gestartet: ${now}`,
                `📦 ${availableLLMs.length} Models verfügbar`,
                `🌐 Dashboard: ${dashboardUrl}`,
                '',
            ]

            // Offline-duration warning
            const offlineMs = (state as any)._offlineDurationMs || 0
            if (offlineMs > 0) {
                const offlineH = offlineMs / 1000 / 60 / 60
                if (offlineH >= 24) {
                    const days = Math.floor(offlineH / 24)
                    const hrs = Math.floor(offlineH % 24)
                    lines.push(`⚠️ *Ich war ${days}d ${hrs}h offline.*`)
                    lines.push('Telegram puffert Nachrichten nur 24h — ältere Nachrichten sind leider verloren.')
                    lines.push('Falls du mir etwas Wichtiges geschrieben hast, bitte nochmal senden! 🙏')
                    lines.push('')
                } else if (offlineH >= 1) {
                    const hrs = Math.round(offlineH * 10) / 10
                    lines.push(`ℹ️ War ${hrs}h offline — alle Nachrichten wurden von Telegram gepuffert ✅`)
                    lines.push('')
                }
            }

            // The startup report is an operational view, not a host/service dump.
            // Only nodes with a fresh Nova heartbeat belong here. A reachable
            // Relay, Witness or vLLM endpoint must not turn its host into a node.
            const { discoverNodes } = await import('./mesh/mesh-registry.js')
            const activeRegistryNodes = await discoverNodes({ activeOnly: true })
            const activeNodeKeys = new Set(activeRegistryNodes.flatMap(node => [
                node.node_id, node.hostname, node.ip,
            ].filter(Boolean).map(value => String(value).toLowerCase())))
            const activeSnapshots = snapshots.filter(snapshot => {
                const host = String(snapshot.host || '').toLowerCase().split('@').pop() || ''
                const registered = activeNodeKeys.has(String(snapshot.name || '').toLowerCase()) || activeNodeKeys.has(host)
                return registered && (snapshot.online || snapshot.reachability === 'degraded')
            })
            if (activeSnapshots.length > 0) {
                lines.push('📡 *Node-Status:*')
                for (const s of activeSnapshots) {
                    const degraded = s.reachability === 'degraded'
                    const unreachable = !s.online && s.reachability === 'unreachable'
                    const icon = degraded ? '🟡' : s.online ? (s.daemonRunning === false ? '🟡' : '🟢') : unreachable ? '⚪' : '🔴'
                    const temp = s.temperature ? ` | ${s.temperature}°C` : ''
                    const mem = s.memory ? ` | RAM ${s.memory.usedPercent}%` : ''
                    const disk = s.disk ? ` | Disk ${s.disk.usedPercent}%` : ''
                    const label = degraded ? 'Dienste online, SSH gestört' : s.online ? 'Online' : unreachable ? 'Status unbekannt' : 'Offline'
                    lines.push(`${icon} ${s.name}: ${label}${temp}${mem}${disk}`)
                    if (unreachable && s.connectionError) lines.push(`   ⚠️ ${s.connectionError}`)
                    if (s.warnings.length > 0) {
                        lines.push(`   ⚠️ ${s.warnings.join(', ')}`)
                    }
                }
            } else {
                lines.push('📡 Keine aktiven Worker-Nodes')
            }

            // Resolve the adapter only to suppress an unsolicited card once a
            // conversation has started. Delivery itself remains governed.
            const adapter = state.channels.telegram as any
            // Polling starts before this delayed report so offline Telegram
            // messages can be replayed immediately. Never interleave the
            // unsolicited boot card with a conversation that already started.
            if (adapter?.getLastActiveChat?.()) {
                console.log('[Nova] Startup Health Report übersprungen — Telegram-Konversation bereits aktiv')
                return
            }
            const governed = (state as any).sendGovernedProactive
            if (typeof governed === 'function') {
                const sent = await governed(
                    lines.join('\n'),
                    'startup-health',
                    'info',
                    0.99,
                    `startup-health:${(state as any).startTime || 'current'}`,
                )
                console.log(`[Nova] ${sent ? '✓ Startup Health Report governed gesendet' : 'Startup Health Report durch Policy unterdrückt'}`)
            } else {
                console.log('[Nova] Startup Report: governed notifier unavailable')
            }
        } catch (err) {
            console.log(`[Nova] ⚠ Startup Report failed: ${err}`)
        }
    }, 15000)  // Wait 15s for all nodes to boot

    // ============================================
    // Initialize Voice Pipeline (Jarvis Mode)
    // ============================================
    try {
        const voiceConfig = (state as any).config?.voice
        if (voiceConfig?.enabled) {
            // Self-Setup: non-blocking — voice dep check takes 5-6s, don't hold up startup
            const { ensureVoiceDeps } = await import('./voice/voice-setup.js')
            const setup = await new Promise<any>(resolve =>
                setTimeout(() => ensureVoiceDeps({ installMissing: voiceConfig.autoInstallDeps === true }).then(resolve).catch(() => resolve({ ok: false, failed: ['async-timeout'] })), 0)
            )
            if (!setup.ok) {
                console.log(`[Nova] ⚠ Voice-Setup unvollständig (${setup.failed.join(', ')}) — Voice deaktiviert`)
            } else {

            const { initVoicePipeline, startListening } = await import('./voice/wake-word.js')
            initVoicePipeline({
                wakeWord: voiceConfig.wakeWord || 'hey nova',
                sttEngine: voiceConfig.sttEngine || 'faster-whisper',
                whisperModel: voiceConfig.whisperModel || 'large-v3-turbo',
                ttsEngine: voiceConfig.ttsEngine || 'edge-tts',
                ttsVoice: voiceConfig.ttsVoice || 'de-DE-ConradNeural',
                language: voiceConfig.language || 'de',
                lmStudioUrl: voiceConfig.lmStudioUrl,
            })
            startListening(
                async (text: string) => {
                    let reply = ''
                    await handleMessage('voice', 'local', text, async (msg) => { reply = msg })
                    return reply || 'Ich habe dich gehört.'
                },
                (voiceState) => console.log(`[Voice] 🎙 Status: ${voiceState}`)
            )
            console.log('[Nova] ✓ Voice Pipeline aktiv (wake: "hey nova")')
            } // end setup.ok
        }
    } catch (err) {
        console.log(`[Nova] ⚠ Voice Pipeline nicht verfügbar: ${err}`)
    }

    console.log('')
    console.log('═══════════════════════════════════════════════════════')
    console.log('[Nova] ✨ Daemon läuft! Ctrl+C zum Beenden.')
    console.log('═══════════════════════════════════════════════════════')
    console.log('')

    // ============================================
    // Graceful Shutdown — persist state before exit
    // ============================================
    let shuttingDown = false
    const shutdown = async (signal: string) => {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`\n[Nova] ${signal} empfangen — Graceful Shutdown...`)
        state.running = false

        // Flush AutoObserver facts to disk
        try {
            const { getAutoObserver } = await import('./memory/auto-observer.js')
            getAutoObserver().saveToDisk()
            console.log('[Nova] ✓ Observer-Facts gespeichert')
        } catch { /* non-critical */ }

        // Flush LanceDB
        try {
            const lm = (state as any).lanceMemory
            if (lm?.close) await lm.close()
            console.log('[Nova] ✓ LanceDB geschlossen')
        } catch { /* non-critical */ }

        // Stop Voice Pipeline
        try {
            const { stopListening } = await import('./voice/wake-word.js')
            stopListening()
        } catch { /* non-critical */ }

        // Stop LearningEngine
        ;(state as any).learningCoordinator?.stop?.()

        // Stop signed mesh listeners, pollers and outbox retries before exit.
        try {
            await stopMeshTransportRuntime()
            console.log('[Nova] Mesh-Transport gestoppt')
        } catch { /* non-critical */ }

        // Dispose Nova Doctor llama engine
        try {
            const { disposeLlamaEngine } = await import('./llm/llama-engine.js')
            await disposeLlamaEngine()
        } catch { /* non-critical */ }

        // Remove PID file + record shutdown time for offline-duration tracking
        try {
            const { unlinkSync, writeFileSync, existsSync } = await import('node:fs')
            const { join } = await import('node:path')
            const ownedPidFile = join(process.cwd(), '.nova.pid')
            if (existsSync(ownedPidFile) && readFileSync(ownedPidFile, 'utf8').trim() === String(process.pid)) unlinkSync(ownedPidFile)
            const hbFile = join(process.cwd(), '.nova-data', 'last-heartbeat.json')
            writeFileSync(hbFile, JSON.stringify({ shutdownAt: new Date().toISOString(), pid: process.pid }))
        } catch { /* ok */ }

        console.log('[Nova] 👋 Shutdown abgeschlossen')
        process.exit(0)
    }

    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    const { startDaemonControl } = await import('./process/daemon-control.js')
    await startDaemonControl(process.cwd(), () => shutdown('local authenticated control'))
}

async function gracefulShutdown() {
    console.log('')
    console.log('[Nova] Beende Daemon...')

    state.running = false

    // Remove PID file + record shutdown time for offline-duration tracking
    try {
        const { unlinkSync, writeFileSync } = await import('node:fs')
        unlinkSync(join(process.cwd(), '.nova.pid'))
        const hbFile = join(process.cwd(), '.nova-data', 'last-heartbeat.json')
        writeFileSync(hbFile, JSON.stringify({ shutdownAt: new Date().toISOString(), pid: process.pid }))
    } catch { /* ok */ }

    // Flush session summaries (Tier 2 Memory) before shutdown
    try {
        const { flushAllSessions } = await import('./layers/L6-session-summary.js')
        await flushAllSessions()
        console.log('[Nova] ✓ Session-Summaries gespeichert')
    } catch (err) {
        console.log(`[Nova] Session flush error: ${err}`)
    }

    // Flush user patterns before shutdown
    try {
        const { flush } = await import('./intelligence/user-patterns.js')
        flush()
        console.log('[Nova] ✓ User-Patterns gespeichert')
    } catch { /* non-critical */ }

    try {
        await stopMeshTransportRuntime()
    } catch { /* non-critical */ }

    // Disconnect channels
    if (state.channels.telegram) {
        await state.channels.telegram.disconnect()
        console.log('[Nova] Telegram getrennt')
    }
    if (state.channels.whatsapp) {
        await state.channels.whatsapp.disconnect()
        console.log('[Nova] WhatsApp getrennt')
    }
    if (state.channels.discord) {
        await state.channels.discord.disconnect()
        console.log('[Nova] Discord getrennt')
    }

    console.log('[Nova] ✓ Daemon beendet')
    process.exit(0)
}

// ============================================
// Entry Point
// ============================================

startDaemon().catch(err => {
    console.error('[Nova] ❌ Daemon Fehler:', err)
    process.exit(1)
})


