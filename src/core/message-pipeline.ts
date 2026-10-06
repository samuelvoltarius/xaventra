/**
 * Nova Message Pipeline - Extracted from daemon.ts
 * 
 * Contains the system prompt (NOVA_PERSONA), session logging, 
 * and the main handleMessage function.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { traceStep } from './request-tracer.js'
import { ReplyDeliveryError, protectReplyDelivery } from './reply-delivery-error.js'
import { selectContextPolicy } from './context-policy.js'
import { conversationResponseGuidance, detectActionIntent, honestNoToolResponse, responseClaimsCompletedAction, toolProvidesActionEvidence } from './action-intent.js'
import { isNovaSystemAuthored } from './system-message.js'
import { compatiblePrincipalScopes, principalScope, resolvePrincipalId, type PrincipalContext } from '../users/principal-id.js'
import { decideMemoryTurn } from '../memory/memory-quality.js'
import { resolveConfigPath } from '../config/config-path.js'
import { containsHttpUrl, isNodeScreenshotRequest, isEnvironmentOverview, liveEvidenceGuidance, mentionsEnvironment } from './request-capabilities.js'


// State and handler types
export interface DaemonState {
    running: boolean
    channels: { telegram: any; whatsapp: any; discord: any }
    llm: any
    internalLlm: any
    memory: any
    learning: any
    tools: any
    resilience: any
    startTime: number
    [key: string]: any
}

// Helper: Determine time-of-day context for anti-hallucination
function getTimeOfDayContext(date: Date): string {
    const h = date.getHours()
    if (h >= 0 && h < 5) return 'Nacht (spät/früh)'
    if (h >= 5 && h < 8) return 'Früher Morgen'
    if (h >= 8 && h < 10) return 'Morgen'
    if (h >= 10 && h < 12) return 'Vormittag'
    if (h >= 12 && h < 14) return 'Mittag'
    if (h >= 14 && h < 17) return 'Nachmittag'
    if (h >= 17 && h < 20) return 'Abend'
    if (h >= 20 && h < 23) return 'Spätabend'
    return 'Nacht'
}

// ============================================
// Idle Tracking — Nova knows when the user last spoke
// ============================================
let _lastUserMessageTime = 0
let _lastSelfThinkTime = 0

export function trackUserMessage(): void {
    _lastUserMessageTime = Date.now()
}

export function trackSelfThink(): void {
    _lastSelfThinkTime = Date.now()
}

export function getIdleMinutes(): number {
    if (_lastUserMessageTime === 0) return 999 // Never messaged = always idle
    return Math.round((Date.now() - _lastUserMessageTime) / 60000)
}

export function getMinutesSinceLastSelfThink(): number {
    if (_lastSelfThinkTime === 0) return 999
    return Math.round((Date.now() - _lastSelfThinkTime) / 60000)
}


// Pre-load hot-path modules at startup to avoid first-call latency
export async function preloadPipelineModules(): Promise<void> {
    const profile = (process.env.NOVA_PRELOAD_PROFILE || 'minimal').toLowerCase()
    const minimalModules = [
        '../layers/subconscious-reflector.js',
        '../layers/L15-self-check.js',
        '../layers/L23-instincts.js',
        '../layers/vibe-regler.js',
    ]
    const fullModules = [
        ...minimalModules,
        '../layers/L9-idle-learning.js',
        '../intelligence/roi-dashboard.js',
        '../intelligence/emotion-tracker.js',
        '../intelligence/user-patterns.js',
        '../intelligence/autonomy-engine.js',
        '../memory/auto-observer.js',
    ]
    const modules = profile === 'full' ? fullModules : profile === 'off' ? [] : minimalModules
    await Promise.allSettled(modules.map(m => import(m)))
    console.log(`[Pipeline] Preload profile=${profile}: ${modules.length} modules`)

    // Clear response cache on every startup — prevents stale error responses
    // from previous failed sessions being served as valid answers
    try {
        const { clearCache } = await import('../llm/response-cache.js')
        clearCache()
        console.log('[Pipeline] Response cache cleared (fresh start)')
    } catch { /* non-critical */ }
}

// ============================================
// Channel Handlers
// ============================================

// Load SOUL.md — cached with 30s TTL to avoid disk read on every message
let _soulCache: { content: string; loadedAt: number; path: string } | null = null
const SOUL_CACHE_TTL = 30_000

function loadSoul(): string {
    if (_soulCache && Date.now() - _soulCache.loadedAt < SOUL_CACHE_TTL) {
        return _soulCache.content
    }

    const soulPaths = [
        join(process.cwd(), 'SOUL.md'),
        join(process.cwd(), '.nova-data', 'SOUL.md'),
    ]

    for (const p of soulPaths) {
        try {
            if (existsSync(p)) {
                const soul = readFileSync(p, 'utf-8').trim()
                if (!_soulCache || _soulCache.path !== p) {
                    console.log(`[Nova] ✓ SOUL.md geladen von ${p} (${soul.length} chars)`)
                }
                _soulCache = { content: soul, loadedAt: Date.now(), path: p }
                return soul
            }
        } catch { /* try next */ }
    }

    console.log('[Nova] ⚠ SOUL.md nicht gefunden — verwende Fallback')
    return NOVA_PERSONA_FALLBACK
}

// xaventra.config.json — cached with 60s TTL
let _configCache: { data: Record<string, unknown>; loadedAt: number } | null = null
const CONFIG_CACHE_TTL = 60_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _getNovaConfig(configPath: string): any {
    if (_configCache && Date.now() - _configCache.loadedAt < CONFIG_CACHE_TTL) {
        return _configCache.data
    }
    try {
        const data = JSON.parse(readFileSync(configPath, 'utf-8'))
        _configCache = { data, loadedAt: Date.now() }
        return data
    } catch {
        return _configCache?.data ?? {}
    }
}

// Hardcoded fallback (nur wenn SOUL.md fehlt)
const NOVA_PERSONA_FALLBACK = `# IDENTITÄT - DU BIST NOVA ✨

## KRITISCHE REGELN
1. IMMER AUF DEUTSCH ANTWORTEN
2. DU BIST NOVA — sag niemals "I am"
3. KEINE ERFUNDENEN TOOLS
4. NUR ECHTE TOOLS NUTZEN
5. EINFACH SPRECHEN — kein technischer Output

## TOOL-NUTZUNG
Tools DIREKT aufrufen, nicht beschreiben. HANDLE statt zu reden!

Antworte NUR auf Deutsch!`

// Mutable: reloaded on every message for live SOUL.md changes
export let NOVA_PERSONA = loadSoul()

// ============================================
// Session Logging — per-user conversation logs
// ============================================
export function logSession(user: string, channel: string, role: 'user' | 'assistant', content: string) {
    try {
        const sessionDir = join(process.cwd(), '.nova-data', 'sessions')
        if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })

        const safeName = user.replace(/[^a-zA-Z0-9_-]/g, '_')
        const logFile = join(sessionDir, `${safeName}.jsonl`)
        const entry = JSON.stringify({
            ts: new Date().toISOString(),
            channel,
            role,
            content: content.slice(0, 2000), // cap at 2000 chars
        })
        appendFileSync(logFile, entry + '\n')
    } catch { /* logging is non-critical */ }
}

/**
 * Last turns of this user's session log on this channel (read from the file
 * tail only). Used for the response-cache key, so "und das zweite?" in a
 * different conversation never returns an old answer.
 */
export function recentSessionTurns(user: string, channel: string, limit = 12): Array<{ role: string; content: string }> {
    try {
        const safeName = user.replace(/[^a-zA-Z0-9_-]/g, '_')
        const logFile = join(process.cwd(), '.nova-data', 'sessions', `${safeName}.jsonl`)
        if (!existsSync(logFile)) return []
        const fd = openSync(logFile, 'r')
        let text = ''
        try {
            const size = fstatSync(fd).size
            const length = Math.min(size, 64 * 1024)
            const buffer = Buffer.alloc(length)
            readSync(fd, buffer, 0, length, size - length)
            text = buffer.toString('utf8')
            // The first line of a partial tail read may be cut off.
            if (length < size) text = text.slice(text.indexOf('\n') + 1)
        } finally {
            closeSync(fd)
        }
        const turns: Array<{ role: string; content: string }> = []
        for (const line of text.split('\n')) {
            if (!line.trim()) continue
            try {
                const entry = JSON.parse(line)
                if (entry.channel === channel && (entry.role === 'user' || entry.role === 'assistant')) {
                    turns.push({ role: entry.role, content: String(entry.content ?? '') })
                }
            } catch { /* skip damaged line */ }
        }
        return turns.slice(-limit)
    } catch {
        return []
    }
}

/** Cache-key messages: prior turns plus the current message exactly once. */
export function responseCacheMessages(user: string, channel: string, content: string): Array<{ role: string; content: string }> {
    const turns = recentSessionTurns(user, channel)
    const last = turns[turns.length - 1]
    const prior = last && last.role === 'user' && last.content === content.slice(0, 2000) ? turns.slice(0, -1) : turns
    return [...prior, { role: 'user', content }]
}

export interface MessageExecutionOptions {
    abortSignal?: AbortSignal
    allowedTools?: string[]
    requestId?: string
    /** Set only by in-process producers (reminder/heartbeat wakeups, autonomy):
     * keeps internal prefixes like [REMINDER]; external callers never set it. */
    systemAuthored?: boolean
}

/** The agent exceeded its wall-clock budget; its signal has been aborted. */
export class AgentDeadlineError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AgentDeadlineError'
    }
}

/**
 * Run one agent invocation with a signal that is aborted by either the
 * execution's own abort signal or the deadline. Unlike a bare Promise.race,
 * the losing agent is actually told to stop, and the timer is always cleared.
 */
export async function runWithAbortDeadline<T>(
    run: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; parentSignal?: AbortSignal; label?: string },
): Promise<T> {
    const controller = new AbortController()
    const parent = options.parentSignal
    const onParentAbort = () => controller.abort(parent?.reason)
    if (parent?.aborted) onParentAbort()
    else parent?.addEventListener('abort', onParentAbort, { once: true })
    const aborted = new Promise<never>((_, reject) => {
        const rejectWithReason = () => reject(controller.signal.reason)
        if (controller.signal.aborted) rejectWithReason()
        else controller.signal.addEventListener('abort', rejectWithReason, { once: true })
    })
    aborted.catch(() => undefined)
    const timer = setTimeout(() => controller.abort(new AgentDeadlineError(
        `[Timeout] ${options.label || 'runNovaAgent'} exceeded ${options.timeoutMs}ms`)), options.timeoutMs)
    try {
        if (controller.signal.aborted) throw controller.signal.reason
        return await Promise.race([run(controller.signal), aborted])
    } finally {
        clearTimeout(timer)
        parent?.removeEventListener('abort', onParentAbort)
    }
}

/**
 * Decide how a failed agent run is answered. A deadline or an abort must never
 * be papered over with an unguarded plain LLM completion.
 */
export function agentFailureDisposition(error: unknown, parentSignal?: AbortSignal): 'cancelled' | 'timeout' | 'fallback' {
    if (parentSignal?.aborted) return 'cancelled'
    if (error instanceof AgentDeadlineError) return 'timeout'
    const name = (error as { name?: unknown } | null)?.name
    if (name === 'AbortError' || /\bAbortError\b/.test(String(error))) return 'cancelled'
    return 'fallback'
}

/** Progress heartbeats/step updates stop once the final answer phase begins. */
export function createProgressGate(send: (message: string) => Promise<void>) {
    let closed = false
    return {
        async send(message: string): Promise<void> {
            if (closed) return
            await send(message)
        },
        close(): void { closed = true },
        get closed(): boolean { return closed },
    }
}

/** Per-message transport facts supplied by the channel adapter. */
export interface MessageContext {
    /** Real conversation/chat id of this message (e.g. a Telegram group id). */
    chatId?: string
}

/**
 * Chat id used for group tracking and coalescing. It belongs to this message:
 * the adapter-supplied id wins, otherwise the sender id. The process-global
 * Telegram `lastActiveChatId` is never borrowed (INT-3c): every Telegram
 * entry (live inbound, failover and startup replays) passes the real chat id,
 * and internal callers (mission engine, reminders) must not be merged into a
 * user's chat.
 */
export function resolveConversationChatId(_channel: string, from: string, context?: MessageContext): string {
    const explicit = String(context?.chatId ?? '').trim()
    return explicit || from
}

export interface ScreenshotFallbackRequest {
    channel: string
    /** Raw channel identity: the authorization subject and the Telegram recipient. */
    from: string
    /** Canonical principal used by the tool policy. */
    principalId: string
    content: string
    tools?: { execute?: (name: string, args: Record<string, unknown>) => Promise<any> }
    telegram?: { sendPhoto?: (chatId: string, path: string, caption?: string) => Promise<unknown> }
}

/**
 * Deterministic screenshot fallback for providers that acknowledge a capture
 * request without emitting a tool call. It is not a second authority: the
 * capture passes the same authorizeToolExecution boundary (tool policy,
 * channel, owner grant and role) as every governed tool call. Only Telegram
 * has a delivery path; everything else, and every denial, is a no-op so the
 * model's normal reply stands.
 */
export async function runAuthorizedScreenshotFallback(
    request: ScreenshotFallbackRequest,
): Promise<{ path: string; size?: number } | null> {
    if (isNodeScreenshotRequest(request.content)) return null
    if (request.channel.toLowerCase() !== 'telegram') return null
    if (!request.tools?.execute || !request.telegram?.sendPhoto) return null
    let args: Record<string, unknown>
    try {
        const { authorizeToolExecution } = await import('../agents/tool-authorization.js')
        args = await authorizeToolExecution('desktop_screenshot', { send: false, chat_id: request.from }, {
            userId: request.principalId,
            authUserId: request.from,
            channel: request.channel,
            requestText: request.content,
            governedReadOnly: false,
        })
    } catch (error) {
        console.log(`[Pipeline] Screenshot fallback not authorized: ${error}`)
        return null
    }
    const screenshotResult: any = await request.tools.execute('desktop_screenshot', args)
    const imgPath = screenshotResult?.screenshotPath || screenshotResult?.path
    if (!screenshotResult?.success || !imgPath || !existsSync(imgPath)) return null
    await request.telegram.sendPhoto(request.from, imgPath, 'Desktop Screenshot')
    return { path: imgPath, size: screenshotResult.size }
}

export async function handleMessage(...args: Parameters<typeof handleMessageInScope>): ReturnType<typeof handleMessageInScope> {
    // One LLM-principal scope per message (Codex only for the owner).
    const { runWithLlmPrincipal } = await import('../llm/llm-principal.js')
    return runWithLlmPrincipal(() => handleMessageInScope(...args))
}

async function handleMessageInScope(
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
    state: DaemonState,
    handleCommandFn: (cmd: string, args: string, from: string, context?: PrincipalContext) => Promise<string | null>,
    image?: { data: string; mimeType: string },
    execution?: MessageExecutionOptions,
    messageContext?: MessageContext,
) {
    // Desktop ingress carries cancellation out-of-band, never as model text.
    const desktopAbort = channel.toLowerCase() === 'desktop'
        ? (await import('../desktop/desktop-agent-context.js')).getDesktopAbortSignal() : undefined
    const desktopCancellationOnly = Boolean(desktopAbort && !execution)
    const requestAbortSignal = desktopAbort && execution?.abortSignal
        ? AbortSignal.any([desktopAbort, execution.abortSignal]) : desktopAbort || execution?.abortSignal
    if (desktopAbort && !content.trimStart().startsWith('/')) execution = { ...execution, abortSignal: requestAbortSignal }
    requestAbortSignal?.throwIfAborted()
    execution?.abortSignal?.throwIfAborted()
    replyFn = protectReplyDelivery(replyFn)
    let trackedTaskId: string | undefined
    traceStep('input:accepted')
    let contextPolicy = selectContextPolicy(content, Boolean(image))
    let memoryDecision = decideMemoryTurn(content)
    // Map channel-specific user IDs to canonical names (from xaventra.config.json)
    const configAliases = (state as any).config?.userAliases || {}
    const canonicalUser = configAliases[from] || from
    const principalId = resolvePrincipalId((state as any).config, channel, from)
    const principalContext: PrincipalContext = { channel, rawUserId: from, principalId }
    let requestUserContext = ''
    let requestGroupContext = ''
    // P8 Routine-Skills: Gruppen lernen nie mit; angewendeter Skill dieses Laufs.
    let requestIsGroup = false
    let routineSkillApplied: string | null = null

    // 2.86 Paket N: a pasted login return address (…/verbindungen/rueckkehr?state=…&code=…)
    // finishes the login at once. Checked BEFORE any log, session, ledger or model:
    // the code never leaves this branch. Only the owner; the single-use state is the proof.
    if (!image) {
        const { loginReturnInMessage, handlePastedLoginReturn } = await import('../connections/login-paste.js')
        const address = loginReturnInMessage(content)
        if (address) {
            const { getUserPermission } = await import('../users/multi-user-middleware.js')
            const owner = getUserPermission(from, channel) === 'owner'
            console.log(`[Nova] [${channel}] Anmelde-Rückkehr eingefügt${owner ? '' : ' (kein Owner, verworfen)'}`)
            await replyFn(owner ? await handlePastedLoginReturn(address) : 'Eine Anmeldung kann nur der Owner abschließen.')
            return
        }
    }
    // 2.87 Paket P: `/telefon passwort …` wie Anmelde-Befehle nie protokollieren (auch nicht im Konsolen-Log).
    const isSensitiveAuthCommand = /^\/(?:codex\s+login|login(?:\s+(?:openai|codex))?|callback|telefon\s+(?:passwort|ari-passwort))\b/i.test(content.trim())
    console.log(`[Nova] [${channel}] Nachricht von ${canonicalUser} (${from}): ${isSensitiveAuthCommand ? '[vertraulicher Befehl]' : content.slice(0, 50)}...${image ? ' [+Bild]' : ''}`)
    if (!isSensitiveAuthCommand) logSession(canonicalUser, channel, 'user', content)

    // Track user activity for Dreaming/Idle systems
    try {
        const { recordActivity } = await import('../layers/subconscious-reflector.js')
        recordActivity()
    } catch (err) { console.debug('[Pipeline] optional module unavailable:', err) }
    try {
        const { getIdleLearningManager } = await import('../layers/L9-idle-learning.js')
        getIdleLearningManager()?.recordActivity?.()
    } catch (err) { console.debug('[Pipeline] optional module unavailable:', err) }

    // ROI Dashboard: Start tracking this task
    try {
        const { startTask, detectCategory } = await import('../intelligence/roi-dashboard.js')
        startTask(content.slice(0, 200), detectCategory(content))
    } catch (err) { console.debug('[Pipeline] optional module unavailable:', err) }

    // System-generated messages (self-think, reminders, heartbeat routines, the
    // Nova-Autonomy actor) are NOT user input. Feeding them to the LearningEngine
    // poisons the pattern/skill store — Nova was learning her own self-reflection
    // PROMPT as a "skill" (freq 70+) and logging her own prompts as "negative
    // feedback". Detect once and skip all learning ingestion for them.
    const isSystemAuthored = isNovaSystemAuthored({ from, canonicalUser, content })

    // Explicit positive feedback becomes evidence on the most recent validated
    // run for this principal. Benchmark/internal actors never reach this path.
    if (!isSystemAuthored && /^(?:danke|perfekt|genau|super|passt|thank you|perfect)[!.\s]*$/i.test(content.trim())) {
        try {
            const { recordFeedbackForLatestUserRun } = await import('./outcome-ledger.js')
            recordFeedbackForLatestUserRun({
                userId: principalId,
                channel,
                rating: 5,
                accepted: true,
                comment: content.slice(0, 300),
            })
        } catch { /* feedback evidence is non-critical */ }
    }

    // Track idle time — only for real user messages, not system injections
    if (!content.startsWith('[REMINDER]') && !content.startsWith('[SELF-THINK]') && from !== 'Nova-Autonomy') {
        trackUserMessage()
    }

    // Track last active user for L15 proactive messaging
    ; (state as any).lastActiveUserId = canonicalUser

    // Notify L15 that user sent a message
    try {
        const { userMessageReceived } = await import('../layers/L15-self-check.js')
        userMessageReceived()
    } catch (err) { console.debug('[Pipeline] L15 not available:', err) }

    // ============================================
    // Multi-User Middleware (Auth, Coalescing, Onboarding, Group Chat)
    // ============================================
    // Fail-closed: until checkAuth() has positively allowed this sender, any
    // middleware failure (import, init, lookup) is treated like a denial. An
    // exception must never skip the blocked/allowlist check.
    let senderAuthorized = false
    // null until the middleware decided; only a known direct chat may create decisions.
    let isGroupMessage: boolean | null = null
    try {
        const mu = await import('../users/multi-user-middleware.js')
        mu.initMultiUser()

        // 1. Auth Check — block unauthorized users
        const chatId = resolveConversationChatId(channel, from, messageContext)
        const authResult = mu.checkAuth(from, channel, canonicalUser)

        if (!authResult.allowed) {
            console.log(`[MultiUser] ❌ Blocked: ${from} — ${authResult.reason}`)
            await replyFn(authResult.reason || '🔒 Zugriff verweigert.')
            return
        }
        senderAuthorized = true

        // 2. Tool Restrictions — the decided role is bound to this request
        // before any optional middleware step can fail.
        principalContext.permission = authResult.permission
        ;(await import('../llm/llm-principal.js')).setLlmPrincipalPermission(authResult.permission)
        ; (state as any).__userPermission = authResult.permission
            ; (state as any).__userId = from
        if ((globalThis as any).__novaState) (globalThis as any).__novaState.__userId = from

        // 4. Group Chat — track who speaks
        isGroupMessage = mu.isGroupChat(chatId, from) === true
        if (isGroupMessage) {
            requestIsGroup = true
            mu.trackGroupMessage(chatId, from, canonicalUser)
        }

        // 5. Message Coalescing — batch rapid-fire messages
        if (mu.shouldCoalesce(chatId, from)) {
            content = await mu.coalesceMessage(chatId, from, content)
        } else {
            // Start new coalescing window (but don't wait for the first message)
            // Only coalesce if a SECOND message arrives within 2.5s
            // We do this by checking if there was a very recent message
            const lastMsg = (globalThis as any).__novaLastMsg?.[from]
            const now = Date.now()
            if (lastMsg && (now - lastMsg) < 2500) {
                content = await mu.coalesceMessage(chatId, from, content)
            }
            if (!(globalThis as any).__novaLastMsg) (globalThis as any).__novaLastMsg = {}
                ; (globalThis as any).__novaLastMsg[from] = now
        }

        // An earlier request whose text was merged into a later message of the
        // same burst ends here, silently: the later request answers it (INT-8).
        // This must not depend on the slash-command path.
        if (mu.isCoalescedMarker?.(content)) {
            console.log(`[MultiUser] ↪ ${from}: Nachricht in spätere Nachricht zusammengeführt — beendet`)
            return
        }

        // 6. User Onboarding — welcome new users
        if (authResult.isNewUser) {
            const welcome = mu.getOnboardingMessage(authResult.user)
            if (welcome) {
                await replyFn(welcome)
                // Don't return — let them also get their answer
            }
        }

        // 3. Per-User Memory — inject context into state
        const userCtx = mu.getUserContextString(from)
        if (userCtx) {
            requestUserContext = userCtx
        }

        // 4b. Group Chat Context
        if (mu.isGroupChat(chatId, from)) {
            const groupCtx = mu.getGroupContext(chatId)
            if (groupCtx) {
                requestGroupContext = groupCtx
            }
        }

        // 3b. Track topic
        const topicWords = content.split(/\s+/).slice(0, 3).join(' ')
        mu.addUserTopic(from, topicWords)

    } catch (err) {
        if (!senderAuthorized) {
            console.log(`[MultiUser] ❌ Middleware error before authorization — denied (fail-closed): ${err}`)
            await replyFn('🔒 Zugriff verweigert.')
            return
        }
        // Later steps (coalescing, onboarding, context) are optional.
        console.log(`[MultiUser] ⚠ Middleware error after authorization (non-fatal): ${err}`)
    }

    // ============================================
    // First-Run Onboarding (Soul/Persona Setup)
    // ============================================
    const { soulExists, getOnboardingMessage, isOnboardingResponse, parseOnboardingResponse, saveSoul, getOnboardingConfirmation, loadSoul: loadSoulData, buildSystemPromptFromSoul } = await import('./soul.js')

    // Check if this is the onboarding phase
    const onboardingKey = `onboarding:${from}`
    const isInOnboarding = (global as any)[onboardingKey]

    // Sieht die Nachricht nach einem echten Auftrag aus? Dann darf die
    // Vorstellungsfrage sie NICHT auffressen. Genau das passierte bisher:
    // "Installiere mir bitte galculator" beantwortete Nova mit "Wie soll
    // ich heissen?", der Auftrag war weg. Dreimal reproduziert am
    // 30.08.2026. Schlimmer noch: die naechste Nachricht wurde dann als
    // Namensantwort gelesen — Nova hiess ploetzlich "Brutus", nach ihrem
    // eigenen Beispielsatz.
    const wirktWieAuftrag = (text: string): boolean => {
        const t = text.toLowerCase()
        if (t.includes('du heißt') || t.includes('du bist')
            || t.includes('dein name') || t.includes('nenne dich')) return false
        return /\b(installier|richte|mach|erstell|leg an|zeig|oeffne|öffne|starte|such|find|lade|kopier|loesch|lösch|schreib|repariere|verbinde|update|aktualisier)/.test(t)
            || t.trim().split(/\s+/).length >= 4
    }

    if (!content.trimStart().startsWith('/') && !soulExists() && !isInOnboarding) {
        console.log('[Nova] First run detected - starting onboarding')
            ; (global as any)[onboardingKey] = true
        if (!wirktWieAuftrag(content)) {
            await replyFn(getOnboardingMessage())
            return
        }
        // Auftrag statt Begruessung: Vorstellung ueberspringen und arbeiten.
        // Die Frage nach dem Namen kommt beim naechsten Geplauder von selbst.
        console.log('[Nova] Erste Nachricht ist ein Auftrag — Vorstellung wird uebersprungen')
    }

    if (isInOnboarding && wirktWieAuftrag(content)) {
        // Auch waehrend der Vorstellung: ein Auftrag ist ein Auftrag.
        delete (global as any)[onboardingKey]
    }

    // Auch hier gegen den Auftragstest pruefen: die Markierung oben wird
    // zwar geloescht, aber isInOnboarding ist eine Konstante von vorher.
    // Ohne diese zweite Pruefung landete "Beschreibe mir, was auf dem
    // Bildschirm zu sehen ist" als Persoenlichkeit in ihrer Seele.
    if (!content.trimStart().startsWith('/') && isInOnboarding && !wirktWieAuftrag(content) && isOnboardingResponse(content)) {
        // User is defining the persona
        console.log('[Nova] Processing onboarding response')
        const soul = parseOnboardingResponse(content)
        saveSoul(soul)
        delete (global as any)[onboardingKey]
        await replyFn(getOnboardingConfirmation(soul))
        return
    }

    // ============================================
    // Slash Commands (Layer 2) — EARLY EXIT, no prompt assembly needed
    // ============================================
    if (content.startsWith('/')) {
        if (execution) throw new Error('Mesh agent requests cannot invoke slash commands')
        const [cmd, ...args] = content.slice(1).split(' ')
        const cmdResponse = await handleCommandFn(cmd.toLowerCase(), args.join(' '), from, principalContext)
        if (cmdResponse) {
            // __HANDLED__ = command was executed via Telegram buttons (no text reply needed)
            if (cmdResponse !== '__HANDLED__') {
                await replyFn(cmdResponse)
                if (!isSensitiveAuthCommand) logSession(canonicalUser, channel, 'assistant', cmdResponse)
            }
            // Stop typing indicator (esp. important for __HANDLED__ where send() is skipped)
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) tg.stopTyping(from)
            } catch { /* non-Telegram */ }
            console.log(`[Nova] [${channel}] Command /${cmd} ausgeführt (kein LLM nötig)`)
            return
        }
        // Unknown command — NEVER send to LLM, show help instead
        const unknownMsg = `❓ Unbekannter Befehl: /${cmd}\n\nNutze /help für alle verfügbaren Befehle.`
        await replyFn(unknownMsg)
        logSession(canonicalUser, channel, 'assistant', unknownMsg)
        console.log(`[Nova] [${channel}] ❌ Unknown command /${cmd} — blocked (not sent to LLM)`)
        return
    }

    // Read-only natural-language fast path. It reuses the same command
    // handlers and RBAC context as slash commands, but avoids prompt assembly,
    // model latency and fragile tool selection for common live-status queries.
    if (!execution || desktopCancellationOnly) {
        try {
            const { detectDeterministicCommand } = await import('./deterministic-query.js')
            const detected = detectDeterministicCommand(content)
            // 2.86 Paket N: „und?“ after a connection is only the owner's; everyone else just talks.
            const deterministic = detected && !(detected.reason === 'connect-progress' && principalContext.permission !== 'owner') ? detected : null
            if (deterministic) {
                const response = await handleCommandFn(
                    deterministic.command,
                    deterministic.args,
                    from,
                    principalContext,
                )
                if (response) {
                    if (response !== '__HANDLED__') {
                        await replyFn(response)
                        logSession(canonicalUser, channel, 'assistant', response)
                    }
                    traceStep(`fast-path:${deterministic.reason}`)
                    console.log(`[Nova] [${channel}] Deterministic fast-path: ${deterministic.reason}`)
                    return
                }
            }
        } catch (error) {
            console.debug(`[Pipeline] deterministic fast-path unavailable: ${error}`)
        }
    }

    // Resolve ambiguity before prompt assembly. The gate uses only the
    // existing user-scoped continuity store and never guesses a destructive
    // target. A reply resumes the original request without a slash command.
    if (!isSystemAuthored && !image) {
        try {
            const { evaluateClarification } = await import('./clarification-gate.js')
            const clarification = evaluateClarification(principalId, content)
            if (clarification.action === 'ask') {
                await replyFn(clarification.question || 'Welche Angabe fehlt noch?')
                traceStep('clarification:requested')
                return
            }
            if (clarification.action === 'cancel') {
                await replyFn('Okay, ich habe die offene Aufgabe abgebrochen.')
                traceStep('clarification:cancelled')
                return
            }
            content = clarification.content
        } catch (error) {
            console.debug(`[Pipeline] clarification gate unavailable: ${error}`)
        }
    }

    // Coalescing and the Clarification Gate may have reconstructed a richer
    // request. Allocate cognition and memory from that authoritative request,
    // not from the short follow-up answer that resumed it.
    contextPolicy = selectContextPolicy(content, Boolean(image))
    memoryDecision = decideMemoryTurn(content)

    // Learned corrections are considered only after ambiguity and identity
    // gates. They cannot consume a clarification reply or bypass RBAC.
    try {
        const le = (state as any).learningCoordinator || (state as any).learning
        if (le?.processUserMessage && !isSystemAuthored) {
            const learned = le.processUserMessage(content, { channel, userId: principalId })
            if (learned && learned.confidence >= 0.9 && learned.source === 'correction') {
                console.log(`[LearningEngine] Using learned ${learned.source} response (confidence: ${learned.confidence})`)
                await replyFn(learned.response)
                logSession(canonicalUser, channel, 'assistant', learned.response)
                return
            }
        }
    } catch { /* learning non-critical */ }

    // 2.88 „Was ich nicht kann, lerne ich“: a capability question/request for which the
    // real inventory has no tool, connection or learned skill gets the honest answer
    // at once („Nein, das kann ich noch nicht. Soll ich es lernen?“ + Ja/Nein card for
    // the owner) — no model, no excuse. Anything the inventory can do runs as before.
    if (!isSystemAuthored && !image && !execution) {
        try {
            const { capabilityGate } = await import('../learning/capability-learning.js')
            const gate = await capabilityGate(content, { principalId, permission: principalContext.permission, isGroup: requestIsGroup || isGroupMessage === true })
            if (gate.handled && gate.reply) {
                await replyFn(gate.reply)
                logSession(canonicalUser, channel, 'assistant', gate.reply)
                traceStep('capability:honest-no')
                return
            }
        } catch (error) {
            console.debug(`[Pipeline] capability gate unavailable: ${error}`)
        }
    }

    // Reload SOUL.md on every message (L24 changes take effect immediately)
    NOVA_PERSONA = loadSoul()

    // ALWAYS include NOVA_PERSONA (admin code, tools, rules)
    // Soul prompt provides personality, NOVA_PERSONA provides capabilities
    traceStep('preflight:complete')
    let systemPrompt = NOVA_PERSONA
    if (soulExists()) {
        systemPrompt = buildSystemPromptFromSoul() + '\n\n' + NOVA_PERSONA
    }
    if (!isSystemAuthored) systemPrompt += conversationResponseGuidance(content)
    if (!isSystemAuthored) systemPrompt += liveEvidenceGuidance(content)

    // Gemessener Systembefund statt Annahmen. Der Environment-Scanner laeuft
    // beim Start; sein Ergebnis floss bisher nur in den Self-Setup-Orchestrator,
    // nicht in den Prompt. Ohne das haelt Nova sich auf einem headless Server
    // fuer browser- und desktopfaehig und ruft browser_*/desktop_* ins Leere.
    // Kein fest verdrahteter Text: auf einer Maschine MIT Browser steht hier
    // entsprechend, dass er da ist.
    if (process.env.NOVA_OS_MODE === 'true') {
        try {
            // scanEnvironment() statt getEnvironmentMap(): die Messung vom
            // Systemstart veraltet, sobald Nova selbst etwas installiert.
            // Nach einer Desktop-Installation behauptete der Befund weiter
            // "keine grafische Oberflaeche" — und fuehrte sie in die Irre,
            // bis hin zu einem RDP-Vorschlag fuer einen Bildschirm, der
            // direkt vor dem Menschen stand. Der Scanner hat 5 Minuten
            // Zwischenspeicher, kostet also fast nichts.
            const { scanEnvironment } = await import('../startup/environment-scanner.js')
            const env = await scanEnvironment()
            const fehlt: string[] = []
            if (!env.browser && !env.playwright_browsers) fehlt.push('kein Browser installiert → browser_* schlaegt fehl; nimm fetch_url oder web_search')
            if (!env.display) fehlt.push('keine grafische Oberflaeche (kein X/Wayland) → desktop_*/Screenshots unmoeglich')
            if (!env.audio) fehlt.push('keine Audio-Ausgabe → keine Sprachausgabe')
            if (fehlt.length) {
                systemPrompt += `\n\n## SYSTEM-BEFUND (beim Start gemessen)\n`
                    + fehlt.map(z => `- ${z}`).join('\n')
                    + `\n\nDas sind Messwerte dieser Maschine, keine Vermutung. Ich behaupte nicht,`
                    + ` etwas zu koennen, was hier nicht existiert — ich sage es offen und biete an,`
                    + ` es zu installieren (ich bin root). Fuer eine genaue Bestandsaufnahme oder`
                    + ` zum Nachruesten nutze ich self_setup_status, self_setup_plan und self_setup_apply.`
            }
        } catch { /* Scanner nicht verfuegbar — dann eben ohne Befund */ }

        // Bedienmodus: dieselbe Nova, andere Ansprache. Wird beim ersten
        // Start gewaehlt und liegt in /etc/novaos/modus. Bei jeder Nachricht
        // frisch gelesen, damit ein Wechsel sofort wirkt.
        // WICHTIG: Fehlt die Datei, gilt STANDARD — nicht "gar kein Modus".
        // Genau das war der Fehler: auf einem frisch installierten System
        // existierte /etc/novaos/modus nicht, also bekam Nova die Regeln
        // "keine Rueckfragen" und "hoere nie mit einer Ankuendigung auf"
        // ueberhaupt nie zu sehen — waehrend die Oberflaeche gleichzeitig
        // Standardmodus anzeigte (desktop-api faellt auf 'standard' zurueck).
        // Ergebnis: das alte Ankuendigungsverhalten kam zurueck.
        // Am 30.08.2026 am installierten System gemessen.
        try {
            let modus = ''
            try { modus = readFileSync('/etc/novaos/modus', 'utf-8').trim() } catch { modus = '' }
            if (modus === 'experte') {
                systemPrompt += `\n\n## BEDIENMODUS: EXPERTE\n`
                    + `Der Mensch kennt sich aus. Nenne ruhig Befehle, Pfade, Dateinamen und\n`
                    + `Rueckgabewerte. Kurz und dicht, keine Erklaerschleifen. Zeig was du\n`
                    + `ausgefuehrt hast, wenn es der Nachvollziehbarkeit dient.`
            } else {
                systemPrompt += `\n\n## BEDIENMODUS: STANDARD\n`
                    + `Der Mensch ist kein Techniker. Erklaere in normaler Sprache, was du\n`
                    + `getan hast und was dabei herauskam — **keine Befehle, keine Pfade,\n`
                    + `keine Fehlercodes, keine Rohdaten** in der Antwort. Kein Fachjargon:\n`
                    + `nicht "Locale", sondern "Sprache des Systems". Nicht "Repository",\n`
                    + `sondern "Paketquelle".\n`
                    + `Antworte in zwei bis vier Saetzen.\n\n`
                    + `**Keine unnötigen technischen Rückfragen.** Wer diesen\n`
                    + `Modus nutzt, kann Auswahlfragen nicht beantworten — "XFCE, GNOME oder\n`
                    + `LXQt?" ist fuer ihn keine Frage, sondern eine Sackgasse.\n`
                    + `Bei bereits autorisierten, reversiblen Routine-Details entscheide selbst. Nimm die naheliegendste, sparsamste,\n`
                    + `verbreitetste Variante, sag in EINEM Satz was du genommen hast und\n`
                    + `warum, und mach es dann. Danach erwaehnst du beilaeufig, dass es\n`
                    + `aenderbar ist, falls es ihm nicht passt.\n`
                    + `Beispiel: statt "Welchen Desktop willst du?" → "Ich nehme XFCE, das ist\n`
                    + `schlank und laeuft ueberall. Moment, ich installiere es." Und dann tun.\n\n`
                    + `Frage immer bei fehlender Freigabe, Anmeldung oder Kopplung, bei der Wahl\n`
                    + `lokal/Hersteller-Cloud und vor neuen Kosten oder unwiderruflichem Datenverlust.\n`
                    + `Diese Entscheidungen trifft der Mensch; keine Zugangsdaten im Chat erfragen.\n\n`
                    + `Wenn etwas nicht ging: EIN Satz was nicht ging, EIN Satz was du\n`
                    + `stattdessen innerhalb der bestehenden Freigabe tun kannst. Keine neue Wirkung\n`
                    + `oder Cloud-Verbindung ohne die erforderliche Nutzerentscheidung.\n\n`
                    + `**Hoere nie mit einer Ankuendigung auf.** Saetze wie "Jetzt\n`
                    + `installiere ich X:" oder "Ich pruefe das kurz:" duerfen nicht das\n`
                    + `Ende deiner Antwort sein — dann sitzt der Mensch da und muss dich\n`
                    + `anstupsen. Fuehre die Kette bis zum Ende durch und melde erst dann,\n`
                    + `was tatsaechlich herausgekommen ist. Scheitert ein Zwischenschritt,\n`
                    + `loese ihn selbst und mach weiter.`
            }
        } catch { /* keine Modusdatei — dann neutral */ }
    }

    // Negativ-Gedaechtnis: was auf dieser Maschine nicht geht. Die Erfolgsliste
    // ("gelernte Faehigkeiten", lernte vor der Validierung) ist seit 2.84.0 weg;
    // verifizierte Loesungen kommen nur noch aus den Prozeduren.
    try {
        const { getCapabilitiesPrompt } = await import('../memory/capabilities-store.js')
        // Command details are owner-only; typed so it compiles before and after
        // the options parameter exists.
        const gelernt = (getCapabilitiesPrompt as (options?: { permission?: string }) => string)({ permission: principalContext.permission })
        if (gelernt.trim()) systemPrompt += '\n\n' + gelernt
    } catch { /* nicht kritisch */ }
    // 2.88: fixed honesty rule — no tool for it → the one honest sentence (then the learn card).
    if (!isSystemAuthored) try {
        const { capabilityHonestyPrompt } = await import('../learning/capability-learning.js')
        systemPrompt += '\n\n' + capabilityHonestyPrompt()
    } catch { /* nicht kritisch */ }

    // Desktop Bot Mode is a scoped projection of the canonical prompt path.
    // It never creates a second agent runtime or memory principal.
    let desktopContext: import('../desktop/desktop-agent-context.js').DesktopAgentContext | undefined
    let desktopBot: import('../desktop/bot-profile-store.js').BotProfile | undefined
    try {
        const [{ getDesktopAgentContext }, { getBotProfileStore }] = await Promise.all([
            import('../desktop/desktop-agent-context.js'), import('../desktop/bot-profile-store.js'),
        ])
        desktopContext = getDesktopAgentContext()
        if (desktopContext) {
            desktopBot = getBotProfileStore().get(desktopContext.botId, desktopContext.principalId)
            if (!desktopBot?.enabled) throw new Error('Selected desktop bot is unavailable')
            systemPrompt += `\n\n## BOT-PROFIL (kanonischer Desktop-Scope)\nBot: ${desktopBot.name} (@${desktopBot.handle})\nAufgabe: ${desktopBot.instructions}\nMemory-Scope: User x Bot; Herkunft: ${desktopBot.source}.\nBehalte Novas Execution Kernel, RBAC, Tool Gates und Evidence-Regeln unveraendert.`
            if (desktopContext.workspaceId) {
                systemPrompt += `\nDesktop-Workspace: Ein vom Benutzer freigegebener, client-lokaler Projektordner ist als ${desktopContext.workspaceId} gebunden. Nutze desktop_workspace fuer list/read/search. Verwende niemals Spark-Dateitools fuer diesen lokalen Ordner und behaupte keinen Zugriff ohne Tool-Evidence.`
            }
            if (desktopContext.memoryAssetIds?.length) {
                const { getMemoryAssetCatalog } = await import('../memory/memory-asset-catalog.js')
                const catalog = getMemoryAssetCatalog()
                const assets = desktopContext.memoryAssetIds.map(id => catalog.get(id, desktopContext!.principalId)).filter(Boolean)
                const loadout = catalog.promptContext(assets as import('../memory/memory-asset-catalog.js').MemoryAsset[])
                if (loadout) systemPrompt += `\n\n${loadout}`
            }
        }
    } catch (error) {
        if (desktopContext) throw error
    }

    // Core Facts is a projection, not a second prompt authority. Governed
    // records are recalled once, per stable principal, later in this pipeline.

    // L23 Instincts — dynamic behavioral modifiers from user corrections
    try {
        const { getInstinctPrompt } = await import('../layers/L23-instincts.js')
        const instinctBlock = getInstinctPrompt()
        if (instinctBlock) {
            systemPrompt += '\n\n' + instinctBlock
        }
    } catch (err) { console.debug('[Pipeline] L23 not available:', err) }

    // Vibe Regler — time-aware behavioral adjustment
    try {
        const { getVibePrompt, recordUserActivity } = await import('../layers/vibe-regler.js')
        recordUserActivity()
        const vibeBlock = getVibePrompt()
        if (vibeBlock) {
            systemPrompt += '\n\n' + vibeBlock
        }
    } catch (err) { console.debug('[Pipeline] vibe-regler not available:', err) }

    // External Agent Skills injection (npx skills add)
    try {
        const { matchSkillsForMessage } = await import('./skills-loader.js')
        const matched = matchSkillsForMessage(content)
        for (const skillContent of matched) {
            systemPrompt += '\n\n' + skillContent.slice(0, 2000)
        }
    } catch (err) { console.debug('[Pipeline] skills not available:', err) }

    // Mesh Capability Map — Nova knows what each node + cloud can do
    if (contextPolicy.mesh || /capabilit|setup|install|skill|tool/i.test(content)) try {
        const { getCapabilityMap, getMissingCapabilities } = await import('../mesh/capability-orchestrator.js')
        const capMap = getCapabilityMap()
        if (capMap) {
            systemPrompt += '\n\n' + capMap
        }
        const { isExplicitSelfSetupRequest } = await import('./self-setup-orchestrator.js')
        const missing = isExplicitSelfSetupRequest(content) ? getMissingCapabilities() : []
        if (missing.length > 0) {
            systemPrompt += `\n\nExplizit angefragte, derzeit nicht verifizierte Capabilities: ${missing.join(', ')}. Nutze self_setup_plan für einen belegten Plan; behaupte niemals weitere fehlende Fähigkeiten. auto_provision ist abgeschaltet; installieren kann nur der Owner mit /setup apply.`
        }
    } catch (err) { console.debug('[Pipeline] capabilities not available:', err) }

    // ============================================
    // Time Awareness — Nova knows when it is
    // ============================================
    const now = new Date()
    const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    const dateStr = now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    systemPrompt += `\n\n## ⚠️ AKTUELLE SYSTEMZEIT (KRITISCH — NIEMALS RATEN!)
**Es ist EXAKT ${timeStr} Uhr am ${dateStr} (${tz}).**
**Das aktuelle Jahr ist ${now.getFullYear()}. Das ist die GEGENWART, nicht die Zukunft!**

REGELN:
- Du MUSST diese Zeit verwenden wenn du über Uhrzeit, Tageszeit oder Datum sprichst
- Du darfst die Uhrzeit NIEMALS schätzen, raten oder aus dem Gesprächsverlauf ableiten
- Wenn du unsicher bist, nutze das Tool \`get_current_time\`
- Sage NIEMALS "es ist etwa..." oder "es dürfte ungefähr..." — gib die EXAKTE Zeit an
- Tageszeit-Kontext: ${getTimeOfDayContext(now)}
- WICHTIG: Wenn der User über das Jahr ${now.getFullYear()} spricht, ist das JETZT. Sage NICHT "in der Zukunft" oder "geplant für ${now.getFullYear()}". Produkte und Events von ${now.getFullYear()} EXISTIEREN bereits.
- Dein LLM-Training enthält möglicherweise NICHT die neuesten Infos von ${now.getFullYear()}. Nutze IMMER google_search oder web_search für aktuelle Fakten!`

    // ============================================
    // Self-Knowledge Injection — Nova knows what she has
    // ============================================
    if (contextPolicy.mesh) try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = _getNovaConfig(configPath)
            const channels = config.channels ? Object.entries(config.channels)
                .filter(([, v]: [string, any]) => v?.enabled)
                .map(([k]: [string, any]) => k) : []
            const aliases = config.userAliases ? Object.entries(config.userAliases)
                .map(([id, name]) => `${name} (${id})`) : []
            const toolCount = state.tools ? state.tools.getAll().length : 0

            systemPrompt += `\n\n## DEIN SYSTEM-STATUS (LIVE)
- **Config:** xaventra.config.json existiert ✅ (${configPath})
- **Provider:** ${config.provider || 'unbekannt'} / ${config.model || 'unbekannt'}
- **Internes LLM:** ${config.internalModel === 'auto' ? 'Cloud (gleich wie Hauptmodell)' : config.internalModel || 'keins'}
- **Aktive Channels:** ${channels.join(', ') || 'keine'}
- **Dashboard:** http://localhost:${config.dashboard?.port || 3001}
- **Bekannte User:** ${aliases.join(', ') || 'keine'}
- **Tools geladen:** ${toolCount}
- **Sprache:** ${config.preferences?.language || 'de'}
- **Ton:** ${config.preferences?.tone || 'normal'}
- **Proaktiv:** ${config.proactive?.enabled ? 'JA' : 'NEIN'}${config.proactive?.morningBriefing ? ` (Briefing: ${config.proactive.morningBriefing})` : ''}
- **Memory:** LanceDB (lokal), GraphRAG, Journal, Auto-Observer (Regex + LLM Deep Extract)
- **Such-APIs:** Tavily ${config.apis?.tavily_key ? '✅ Key vorhanden' : '❌ kein Key'}, Brave ${config.apis?.brave_search_key ? '✅ Key vorhanden' : '❌ kein Key'}, DuckDuckGo ✅ (kein Key nötig)
- **Aktueller Channel:** ${channel}
- **Aktueller User:** ${canonicalUser}

## SELBST-ERWEITERUNG
Du kannst deine eigene Config jederzeit erweitern! Nutze das Tool \`config_update\` um neue Felder zu setzen.
Beispiel: Wenn ein User dir einen API Key gibt, speichere ihn mit config_update in xaventra.config.json.
Wenn du neue Fähigkeiten lernst, trage sie in die Config ein.
ALLES was du in xaventra.config.json schreibst, siehst du beim nächsten Gespräch automatisch hier oben.

WICHTIG: Sage NIEMALS "keine Config vorhanden" oder "Scheduled Tasks nicht eingerichtet" — prüfe ZUERST die obigen Daten bevor du Aussagen über dein System machst!`
        }
    } catch (err) { console.debug('[Pipeline] config read error:', err) }

    // Inject L9 Idle Learning knowledge (what Nova learned during idle time)
    if (contextPolicy.longTermMemory) try {
        const { getIdleLearningManager } = await import('../layers/L9-idle-learning.js')
        const idle = getIdleLearningManager()
        const relevantKnowledge = idle.getRelevantKnowledge(content)
        if (relevantKnowledge.length > 0) {
            const knowledgeBlock = relevantKnowledge
                .slice(0, 3)
                .map((k: any) => `- **${k.topic}**: ${k.summary} (Quelle: ${k.source})`)
                .join('\n')
            systemPrompt += `\n\n## GELERNTES WISSEN (Hintergrundrecherche)\n${knowledgeBlock}`
        }
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // Automatic performance recommendations from the trace analyzer. Learned
    // rules are not a separate block any more: owner rules are ENTSCHEIDUNGEN
    // (below), corrections are governed memory (Erinnerungskontext).
    try {
        const { buildTraceInsightsBlock } = await import('../learning/trace-analyzer.js')
        systemPrompt += buildTraceInsightsBlock()
    } catch (err) { console.debug('[Pipeline] trace insights not available:', err) }

    // Kausales Gedächtnis (Phase 8): owner instructions in a direct chat are
    // remembered without a command; matching decisions join the context.
    // Only the owner, never groups or system messages; writes only on the Main.
    if (principalContext.permission === 'owner' && isGroupMessage === false && !isSystemAuthored) try {
        const { observeOwnerMessage, buildDecisionContext } = await import('./decisions.js')
        const observed = observeOwnerMessage({ text: content, permission: principalContext.permission, principalId, channel, isGroup: isGroupMessage, systemAuthored: isSystemAuthored })
        const decisionBlock = buildDecisionContext(content, observed)
        if (decisionBlock) systemPrompt += decisionBlock
    } catch (err) { console.debug('[Pipeline] decisions not available:', err) }
    // 2.85 Paket A: an owner request about a service that is not connected is a recorded need
    // (connector + time only, never the text). Three in 14 days → one „verbinden?“ question.
    if (principalContext.permission === 'owner' && isGroupMessage === false && !isSystemAuthored) try {
        (await import('../connections/connection-demand.js')).noteOwnerRequest(content)
    } catch { /* a missing signal only means: no question */ }

    // ============================================
    // Known hosts are inventory data, never an authorization grant.
    // Names, IPs and logins are only shown to the owner (R2 A9).
    // ============================================
    if (contextPolicy.mesh && principalContext.permission === 'owner') try {
        const { loadHosts, formatKnownHostsContext } = await import('../tools/ssh-tool-hosts.js')
        const { environmentAwareness } = await import('../sensing/awareness.js')
        const { getNovaDataDir } = await import('./data-root.js')
        systemPrompt += `\n\n${environmentAwareness(getNovaDataDir(), 'owner')}`
        const inventory = formatKnownHostsContext(loadHosts())
        if (inventory) systemPrompt += `\n\n${inventory}`
    } catch { console.debug('[Pipeline] host inventory not available') }

    // Self-Architecture: disabled — 13.8K chars blew up the prompt budget
    // Nova learns about herself from CORE_FACTS + tool descriptions instead

    // Inject L15 SelfCheck awareness (proactive behavior + issue detection)
    if (contextPolicy.mode !== 'lean') try {
        const { getSelfCheckPrompt, getToolHealthPrompt } = await import('../layers/L15-self-check.js')
        const selfCheckBlock = getSelfCheckPrompt()

        // Tool Health: inject broken/degraded tool warnings
        const toolHealthBlock = getToolHealthPrompt()
        if (toolHealthBlock) systemPrompt += toolHealthBlock
        if (selfCheckBlock) {
            systemPrompt += selfCheckBlock
        }
    } catch (err) { console.debug('[Pipeline] L15 not available:', err) }

    // Inject Proactive Insights + Memory Consolidation
    if (contextPolicy.predictive) try {
        const { getInsightEngine, getMemoryConsolidator } = await import('../intelligence/autonomy-engine.js')
        // Insights and the weekly summary are owner-only (decided by the engine
        // from the viewer role); typed to compile before and after that change.
        const viewer = { permission: principalContext.permission }
        const insightBlock = (getInsightEngine() as { buildInsightPromptBlock(viewer?: { permission?: string }): string | null }).buildInsightPromptBlock(viewer)
        if (insightBlock) {
            systemPrompt += insightBlock
            console.log('[Pipeline] Injected proactive insights')
        }
        const consolidationContext = (getMemoryConsolidator() as { getConsolidationContext(viewer?: { permission?: string }): string | null }).getConsolidationContext(viewer)
        if (consolidationContext) {
            systemPrompt += consolidationContext
        }
    } catch (err) { console.debug('[Pipeline] autonomy engine not available:', err) }

    // Inject Journal context (recent days)
    // ============================================
    // Predictive Context Pre-loading (Phase 5)
    // Start async preload in parallel with other pipeline steps
    // ============================================
    let predictivePromise: Promise<any> | null = null
    if (contextPolicy.predictive) try {
        const { preloadContext } = await import('./predictive-context.js')
        // Same scopes as the governed memory context; legacy unscoped rows
        // are owner data and never reach another principal's prompt.
        predictivePromise = preloadContext(content, contextPolicy.timeBudgetMs, {
            scopes: [...compatiblePrincipalScopes(principalContext, canonicalUser), 'global'],
            includeUnscoped: principalContext.permission === 'owner',
        })
    } catch (err) { console.debug('[Pipeline] predictive context not available:', err) }

    if (contextPolicy.longTermMemory) try {
        const journal = (state as any).journal
        if (journal) {
            // The journal spans all users: owner-only, decided by the journal.
            const journalContext = journal.getJournalContextForPrompt(content, { permission: principalContext.permission })
            if (journalContext) systemPrompt += journalContext
        }
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // ============================================
    // Intelligence Modules — Entity Extraction + Planning + Reflection
    // ============================================

    // Entity Extractor: track what's being discussed per session
    if (contextPolicy.mode === 'deep') try {
        const intelligence = (state as any).intelligence
        if (intelligence?.entityExtractor) {
            const sessionId = `${channel}:${canonicalUser}`
            const ctx = intelligence.entityExtractor.updateSessionContext(sessionId, content)
            const entitySummary = intelligence.entityExtractor.getEntitySummary(ctx.entities)
            if (entitySummary) {
                systemPrompt += `\n\n## GESPRÄCHS-KONTEXT${entitySummary}`
                if (ctx.currentProject) systemPrompt += `\nAktuelles Projekt: ${ctx.currentProject}`
                if (ctx.lastMentionedPath) systemPrompt += `\nLetzter Pfad: ${ctx.lastMentionedPath}`
            }
        }
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // Task Planner: detect complex multi-step requests
    if (contextPolicy.mode === 'deep') try {
        const intelligence = (state as any).intelligence
        if (intelligence?.taskPlanner) {
            if (intelligence.taskPlanner.needsPlanning(content)) {
                const plan = intelligence.taskPlanner.createPlan(content)
                const planPrompt = intelligence.taskPlanner.getPlanningPrompt(plan)
                if (planPrompt) {
                    systemPrompt += planPrompt
                        ; (state as any).currentPlan = plan
                    console.log(`[Pipeline] TaskPlanner: ${plan.steps.length}-step plan created`)
                }
            }
        }
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // Self-Reflection: encourage quality self-checks
    if (contextPolicy.longTermMemory) try {
        const intelligence = (state as any).intelligence
        if (intelligence?.selfReflection) {
            systemPrompt += intelligence.selfReflection.getReflectionPrompt()
        }
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // ============================================
    // Intelligence Upgrade — Emotion + Patterns + Hardware
    // ============================================

    // Emotion Tracker: detect user mood and inject tone guidance
    if (contextPolicy.behavioral) try {
        const { analyzeEmotion, getEmotionPrompt } = await import('../intelligence/emotion-tracker.js')
        analyzeEmotion(canonicalUser, content)
        const emotionPrompt = getEmotionPrompt(canonicalUser)
        if (emotionPrompt) systemPrompt += emotionPrompt
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // User Pattern Tracker: track behavior and inject user context
    if (contextPolicy.behavioral) try {
        const { trackInteraction, getPatternPrompt } = await import('../intelligence/user-patterns.js')
        trackInteraction(canonicalUser, content)
        const patternPrompt = getPatternPrompt(canonicalUser)
        if (patternPrompt) systemPrompt += patternPrompt
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // Hardware Context: tell Nova about her host hardware
    // IMPORTANT: This overrides any old/wrong hardware info from memories
    if (contextPolicy.hardware) try {
        const { getHardwareSummary } = await import('./hardware-role.js')
        const hwSummary = getHardwareSummary()
        if (hwSummary) {
            systemPrompt += `\n\n## DEINE HARDWARE (LIVE vom System erkannt — IMMER diese Werte verwenden!)
Du läufst auf: ${hwSummary}
⚠️ WICHTIG: Falls du in Erinnerungen oder Gesprächen andere Hardware-Infos findest, die von den obigen Live-Werten abweichen, IGNORIERE diese — sie sind veraltet. Verwende AUSSCHLIESSLICH die oben angezeigten Live-Werte.\n`
        }
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // Mesh Router: inject node awareness so Nova knows about available compute nodes
    if (contextPolicy.mesh) try {
        const { getRoutingDiagnostics, detectMeshTaskType, routeTask } = await import('../mesh/mesh-router.js')
        const taskType = detectMeshTaskType(content)
        if (taskType !== 'general') {
            const decision = await routeTask(content)
            systemPrompt += `\n\n## 🌐 MESH ROUTING (automatisch erkannt)
Aufgabentyp: **${taskType}**
Empfohlener Node: **${decision.nodeName}** (${decision.host})
Grund: ${decision.reason}
Lokal: ${decision.isLocal ? 'JA' : 'NEIN — nutze ssh_command an ${decision.host}'}

WICHTIG: Wenn die Aufgabe zu einem anderen Node geroutet wird, nutze ssh_command mit dem Host des empfohlenen Nodes.`
        }
    } catch (err) { console.debug('[Pipeline] mesh router not available:', err) }

    // Companion Personality Directive + Workspace Awareness
    try {
        const cfgPath = join(process.cwd(), 'config.json')
        let wsRoot = join(homedir(), 'nova-workspace')
        try {
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
            wsRoot = cfg.workspace?.root || wsRoot
        } catch { /* use default */ }

        // Ensure workspace subdirectories exist
        const dirs = ['projekte', 'scripts', 'bilder', 'skills', 'downloads']
        for (const d of dirs) {
            const p = join(wsRoot, d)
            if (!existsSync(p)) try { mkdirSync(p, { recursive: true }) } catch { /* ok */ }
        }

        systemPrompt += `\n\n## DEIN ARBEITSVERZEICHNIS & DATEISYSTEM (KRITISCH)
Dein Workspace: ${wsRoot}
Dein CWD (process.cwd()): ${process.cwd()}

Ordnerstruktur:
- ${wsRoot}\\\\projekte\\\\  → Für alle Projekte und Code
- ${wsRoot}\\\\scripts\\\\   → Für Skripte und Automatisierungen  
- ${wsRoot}\\\\bilder\\\\    → Für generierte Bilder und Screenshots
- ${wsRoot}\\\\skills\\\\    → Für gelernte Skills und Vorlagen
- ${wsRoot}\\\\downloads\\\\ → Für heruntergeladene Dateien & empfangene Telegram-Dateien

⚠️ ANTI-HALLUZINATION — DU MUSST DAS WISSEN:
1. Du HAST vollen Zugriff auf das Dateisystem. Du kannst Dateien lesen, schreiben, suchen und erstellen.
2. Nutze find_files mit path="${process.cwd()}" oder "${wsRoot}" um Dateien zu finden.
3. Nutze runcommand mit Befehlen wie "dir /s *.pdf" oder "ls -la" um Ordner zu durchsuchen.
4. Sage NIEMALS "ich habe keinen Arbeitsordner" oder "ich kann nicht auf Dateien zugreifen" — das ist UNWAHR.
5. Wenn der User nach Dateien fragt, SUCHE AKTIV mit find_files oder runcommand — warte nicht auf Tool-Ergebnisse die nie kommen.
6. Speichere NIEMALS Dateien in ${process.cwd()} direkt — das ist Source-Code! Nutze ${wsRoot}.\n`
    } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

    // Compact action rules — replaces 120-line ANTI-HALLUZINATION + PARTNER-MODUS block
    systemPrompt += `\n\n## HANDELN
Wenn eine Aufgabe ein Tool braucht → sofort aufrufen. Nicht ankündigen — tun.
Nichts wissen? → Tool aufrufen und nachschauen. Niemals raten oder erfinden.
Remote-Aktion? → ssh_command direkt. Datei schicken? → send_file.
Auftrag starten? → start_mission Tool aufrufen, nicht schreiben.
Kein passendes Tool? → build_skill aufrufen und einen reviewbaren Vorschlag erzeugen. Nicht nur erklären.
Neue Fähigkeit/Skill gewünscht? → recherchieren, build_skill aufrufen, Freigabe abwarten, danach real testen.
Eine Lösung erst nach erfolgreichem Tool-Test als gelernt speichern. Nie ungeprüfte Textantworten lernen.`


    // ============================================
    // Soul 2.0 — Adaptive Persona (Sentiment-based)
    // ============================================
    try {
        const { selectPersonaMode, buildPersonaContext, detectContext } = await import('./soul-v2.js')
        const context = detectContext(content)
        const { mode, reason, sentiment } = selectPersonaMode(content, context)
        const modeConfig = buildPersonaContext(mode)

        systemPrompt += `\n\n${modeConfig}
Erkanntes Sentiment: ${sentiment.sentiment} (${(sentiment.confidence * 100).toFixed(0)}%) | Grund: ${reason} `
        console.log(`[Soul 2.0]Mode: ${mode} | Sentiment: ${sentiment.sentiment} | Reason: ${reason} | User: ${canonicalUser} `)
    } catch (err) {
        console.log(`[Soul 2.0] Not available: ${err} `)
    }

    // ============================================
    // Correction Detection (Layer 7 Learning)
    // ============================================
    try {
        const { processForCorrection, buildFailureContext } = await import('./correction-detector.js')
        const correction = processForCorrection(content, principalId)
        const correctedExchange = correction.isCorrection || correction.hasCorrectVersion

        if (correctedExchange && correction.hasCorrectVersion) {
            systemPrompt += '\n\n## Konkrete Nutzerkorrektur\nDie aktuelle Nachricht enthält eine konkrete Korrektur oder Statusangabe. Speichere sie nur mit der vorhandenen Provenienz, prüfe zeitabhängige Angaben gegen aktuelle Release-/World-Model-Evidence und antworte inhaltlich. Eine pauschale Lernbestätigung ist keine ausreichende Antwort.'
        }

        // Persist the correction before any acknowledgement/early return.
        // Previously the "how would it be correct?" branch returned first and
        // discarded the very feedback Nova was supposed to remember.
        // Stored once: governed correction memory. An owner rule ("ab jetzt …")
        // in the same message was already recorded by decisions.ts above; the
        // outcome ledger only marks the corrected run as rejected.
        if (correctedExchange) {
            try {
                const lastAssistantMsg = (state as any).lastAssistantMessages?.get(principalId) || ''
                const { recordUserCorrectionMemory } = await import('../memory/correction-memory.js')
                await recordUserCorrectionMemory({
                    scope: principalScope(principalId),
                    message: content,
                    priorAssistantResponse: lastAssistantMsg,
                    channel,
                    sessionId: `${channel}:${principalId}`,
                })
                const { recordFeedbackForLatestUserRun } = await import('./outcome-ledger.js')
                recordFeedbackForLatestUserRun({
                    userId: principalId,
                    channel,
                    rating: 1,
                    accepted: false,
                    comment: 'User correction',
                    correction: content.slice(0, 300),
                })
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }
        }

        if (correction.shouldTriggerLearning && correction.lastToolCall) {
            const { getToolUsageLearner } = await import('../layers/L7-tool-learning.js')
            getToolUsageLearner().recordUsage(
                correction.lastToolCall.toolName,
                content,
                correction.lastToolCall.params,
                false,
                principalId,
            )
        }

        if (correctedExchange && correction.message) {
            console.log(`[L7 Learning] Correction handled: ${correction.message}`)
            await replyFn(correction.message)
            logSession(canonicalUser, channel, 'assistant', correction.message)
            return
        }

        // Add failure context to system prompt so Nova avoids same mistakes
        const failureContext = buildFailureContext()
        if (failureContext) {
            systemPrompt += failureContext
        }
    } catch (err) {
        console.log(`[L7 Learning] Correction detector not available: ${err} `)
    }

    // ============================================
    // Auto-Observer: Inject known facts into system prompt
    // ============================================
    const isSystemMessage = isSystemAuthored
    if (!isSystemMessage) try {

        // Observe user message for fact extraction — skip system injections
        if (memoryDecision.observe) {
            const { getAutoObserver } = await import('../memory/auto-observer.js')
            const observer = getAutoObserver()
            await observer.initialize()
            // The role decides alias registration (owner only). Typed for the
            // options parameter so this compiles before and after that change.
            await (observer as { observe(userId: string, message: string, role: 'user' | 'assistant', sessionId?: string, options?: { permission?: string }): Promise<unknown> })
                .observe(principalId, content, 'user', `${channel}-${Date.now()}`, { permission: principalContext.permission })
        }

        // One memory prompt boundary combines governed facts with compact,
        // persistent conversation continuity. It does not inject raw history.
        const { buildMemoryContext } = await import('../memory/memory-context.js')
        const memoryScopes = [...compatiblePrincipalScopes(principalContext, canonicalUser), 'global']
        const userContext = await buildMemoryContext({
            scopes: memoryScopes,
            principalId,
            channel,
            query: content,
            observeUserTurn: memoryDecision.observe,
            legacySessionNames: [principalId, canonicalUser, from],
        })
        if (userContext) systemPrompt += '\n\n' + userContext
    } catch (err) {
        // Observer not critical - continue without it
    }

    // P8 Routine-Skills: passt die Owner-Anfrage zu einem gespeicherten Skill,
    // steht sein Plan zuerst im Prompt. Er erlaubt nichts zusätzlich: jeder
    // Schritt läuft weiter durch Autorisierung, Aktions-Policy und Karten.
    try {
        const { getRoutineSkillStore, routineSkillHint } = await import('../learning/routine-skills.js')
        const routineHint = routineSkillHint(getRoutineSkillStore(), {
            principalId, permission: principalContext.permission, isGroup: requestIsGroup,
            systemAuthored: isSystemAuthored, request: content,
        })
        if (routineHint) {
            systemPrompt += '\n\n' + routineHint.prompt
            routineSkillApplied = routineHint.skillId
            console.log(`[Skills] Routine-Skill geladen: ${routineHint.skillId}`)
        }
    } catch (err) { console.debug('[Pipeline] routine skills not available:', err) }

    // ============================================
    // L6 Cold Storage: Inject USER.md + MEMORY.md into system prompt
    // ============================================
    // Archived USER.md/MEMORY.md is not an independent prompt authority.

    // LanceDB, Core Facts and Knowledge Graph are governed projections used by
    // tools and retrieval. They are deliberately not injected a second time.

    // ============================================
    // Empathy Context — Track user work patterns
    // Nova notices when you've been at something for a while
    // ============================================
    try {
        const sessionKey = `empathy:${canonicalUser}:${channel} `
        const empathyState = (globalThis as any).__novaEmpathy ??= new Map()
        const now_ms = Date.now()

        let userCtx = empathyState.get(sessionKey)
        if (!userCtx) {
            userCtx = {
                sessionStart: now_ms,
                messageCount: 0,
                topics: [] as string[],
                lastMessage: now_ms,
                errorCount: 0,
            }
            empathyState.set(sessionKey, userCtx)
        }

        userCtx.messageCount++
        userCtx.lastMessage = now_ms

        // Track if message mentions errors/bugs
        const errorKeywords = /error|fehler|bug|crash|broken|kaputt|geht nicht|funktioniert nicht|problem|issue/i
        if (errorKeywords.test(content)) {
            userCtx.errorCount++
        }

        // Session duration
        const sessionMinutes = Math.round((now_ms - userCtx.sessionStart) / 60000)

        // Inject empathy context if user has been working for a while
        if (sessionMinutes > 30 || userCtx.errorCount >= 3 || userCtx.messageCount > 15) {
            let empathyBlock = `\n\n## KONTEXT - AWARENESS(Empathie) \n`
            empathyBlock += `- Session - Dauer: ${sessionMinutes} Minuten(${userCtx.messageCount} Nachrichten) \n`

            if (userCtx.errorCount >= 3) {
                empathyBlock += `- ⚠️ Der User hat ${userCtx.errorCount}x Fehler / Probleme erwähnt — er kämpft mit etwas.Sei besonders hilfreich und biete proaktiv Lösungsansätze an.\n`
            }
            if (sessionMinutes > 120) {
                empathyBlock += `- ⚠️ Der User arbeitet seit über 2 Stunden.Wenn angemessen, schlage eine kurze Pause vor.\n`
            }
            if (sessionMinutes > 60 && userCtx.messageCount > 10) {
                empathyBlock += `- 💡 Lange Session mit vielen Nachrichten — fasse gelegentlich den Fortschritt zusammen.\n`
            }

            systemPrompt += empathyBlock
            console.log(`[Empathy] Session: ${sessionMinutes} min, ${userCtx.messageCount} msgs, ${userCtx.errorCount} errors`)
        }

        // Reset session after 4 hours of inactivity
        if (now_ms - userCtx.lastMessage > 14400000) {
            empathyState.delete(sessionKey)
        }
    } catch (err) { console.debug('[Pipeline] empathy tracker error:', err) }

    // ============================================
    // Result Analyzer — Proactive Result Reporting
    // Nova reports tool results immediately, never waits for "und?"
    // ============================================
    try {
        const { getProactivityPrompt } = await import('../intelligence/result-analyzer.js')
        systemPrompt += getProactivityPrompt()
    } catch (err) { console.debug('[Pipeline] result analyzer not available:', err) }

    // ============================================
    // Predictive Context — Collect pre-loaded results
    // ============================================
    if (predictivePromise) {
        try {
            const { buildPreloadedPrompt } = await import('./predictive-context.js')
            const preloaded = await predictivePromise
            const predictiveContext = buildPreloadedPrompt(preloaded)
            if (predictiveContext) {
                systemPrompt += '\n\n' + predictiveContext
                console.log(`[PredictiveContext] Injected: ${preloaded.memories.length} memories, ${preloaded.graphFacts.length} facts, ${preloaded.sshHostInfo.length} hosts(${preloaded.preloadTimeMs}ms)`)
            }
        } catch (err) { console.debug('[Pipeline] non-critical error:', err) }
    }

    // (Slash commands moved to top of pipeline — early exit before prompt assembly)

    // Multi-User Context — per-user info + group context + tool restrictions
    const userCtx = requestUserContext
    const groupCtx = requestGroupContext
    const userPerm = principalContext.permission || 'guest'

    if (userCtx || groupCtx || (userPerm && userPerm !== 'owner')) {
        systemPrompt += '\n\n## USER-KONTEXT'
        if (userCtx) systemPrompt += `\n${userCtx}`
        if (groupCtx) systemPrompt += `\n${groupCtx}`
        if (userPerm === 'guest') {
            systemPrompt += '\n⚠️ Dieser User ist ein GAST. Sei freundlich aber nutze KEINE kritischen Tools (SSH, Dateisystem-Schreibzugriff, Systembefehle). Verweise bei Bedarf auf einen Admin.'
        } else if (userPerm === 'user') {
            systemPrompt += '\n📋 Dieser User hat Standard-Rechte. Kein SSH, keine Systembefehle, kein self_evolve.'
        }
    }

    // Strict Implementation Mode — inject if active
    try {
        const { getStrictModePrompt } = await import('./strict-mode.js')
        const strictPrompt = getStrictModePrompt()
        if (strictPrompt) {
            systemPrompt += '\n\n' + strictPrompt
            console.log('[Pipeline] 🔒 Strict Implementation Mode aktiv')
        }
    } catch (err) { console.debug('[Pipeline] strict mode not available:', err) }

    if (!state.llm) {
        console.error(`[Nova] LLM nicht verfügbar — versuche Reconnect`)
        // Try to reconnect LLM
        try {
            const { createLLM } = await import('./llm-factory.js')
            const config = (state as any).config
            if (config) {
                const result = await createLLM(config)
                if (result.llm) {
                    state.llm = result.llm
                    console.log(`[Nova] ✅ LLM auto - reconnected: ${(result.llm as any).modelId || 'unknown'} `)
                }
            }
        } catch (reconnErr) {
            console.error(`[Nova] LLM reconnect failed: ${reconnErr} `)
        }

        // If still no LLM after reconnect attempt
        if (!state.llm) {
            await replyFn(`⚠️ Kein LLM verbunden.Versuche / models oder / status für Details.`)
            return
        }
    }

    try {
        // ============================================
        // Direct Runtime Introspection — no LLM guessing for identity/status.
        // ============================================
        const { runtimeQuestion, runtimeModelContext } = await import('./runtime-question.js')
        const turns = recentSessionTurns(canonicalUser, channel)
        // The current user turn is already journaled; follow-up scope is the preceding answer.
        if (turns.at(-1)?.role === 'user' && turns.at(-1)?.content === content.slice(0, 2000)) turns.pop()
        const question = runtimeQuestion(content, turns)
        // Mixed questions still need measured identity; keep the normal agent
        // path so their other clauses are answered rather than silently dropped.
        const measuredModelContext = !question && !isSystemAuthored ? await runtimeModelContext(content, state.llm) : ''
        systemPrompt += measuredModelContext
        const requiresFreshRuntimeEvidence = Boolean(measuredModelContext) || mentionsEnvironment(content) || containsHttpUrl(content) || detectActionIntent(content).kind === 'screenshot'
        const asksModel = question?.model
        const asksNovaVersion = question?.version
        const asksNovaIdentity = question?.identity
        const asksMeshRuntime = question?.mesh

        if (asksModel || asksNovaVersion || asksNovaIdentity || asksMeshRuntime) {
            let version = 'unbekannt'
            try {
                const pkg = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf-8'))
                version = pkg.version || version
            } catch { /* optional */ }

            const model = state.llm?.modelId || (globalThis as any).__novaState?.activeModel || 'unbekannt'
            const provider = state.llm?.providerId || 'unbekannt'
            const lines: string[] = []
            if (asksNovaIdentity) lines.push((await import('./self-description.js')).XAVENTRA_IDENTITY)
            if (asksNovaVersion) lines.push(`Xaventra läuft hier auf v${version}.`)
            if (asksModel) {
                let codexRoute = false
                let codexNode = ''
                try {
                    const { getCodexDisplayModel } = await import('../auth/codex-runtime.js')
                    const codex = await getCodexDisplayModel(principalId)
                    codexRoute = Boolean(codex.available && codex.authenticated && codex.preferred)
                    codexNode = codex.nodeId || ''
                } catch { /* Codex is optional. */ }
                lines.push(`Konfiguriertes Runtime-Modell: ${provider}/${model}.`)
                const identity = await state.llm?.runtimeModelIdentity?.()
                lines.push(identity?.model
                    ? `Der konfigurierte Server meldet für diesen Alias: ${identity.model}.`
                    : 'Den vollständigen Modellnamen hinter diesem Alias konnte ich nicht verifizieren.')
                lines.push('Eine einzelne Anfrage kann durch Routing oder Failover ein anderes Modell verwenden.')
                lines.push(codexRoute
                    ? `Für Code, größere Umbauten und schwierige Fehlersuche wird deine authentifizierte Codex-Route${codexNode ? ` auf ${codexNode}` : ''} gewählt; Smalltalk, Kurzes, Bilder und Privates laufen über ${provider}/${model}, das auch der Fallback ist.`
                    : `Codex ist für diesen Benutzer derzeit nicht als bevorzugte Route verfügbar; normale Chats laufen über ${provider}/${model}.`)
            }
            if (asksMeshRuntime) {
                try {
                    const { discoverNodes } = await import('../mesh/mesh-registry.js')
                    const nodes = await discoverNodes()
                    const now = Date.now()
                    lines.push(nodes.length === 0 ? 'Mesh: keine Nodes in der Registry gefunden.' : `Mesh: ${nodes.length} Node(s) aus Registry/Supabase gelesen:`)
                    for (const node of nodes.slice(0, 12)) {
                        const last = node.last_heartbeat ? Math.round((now - new Date(node.last_heartbeat).getTime()) / 1000) : -1
                        const age = last >= 0 ? `${last}s alt` : 'Heartbeat unbekannt'
                        const ip = node.ip ? ` ${node.ip}` : ''
                        const models = node.software?.ollama_models?.slice(0, 3).join(', ')
                        const modelText = models ? ` | Ollama: ${models}${(node.software?.ollama_models?.length || 0) > 3 ? ', ...' : ''}` : ''
                        lines.push(`- ${node.hostname || node.node_id}${ip}: ${node.status}, v${node.version || '?'}, ${age}${modelText}`)
                    }
                } catch (err) {
                    lines.push(`Mesh: Registry konnte nicht gelesen werden (${err instanceof Error ? err.message : String(err)}).`)
                }
            }
            await replyFn(lines.join('\n'))
            logSession(canonicalUser, channel, 'assistant', lines.join('\n'))
            return
        }

        // ============================================
        // Response Cache — Check before LLM call
        // ============================================
        let cachedResponse: string | null = null
        // Computed once: lookup and store must use the same history.
        const cacheKeyMessages = responseCacheMessages(canonicalUser, channel, content)
        try {
            const { getCachedResponse } = await import('../llm/response-cache.js')
            if (!requiresFreshRuntimeEvidence) cachedResponse = getCachedResponse(systemPrompt, cacheKeyMessages)
            if (cachedResponse) {
                console.log(`[Pipeline] ✅ Cache HIT — skipping LLM call`)
            }
        } catch (err) { console.debug('[Pipeline] response cache not available:', err) }

        // If cache hit and no image (images need fresh processing)
        if (cachedResponse && !image) {
            const result = {
                content: cachedResponse,
                toolsExecuted: [] as string[],
                sessionId: 'cache-hit',
                toolExecutions: [],
            }

            // Skip straight to response delivery
            await replyFn(result.content)
            logSession(canonicalUser, channel, 'assistant', result.content)
            console.log(`[Nova][${channel}]Cache - Antwort gesendet(${result.content.length} chars)`)
            return
        }

        // Intent Router disabled — user configures primary model in xaventra.config.json.
        // No auto-switching based on task type. Primary model handles everything.
        // Fallback chain (model-fallback.ts) kicks in only if primary LLM call fails.
        const routedModel: string | undefined = undefined

        // ============================================
        // Use Nova Agent Runner (Full Featured)
        // ============================================
        traceStep('context:complete')
        const { runNovaAgent } = await import('../agents/nova-runner.js')
        traceStep('agent:loaded')

        // Run the full agent with a hard cap to prevent infinite blocking.
        // Ops tasks may include SSH/SCP/restart checks, so keep this above per-tool slow timeouts.
        // NovaOS: ein Installationsauftrag kann mehrere Werkzeugaufrufe
        // hintereinander brauchen (apt update, install, verify). 300 s reichen
        // dafuer nicht. Ausserhalb von NovaOS bleibt es bei 300 s.
        const TOTAL_TIMEOUT = Number(process.env.NOVA_AGENT_TIMEOUT_MS)
            || (process.env.NOVA_OS_MODE === 'true' ? 2_400_000 : 300_000)

        // Task Tracker: start tracking this task. The id lets a concurrent
        // request's completion leave this task alone.
        try {
            const { startTask } = await import('./task-tracker.js')
            trackedTaskId = (await startTask(content, channel, canonicalUser))?.id
        } catch (err) { console.debug('[Pipeline] task tracker error:', err) }

        // Plugin Hook: beforeLLMCall — plugins may inject context (e.g. Brain knowledge search)
        // Return value is ignored; plugins append to systemPrompt via registerHook side-effects.
        // beforeLLMCall is owned by nova-runner, where injected messages are
        // consumed. Running the hook here as well doubled plugin latency.

        // Apply routed model if available
        const llmForCall = routedModel
            ? Object.assign(Object.create(Object.getPrototypeOf(state.llm)), state.llm, { modelId: routedModel })
            : state.llm

        // Orchestrator: Start watching this task for timeout
        const taskId = `msg_${Date.now()}_${canonicalUser} `
        const orchestrator = (state as any).orchestrator
        if (orchestrator) {
            orchestrator.watchTask(taskId, content.slice(0, 200), TOTAL_TIMEOUT)
        }

        // Size-guard: cap systemPrompt — vLLM 122B still needs to stay fast
        // 16k chars ≈ 4k tokens for system, leaving ample room for chat history + response
        const MAX_SYSTEM_PROMPT = contextPolicy.maxPromptChars
        if (systemPrompt.length > MAX_SYSTEM_PROMPT) {
            console.log(`[Pipeline] ⚠️ systemPrompt too large: ${systemPrompt.length} chars, capping to ${MAX_SYSTEM_PROMPT}`)
            const { applySystemPromptBudget } = await import('./prompt-budget.js')
            const budgeted = applySystemPromptBudget(systemPrompt, MAX_SYSTEM_PROMPT, content)
            systemPrompt = budgeted.prompt
            console.log(`[Pipeline] Prompt budgets: ${JSON.stringify(budgeted.sections)}`)
        }
        console.log(`[Pipeline] systemPrompt size: ${systemPrompt.length} chars`)

        let result: any
        const executionTools = execution?.allowedTools && state.tools
            ? state.tools.getAll().filter((tool: any) => execution.allowedTools!.includes(tool.name))
            : undefined
        let lastProgress = 'LLM/Tools laufen'
        // Progress is closed as soon as the main agent run settles, so a late
        // step update or heartbeat can never arrive after the final answer.
        const progress = createProgressGate(replyFn)
        const progressStartedAt = Date.now()
        const progressChannel = channel.toLowerCase()
        const shouldSendProgress =
            !execution &&
            !isSystemMessage &&
            !['internal', 'voice'].includes(progressChannel) &&
            canonicalUser !== 'nova-self' &&
            canonicalUser !== 'Nova-Autonomy'
        const progressTimer = shouldSendProgress
            ? setInterval(async () => {
                const elapsed = Math.round((Date.now() - progressStartedAt) / 1000)
                if (progress.closed) return
                try {
                    await progress.send(`⏳ Ich arbeite noch (${elapsed}s): ${lastProgress}`)
                } catch (err) {
                    console.log(`[Pipeline] Progress heartbeat failed: ${err} `)
                }
            }, 25_000)
            : null
        if (progressTimer?.unref) progressTimer.unref()

        try {
            traceStep('agent:start')
            execution?.abortSignal?.throwIfAborted()
            result = await runWithAbortDeadline(agentSignal =>
                runNovaAgent({
                    userId: principalId,
                    authUserId: from,
                    channel,
                    content,
                    image,
                    systemPrompt,
                    llm: llmForCall,
                    tools: executionTools,
                    abortSignal: agentSignal,
                    onStepUpdate: async (status: string) => {
                        if (progress.closed || agentSignal.aborted) return
                        try {
                            lastProgress = status
                            // Zentrale Fortschrittsdatei fuer ALLE Oberflaechen.
                            // Ohne die zeigt Nova Desktop nur zeitgeratene Saetze
                            // ("Nova versteht den Auftrag und plant") und die
                            // Textkonsole einen nackten Sekundenzaehler — man
                            // sieht, DASS sie arbeitet, nie WAS sie tut.
                            if (process.env.NOVA_OS_MODE === 'true') {
                                try {
                                    const { writeFileSync, mkdirSync } = await import('node:fs')
                                    mkdirSync('/run/novaos', { recursive: true })
                                    writeFileSync('/run/novaos/fortschritt',
                                        String(status).replace(/\s+/g, ' ').slice(0, 160))
                                } catch { /* Anzeige darf den Lauf nie stoppen */ }
                            }
                            await progress.send(status)
                        } catch (err) {
                            console.log(`[Pipeline] Step update delivery failed: ${err} `)
                        }
                    },
                    conversationId: desktopContext?.roomId,
                    botId: desktopBot?.id,
                    preferredNodeIds: desktopContext?.preferredNodeIds,
                    modelOverride: desktopContext?.modelMode === 'pinned' && desktopContext.pinnedModel
                        ? {
                            model: desktopContext.pinnedModel,
                            provider: desktopContext.pinnedProvider || desktopBot?.modelPolicy.provider,
                            nodeId: desktopContext.pinnedNodeId,
                            baseUrl: desktopContext.pinnedEndpoint,
                        }
                        : desktopBot?.modelPolicy.mode === 'pinned' && desktopBot.modelPolicy.model
                            ? { model: desktopBot.modelPolicy.model, provider: desktopBot.modelPolicy.provider }
                            : undefined,
                    deniedTools: desktopBot?.deniedTools,
                    workspaceId: desktopContext?.workspaceId,
                }), { timeoutMs: TOTAL_TIMEOUT, parentSignal: execution?.abortSignal })

            // Orchestrator: Task completed successfully
            if (orchestrator) {
                orchestrator.completeTask(taskId, result.content?.slice(0, 200))
            }
        } catch (err) {
            // Orchestrator: Task failed
            if (orchestrator) {
                orchestrator.completeTask(taskId, `Error: ${err} `)
            }
            throw err
        } finally {
            progress.close()
            if (progressTimer) clearInterval(progressTimer)
        }

        // ============================================
        // Auto-Send Screenshots to User
        // If tool execution produced a screenshot, send it directly in chat
        // ============================================
        // Live 30.09.2026 every screenshot arrived twice: desktop_screenshot had
        // already sent it and this block sent the same file again.
        const { pendingScreenshot } = await import('./screenshot-delivery.js')
        let screenshotDelivered = (result as any).screenshotDelivered === true
        if (!isNodeScreenshotRequest(content) && pendingScreenshot(result as any) && channel.toLowerCase() === 'telegram') {
            try {
                const tg = state.channels?.telegram || state.telegram
                if (tg?.sendPhoto) {
                    const { existsSync } = await import('node:fs')
                    const imgPath = (result as any).screenshotPath
                    if (existsSync(imgPath)) {
                        await tg.sendPhoto(from, imgPath, '📸 Desktop Screenshot')
                        screenshotDelivered = true
                        console.log(`[Pipeline] 📸 Screenshot auto - sent to ${from}: ${imgPath} `)
                    }
                }
            } catch (err) {
                console.log(`[Pipeline] ⚠ Screenshot auto - send failed: ${err} `)
            }
        }

        // ============================================
        // Layer 0 - Supervise Response with Retry Logic
        // ============================================
        const { superviseResponse, trackPattern } = await import('../layers/L0-supervisor.js')
        const { clearSession } = await import('../agents/nova-runner.js')

        let supervised = superviseResponse(result.content, {
            attempt: 1,
            preserveValidatedText: result.validation?.success === true
                && result.validation.criteria.some(criterion => criterion.criterionId === 'response-constraints' && criterion.success),
        })
        let attempt = 1
        const MAX_RETRIES = 3

        // Retry loop if response is empty
        // The ExecutionKernel owns retries for all modern agent results. This
        // loop remains only for older/plugin agents without an actionState.
        while (supervised.needsRetry && !(result as any).actionState && attempt < MAX_RETRIES) {
            attempt++
            console.log(`[L0] ⚠️ Leere Antwort - Retry ${attempt}/${MAX_RETRIES}`)

            // Reset session if supervisor says so
            if (supervised.shouldResetSession) {
                console.log(`[L0] 🔄 Session-Reset für ${from}`)
                clearSession(principalId, channel, { conversationId: desktopContext?.roomId, botId: desktopBot?.id })
            }

            // Retry the agent call
            const retryResult = await runWithAbortDeadline(agentSignal => runNovaAgent({
                userId: principalId,
                authUserId: from,
                channel,
                content,
                image,
                systemPrompt: loadSoul(),
                llm: state.llm,
                tools: executionTools,
                abortSignal: agentSignal,
            }), { timeoutMs: TOTAL_TIMEOUT, parentSignal: execution?.abortSignal })

            supervised = superviseResponse(retryResult.content, { attempt })
            result = retryResult
        }

        if (supervised.wasFixed) {
            console.log(`[L0] ⚠️ Response korrigiert: ${supervised.fixes.join(', ')}`)
        }

        // Track pattern for learning — but never for system-authored messages
        // (self-think/heartbeat/autonomy), which would otherwise inflate the
        // L7 pattern store with Nova's own prompts.
        if (!isSystemAuthored) {
            trackPattern(from, content, result.toolsExecuted[0])
        }

        // Tracker completion happens only after final delivery/validation below.

        // ════════════════════════════════════════════════════════════════════
        // ANNOUNCE-WITHOUT-ACT GUARD
        // ════════════════════════════════════════════════════════════════════
        // MiniMax-M3 sometimes announces an action ("Klar! Check ich:", "Auf geht's:")
        // and ends with a colon, but never calls the tool. Detect this pattern and
        // force ONE retry with a hard instruction to actually call the tools.
        {
            const toolsUsed = (result.toolsExecuted || []).length
            const text = (supervised.content || '').trim()
            const looksLikeAnnouncement =
                detectActionIntent(content).requiresTool &&
                toolsUsed === 0 &&
                text.length < 120 &&
                (
                    /[:：]\s*$/.test(text) ||                                   // ends with colon
                    /\b(check ich|schau ich|mach ich|hol ich|such ich|prüf ich|leg los|auf geht'?s|moment|sekunde|einen moment)\b/i.test(text) ||
                    /\b(ich (werde|würde|kann)|lass mich)\b.*\b(prüf|check|schau|hol|such|nachsehen|nachschauen)/i.test(text) ||
                    // Promises like "ich bau mir jetzt einen Skill" are not
                    // results and must trigger a real function call.
                    /\b(ich\s+)?(bau|baue|erstell|erstelle|installier|installiere|konfigurier|konfiguriere|teste)\b.{0,80}\b(jetzt|erstmal|zuerst|gleich|skill|tool|dienst|endpoint)/i.test(text) ||
                    /\b(lass mich|ich)\b.{0,50}\b(erstmal|zuerst)\b.{0,80}\b(schau|prüf|check|such|teste|herausfind)/i.test(text)
                )

            if (!(result as any).actionState && looksLikeAnnouncement) {
                console.log(`[Pipeline] 🔄 Announce-without-act erkannt ("${text.slice(0, 50)}") — erzwinge Tool-Retry`)
                try {
                    const { runNovaAgent } = await import('../agents/nova-runner.js')
                    const retryResult = await runWithAbortDeadline(agentSignal => runNovaAgent({
                        userId: principalId,
                        authUserId: from,
                        channel,
                        content,
                        image,
                        systemPrompt: systemPrompt + '\n\n🚨 PFLICHT: Beantworte die Anfrage indem du JETZT die passenden Tools über den Function-Call-Mechanismus aufrufst. Gib KEINE Ankündigung wie "ich check das" — RUF DIE TOOLS AUF und liefere das Ergebnis. Für Uhrzeit: get_current_time. Für offene Programme/Fenster: run_command oder ein Desktop-Tool.',
                        llm: state.llm,
                        tools: executionTools,
                        abortSignal: agentSignal,
                    }), { timeoutMs: TOTAL_TIMEOUT, parentSignal: execution?.abortSignal })
                    const retryExecutedTools = retryResult.toolsExecuted?.length || 0
                    if (retryExecutedTools > 0 || (!detectActionIntent(content).requiresTool && retryResult.content && retryResult.content.trim().length > text.length)) {
                        console.log(`[Pipeline] ✅ Retry lieferte echte Antwort (${retryResult.toolsExecuted?.length || 0} tools)`)
                        supervised.content = retryResult.content
                        ;(result as any).toolsExecuted = retryResult.toolsExecuted || []
                        ;(result as any).toolExecutions = (retryResult as any).toolExecutions || []
                        ;(result as any).screenshotPath = retryResult.screenshotPath
                    }
                } catch (retryErr) {
                    if (execution?.abortSignal?.aborted) throw retryErr
                    console.debug('[Pipeline] Announce-retry failed:', retryErr)
                }
            }
        }

        // Deterministic fallback for screenshots. Some providers acknowledge
        // the request without a tool call, others wander into introspection
        // and stop there (live 01.10.2026). Whatever else ran: without a
        // delivered picture or a successful capture, execute the known local
        // tool through the same authorization boundary.
        const preGateIntent = isSystemMessage ? { requiresTool: false as const, kind: 'none' as const } : detectActionIntent(content)
        const { shouldRunScreenshotFallback, applyScreenshotFallback } = await import('./screenshot-delivery.js')
        if (!isNodeScreenshotRequest(content) && shouldRunScreenshotFallback({ isSystemMessage, intentKind: preGateIntent.kind, screenshotDelivered, result: result as any })) {
            try {
                const tg = state.channels?.telegram || state.telegram
                const captured = await runAuthorizedScreenshotFallback({
                    channel, from, principalId, content,
                    tools: state.tools,
                    telegram: tg,
                })
                if (captured) {
                    const imgPath = captured.path
                    screenshotDelivered = true
                    // Keeps earlier tool evidence and marks a kernel actionState
                    // fulfilled, so the evidence gate below keeps this text.
                    applyScreenshotFallback(result as any, captured)
                    const currentTime = new Date().toLocaleTimeString('de-DE', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'Europe/Vienna',
                    })
                    supervised.content = `Screenshot wurde aufgenommen und gesendet. Aktuelle Uhrzeit: ${currentTime} Uhr.`
                    console.log(`[Pipeline] Deterministic screenshot fallback succeeded: ${imgPath}`)
                }
            } catch (fallbackErr) {
                console.log(`[Pipeline] Deterministic screenshot fallback failed: ${fallbackErr}`)
            }
        }

        // A retry can create the screenshot after the first delivery opportunity.
        if (!isNodeScreenshotRequest(content) && !screenshotDelivered && (result as any).screenshotPath && channel.toLowerCase() === 'telegram') {
            try {
                const tg = state.channels?.telegram || state.telegram
                const imgPath = (result as any).screenshotPath
                if (tg?.sendPhoto && existsSync(imgPath)) {
                    await tg.sendPhoto(from, imgPath, 'Desktop Screenshot')
                    screenshotDelivered = true
                    console.log(`[Pipeline] Screenshot sent after tool retry to ${from}: ${imgPath}`)
                }
            } catch (err) {
                console.log(`[Pipeline] Screenshot delivery after retry failed: ${err}`)
            }
        }

        // Evidence gate: live state and side effects may only be reported after a
        // successful tool call. Screenshot success additionally requires sendPhoto.
        const kernelState = (result as any).actionState
        const actionIntent = kernelState
            ? { requiresTool: kernelState.requiresTool, kind: kernelState.kind }
            : isSystemMessage ? { requiresTool: false as const, kind: 'none' as const } : detectActionIntent(content)
        const successfulExecutions = ((result as any).toolExecutions || []).filter((execution: any) => execution.success)
        const failedExecutions = ((result as any).toolExecutions || []).filter((execution: any) => !execution.success)
        // P8 Routine-Skills: Ergebnis des angewendeten Skills zählen und den Lauf
        // für die Wiederholungserkennung beobachten (nur Owner, keine Gruppe).
        let routineLearned: { counted: boolean; created?: { name: string; steps: Array<{ tool: string }> } } | null = null
        try {
            const { getRoutineSkillStore, finishRoutineSkillRun } = await import('../learning/routine-skills.js')
            const learned = finishRoutineSkillRun(getRoutineSkillStore(), {
                principalId, permission: principalContext.permission, isGroup: requestIsGroup,
                systemAuthored: isSystemMessage, request: content, appliedSkillId: routineSkillApplied,
                runId: (result as any).runId, intentKind: kernelState?.kind,
                success: (result as any).validation?.success === true,
                awaitingApproval: kernelState?.awaitingApproval === true || (result as any).validation?.awaitingApproval === true,
                steps: (result as any).toolExecutions || [],
            })
            routineLearned = learned as typeof routineLearned
            if (learned?.counted && learned.created) console.log(`[Skills] Neuer Routine-Skill angelegt: ${learned.created.name} (${learned.created.id})`)
        } catch (err) { console.debug('[Pipeline] routine skill bookkeeping failed:', err) }
        // P9 Werkzeug-Schmiede: fehlendes Werkzeug, Wiederholung oder Owner-Wunsch → Bau im Hintergrund.
        try {
            const { noteForgeNeed } = await import('../tools/skill-builder.js')
            const need = noteForgeNeed({
                principalId, permission: principalContext.permission, isGroup: requestIsGroup, systemAuthored: isSystemMessage,
                request: content, toolExecutions: (result as any).toolExecutions || [],
                routineSkillCreated: routineLearned?.counted ? routineLearned.created ?? null : null,
            })
            if (need.queued) console.log(`[Werkzeuge] Bedarf erkannt (${need.kind}): Bau läuft im Hintergrund`)
        } catch (err) { console.debug('[Pipeline] forge need hook failed:', err) }
        const { authoritativeDiagnosticResponse, screenshotFailureResponse, nodeScreenshotResponse } = await import('./tool-evidence-response.js')
        const authoritativeDiagnostic = authoritativeDiagnosticResponse(successfulExecutions)
        if (authoritativeDiagnostic) supervised.content = authoritativeDiagnostic
        if ((result as any).incompleteSynthesis) {
            // No post-timeout repair/fact-check or unsupported completion claim.
            const { incompleteToolResponse } = await import('./tool-evidence-response.js')
            supervised.content = incompleteToolResponse(successfulExecutions.map((item: any) =>
                typeof item.result === 'string' ? item.result : JSON.stringify(item.result)))
        }
        const fulfillmentToolCount = kernelState
            ? (kernelState.fulfilled ? 1 : 0)
            : successfulExecutions.filter((execution: any) => toolProvidesActionEvidence(execution.toolName)).length
        const skillProposalCreated = kernelState
            ? kernelState.awaitingApproval
            : successfulExecutions.some((execution: any) => execution.toolName === 'build_skill' || execution.toolName === 'create_skill')
        if (!isSystemMessage && preGateIntent.kind === 'screenshot' && (!screenshotDelivered || isNodeScreenshotRequest(content))) {
            supervised.content = isNodeScreenshotRequest(content) ? nodeScreenshotResponse([...successfulExecutions, ...failedExecutions]) : screenshotFailureResponse(failedExecutions)
        } else if (!isSystemMessage && actionIntent.requiresTool && fulfillmentToolCount === 0 && skillProposalCreated) {
            if (!supervised.content || responseClaimsCompletedAction(supervised.content)) {
                supervised.content = 'Ich habe selbst einen konkreten Skill-Vorschlag erstellt. Er wartet gemäß PATCH_GATE auf deine Freigabe; die angeforderte Aktion ist noch nicht ausgeführt.'
            }
        } else if (!isSystemMessage && actionIntent.requiresTool && fulfillmentToolCount === 0 && failedExecutions.length > 0) {
            const failure = String(failedExecutions.at(-1)?.result || '').trim().slice(0, 700)
            supervised.content = failure
                ? `Die Aktion wurde versucht, ist aber fehlgeschlagen:\n${failure}`
                : honestNoToolResponse(actionIntent.kind)
        } else if (!isSystemMessage && actionIntent.requiresTool && fulfillmentToolCount === 0 && !(result as any).error) {
            supervised.content = honestNoToolResponse(actionIntent.kind)
        } else if (!isSystemMessage && fulfillmentToolCount === 0 && responseClaimsCompletedAction(supervised.content || '')) {
            supervised.content = honestNoToolResponse(actionIntent.kind)
        }

        // Only send if we have content
        if (supervised.content && supervised.content.trim().length > 0) {
            // L12: Fact-check response before sending
            const { sanitizeInternalOutboundArtifacts } = await import('./outbound-content-guard.js')
            let finalContent = sanitizeInternalOutboundArtifacts(supervised.content)
            try {
                const { validateWithLLM } = await import('../layers/L12-anti-hallucination.js')
                const toolExecs = (result as any).toolExecutions || []
                if (!(result as any).incompleteSynthesis && toolExecs.length > 0 && !(principalContext.permission === 'owner' && isEnvironmentOverview(content) && !(result as any).responseConstraints?.length)) {
                    // 15s timeout on hallucination check — non-critical
                    const validation = await Promise.race([
                        validateWithLLM(supervised.content, toolExecs),
                        new Promise<{ honest: true, issues: [] }>((resolve) =>
                            setTimeout(() => resolve({ honest: true, issues: [] }), 15_000)
                        ),
                    ])
                    if (!validation.honest) {
                        console.log(`[L12] 🚨 Response korrigiert: ${validation.issues.join(', ')}`)
                        // Diagnostics stay in logs/journal and never become user
                        // text. Replace contradicted prose with actual redacted
                        // Tool Evidence instead of sanitizing the same false text.
                        const { verifiedToolEvidenceResponse } = await import('./tool-evidence-response.js')
                        finalContent = sanitizeInternalOutboundArtifacts(verifiedToolEvidenceResponse(toolExecs))
                        // Record in journal
                        try {
                            const journal = (state as any).journal
                            if (journal) journal.recordLearning('Hallucination abgefangen', validation.issues.join('; '))
                        } catch (err) { console.debug('[Pipeline] non-critical error:', err) }
                    }
                }
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

            // A synthesis/fact-check fallback may emit raw discovery results.
            // Delivery truth is deterministic and remains authoritative last.
            if (!isSystemMessage && principalContext.permission === 'owner' && isEnvironmentOverview(content) && !(result as any).responseConstraints?.length) {
                const { environmentOverviewResponse, wantsTechnicalDetails } = await import('./tool-evidence-response.js')
                finalContent = sanitizeInternalOutboundArtifacts(environmentOverviewResponse((result as any).toolExecutions || [], { technisch: wantsTechnicalDetails(content) }))
            }
            if (!isSystemMessage && preGateIntent.kind === 'screenshot' && (!screenshotDelivered || isNodeScreenshotRequest(content))) {
                finalContent = isNodeScreenshotRequest(content) ? sanitizeInternalOutboundArtifacts(nodeScreenshotResponse([...successfulExecutions, ...failedExecutions])) : screenshotFailureResponse(failedExecutions)
            }

            // Internal provider reasoning is never a channel artifact. Verbose
            // mode exposes the selected policy and verified evidence instead.
            const globalState = (globalThis as any).__novaState
            const showReasoning = globalState?.showReasoning || globalState?.verboseMode
            const showVerbose = globalState?.verboseMode

            if (showReasoning && (result as any).reasoning) {
                console.log(`[Pipeline] Protected ${String((result as any).reasoning).length} chars of internal reasoning from channel output`)
            }

            // Optional compact Trust footer: actual runtime/evidence only.
            if (showVerbose && !result.responseConstraints?.length) {
                const debugParts: string[] = []

                if (result.toolsExecuted.length > 0) {
                    debugParts.push(`🔧 Tools: ${result.toolsExecuted.join(', ')}`)
                }
                debugParts.push(`✅ Evidence: ${successfulExecutions.length}`)
                debugParts.push(`🧠 ${contextPolicy.cognitiveMode}`)
                debugParts.push(`🤖 ${(result as any).model || routedModel || 'auto'}`)
                debugParts.push(`🖥️ ${process.env.NOVA_NODE_ID || 'local'}`)
                debugParts.push(`⏱️ ${((Date.now() - progressStartedAt) / 1000).toFixed(1)}s`)

                finalContent += `\n\n_${debugParts.join(' | ')}_`
            }

            // Model prose is not an action authorization. Mission creation must
            // enter through the user command or the governed typed tool, never
            // through a /mission substring in an already validated answer.
            if (result.responseConstraints?.length && result.validation?.success) {
                const { satisfiesResponseConstraints } = await import('./response-contract.js')
                if (!satisfiesResponseConstraints(finalContent, result.responseConstraints)) {
                    const { getOutcomeLedger } = await import('./outcome-ledger.js')
                    result.validation = { ...result.validation, success: false,
                        violations: [...result.validation.violations, 'delivery transform violated response contract'] }
                    if (result.runId) {
                        getOutcomeLedger().recordValidation(result.runId, result.validation)
                        getOutcomeLedger().invalidate(result.runId, { reason: 'delivery transform violated response contract' })
                    }
                    finalContent = 'Die Antwort konnte nach der Ausgabeprüfung nicht freigegeben werden.'
                }
            }

            if (desktopContext) {
                try {
                    const [{ publishDesktopAgentOutcome }, { getOutcomeLedger }] = await Promise.all([
                        import('../desktop/desktop-agent-context.js'), import('./outcome-ledger.js'),
                    ])
                    const run = (result as any).runId ? getOutcomeLedger().getRun((result as any).runId) : null
                    publishDesktopAgentOutcome({
                        runId: (result as any).runId,
                        model: (result as any).model || run?.model || routedModel,
                        node: run?.node || process.env.NOVA_NODE_ID || 'local',
                        durationMs: Date.now() - progressStartedAt,
                        tools: [...successfulExecutions, ...failedExecutions].map((execution: any) => ({
                            name: String(execution.toolName || execution.name || 'tool'),
                            success: execution.success === true,
                        })),
                        verifiedEvidence: successfulExecutions.length,
                        action: (result as any).actionState,
                    })
                } catch (error) {
                    console.debug(`[Desktop] outcome projection unavailable: ${error}`)
                }
            }

            // 2.88: the model used the honesty sentence → the same learn card (or the honest status).
            if (!isSystemMessage) try {
                const { capabilityReplyGate } = await import('../learning/capability-learning.js')
                finalContent = await capabilityReplyGate(content, finalContent, { principalId, permission: principalContext.permission, isGroup: requestIsGroup || isGroupMessage === true })
            } catch (error) { console.debug(`[Pipeline] capability reply gate unavailable: ${error}`) }

            await replyFn(finalContent)
            logSession(canonicalUser, channel, 'assistant', finalContent)

            // Conversation continuity may retain only outcomes that crossed
            // the authoritative execution/evidence gate. Model prose alone is
            // never recorded as a completed action.
            if (!isSystemMessage && fulfillmentToolCount > 0 && successfulExecutions.length > 0) {
                try {
                    const { recordVerifiedOutcome } = await import('../memory/session-summarizer.js')
                    const { getOutcomeLedger } = await import('./outcome-ledger.js')
                    const evidenceRun = getOutcomeLedger().listRuns(50).find(run =>
                        run.userId === principalId && run.channel === channel && run.status === 'completed'
                        && run.contract?.goal === content)
                    recordVerifiedOutcome(
                        principalId,
                        content,
                        successfulExecutions.map((execution: any) => ({
                            toolName: String(execution.toolName || execution.name || 'tool'),
                            result: execution.result,
                        })),
                        evidenceRun?.runId,
                    )
                } catch (err) { console.debug('[Pipeline] continuity outcome unavailable:', err) }
            }

            // Track last assistant message per-user so corrections can reference it
            // Using a Map keyed by canonicalUser to avoid cross-user contamination
            if (!(state as any).lastAssistantMessages) {
                ;(state as any).lastAssistantMessages = new Map<string, string>()
            }
            ;(state as any).lastAssistantMessages.set(principalId, finalContent)

            // LearningEngine: Record bot response for feedback tracking
            try {
                const le = (state as any).learningCoordinator || (state as any).learning
                if (le?.recordBotResponse) {
                    le.recordBotResponse(finalContent, { channel, userId: principalId })
                }
            } catch { /* learning non-critical */ }

            // Cache successful response for future identical queries
            try {
                const { cacheResponse } = await import('../llm/response-cache.js')
                if (!(result as any).error && result.validation?.success === true && !detectActionIntent(content).requiresTool) {
                    if (!requiresFreshRuntimeEvidence) cacheResponse(systemPrompt, cacheKeyMessages, finalContent, routedModel || 'default')
                }
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }
            console.log(`[Nova] [${channel}] Antwort gesendet (${supervised.content.length} chars, ${result.toolsExecuted.length} tools, Session: ${result.sessionId.slice(0, 8)}...)`)

            // Task Tracker: mark task as complete
            try {
                const { completeTask } = await import('./task-tracker.js')
                // Typed for the optional task id so this compiles before and after it exists.
                ;(completeTask as (failed?: boolean, taskId?: string) => void)(Boolean((result as any).error) || result.validation?.success !== true, trackedTaskId)
                trackedTaskId = undefined
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }
            // L14 CostTracker: Track tokens for /status
            try {
                const costTracker = (state as any).costTracker
                if (costTracker?.track) {
                    const estIn = Math.round(content.length / 4)
                    const estOut = Math.round(finalContent.length / 4)
                    costTracker.track({
                        provider: state.llm?.provider || 'unknown',
                        model: state.llm?.modelId || 'unknown',
                        usage: {
                            inputTokens: estIn,
                            outputTokens: estOut,
                            totalTokens: estIn + estOut,
                        },
                        task: content.slice(0, 100),
                    })
                }
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

            // Auto-Observer: Extract facts from assistant response too (Nova learns from herself)
            // NOTE: AutoObserver + KnowledgeGraph extraction moved to nightly distillation.
            // Live regex/LLM extraction polluted memory with conversation fragments
            // ("Name: da", "Skill: mich nicht verbinden", error messages as facts).
            // The Memory Distiller now does this with proper LLM curation overnight.

            // ROI Dashboard: Complete task tracking
            try {
                const { completeTask: completeROI, recordTokens } = await import('../intelligence/roi-dashboard.js')
                const estIn = Math.round(content.length / 4)
                const estOut = Math.round(finalContent.length / 4)
                recordTokens(estIn, estOut, routedModel || state.llm?.modelId || 'default')
                completeROI()
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

            // Self-Reflection: Post-response quality analysis
            try {
                const intelligence = (state as any).intelligence
                if (intelligence?.selfReflection) {
                    const reflectionResult = intelligence.selfReflection.reflect({
                        userMessage: content,
                        assistantResponse: finalContent,
                        execution: {
                            requiresTool: (result as any).actionState?.requiresTool ?? detectActionIntent(content).requiresTool,
                            validated: result.validation?.success === true,
                            failed: Boolean((result as any).error) || result.validation?.success === false,
                        },
                        toolsUsed: (result.toolsExecuted || []).map((t: any) => t.name || t),
                        toolResults: ((result as any).toolExecutions || []).map((t: any) => ({
                            tool: t.toolName || t.name || t.tool || 'unknown',
                            success: t.success === true,
                            error: t.error,
                        })),
                    })
                    intelligence.selfReflection.logReflection(reflectionResult)

                    // Feed reflection issues to insight engine for long-term learning
                    // (the announce-without-act retry now happens earlier, before delivery)
                    if (reflectionResult.needsImprovement) {
                        try {
                            const { getInsightEngine } = await import('../intelligence/autonomy-engine.js')
                            for (const issue of reflectionResult.issues) {
                                getInsightEngine().recordInsight('suggestion', `Self-Reflection: ${issue}`)
                            }
                        } catch (err) { console.debug('[Pipeline] autonomy engine not available:', err) }
                    }
                }
            } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

            // ════════════════════════════════════════════════════════════════
            // MEMORY ARCHITECTURE: Read-during-chat, Write-during-distillation
            // ════════════════════════════════════════════════════════════════
            // The conversation is already persisted in sessions/*.jsonl (logSession).
            // The nightly Memory Distiller reads those sessions, an LLM curates
            // real facts, and ONLY curated facts go into CORE_FACTS / LanceDB / KG.
            //
            // We do NOT write raw conversation, regex-extracted "facts", or
            // entity-graph nodes during the live chat. That polluted the context
            // and made Nova learn from her own mistakes (e.g. error messages
            // stored as "behavior", conversation fragments stored as "skills").
            //
            // Journal still records lightweight events (tool usage stats) since
            // those are append-only metrics, not context-injected memory.
            const isNoiseMessage = isSystemMessage
                || content.startsWith('[MISSION')
                || channel === 'internal'
                || canonicalUser === 'nova-self'
                || canonicalUser === 'Nova-Autonomy'
                || canonicalUser === 'system'

            // Journal: lightweight event log (tool stats only — not context memory)
            if (!isNoiseMessage) {
                try {
                    const journal = (state as any).journal
                    if (journal) {
                        for (const execution of (result as any).toolExecutions || []) {
                            journal.recordToolUse(execution.toolName || execution.name || execution.tool, execution.success === true, canonicalUser)
                        }
                    }
                } catch (err) { console.debug('[Pipeline] non-critical error:', err) }
            }
        } else {
            console.log(`[L0] ❌ Keine Antwort nach ${attempt} Versuchen - sende Fallback`)
            const fallbackMsg = result.content && result.content.includes('Loop')
                ? 'Ich bin in eine Schleife geraten und konnte die Anfrage nicht verarbeiten. Bitte formuliere es anders oder versuche es erneut.'
                : 'Entschuldigung, ich konnte keine Antwort generieren. Bitte versuche es erneut.'
            await replyFn(fallbackMsg)
            logSession(canonicalUser, channel, 'assistant', fallbackMsg)
        }

    } catch (err) {
        console.error(`[Nova] [${channel}] Fehler: ${err}`)
        if (err instanceof ReplyDeliveryError) throw err
        const disposition = agentFailureDisposition(err, execution?.abortSignal)

        // Resilience: Track error and attempt auto-fix
        try {
            const resilience = (state as any).resilience
            if (resilience) {
                const errMsg = err instanceof Error ? err : new Error(String(err))
                const category = String(err).match(/rate.?limit|429/i) ? 'llm' :
                    String(err).match(/ECONNREFUSED|ETIMEDOUT|network/i) ? 'network' :
                        String(err).match(/token|auth|401/i) ? 'auth' : 'runtime'
                await resilience.trackError(category, errMsg, 'high')
            }
        } catch (err) { console.debug('[Pipeline] non-critical error:', err) }

        // A deadline or abort stopped the agent on purpose. Never replace it
        // with an unguarded plain completion (no tools, no evidence, no RBAC).
        if (disposition === 'cancelled') {
            if (execution?.abortSignal?.aborted) throw err
            try {
                await replyFn('Die Anfrage wurde abgebrochen. Bitte versuche es erneut.')
            } catch { /* nothing more to do */ }
            return
        }
        if (disposition === 'timeout') {
            try {
                await replyFn('Die Anfrage hat das Zeitlimit überschritten und wurde abgebrochen.')
            } catch { /* nothing more to do */ }
            return
        }

        // Fallback to simple LLM call if agent runner fails
        try {
            const response = await state.llm.complete([
                { role: 'system', content: loadSoul() },
                { role: 'user', content }
            ])
            await replyFn(response.content)
        } catch (fallbackErr) {
            console.error(`[Nova] [${channel}] Fallback Fehler: ${fallbackErr}`)
            // LAST RESORT: always reply something, never go silent
            try {
                await replyFn('Entschuldigung, es ist ein Fehler aufgetreten. Ich bin aber noch da — bitte versuche es erneut.')
            } catch { /* absolutely nothing we can do */ }
        }
    } finally {
        // A timeout, cancellation or failed delivery must not leave /task active.
        // The ID guard preserves another concurrent request's tracker entry.
        if (trackedTaskId) {
            try { (await import('./task-tracker.js')).completeTask(true, trackedTaskId) }
            catch (error) { console.debug('[Pipeline] task cleanup failed:', error) }
        }
    }
}
