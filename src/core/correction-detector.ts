/**
 * Correction Detection & Auto-Learning
 * 
 * Detects when user corrects Nova and triggers learning:
 * - Phrases like "falsch", "nein", "korrektur"
 * - Stores last tool call to know what was wrong
 * - Waits for correct version and learns from it
 * 
 * Also integrates with L0 for failure memory:
 * - When something fails, remember it
 * - Try alternative approaches
 * - Don't repeat same mistakes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getMemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { loadHosts, saveHosts } from '../tools/ssh-tool-hosts.js'

// ============================================
// Types
// ============================================

export interface LastToolCall {
    toolName: string
    params: Record<string, unknown>
    result: unknown
    userRequest: string
    timestamp: number
    principalId?: string
}

export interface FailedApproach {
    toolName: string
    params: Record<string, unknown>
    error: string
    timestamp: number
    userRequest: string
}

export interface CorrectionState {
    awaitingCorrection: boolean
    awaitingCorrectionFor?: string
    lastToolCall: LastToolCall | null
    failedApproaches: FailedApproach[]
}

// ============================================
// Correction Phrases
// ============================================

const CORRECTION_PHRASES = [
    'falsch',
    'nein',
    'nicht richtig',
    'korrektur',
    'das stimmt nicht',
    'der befehl ist falsch',
    'das ist falsch',
    'versuch es so',
    'mach es so',
    'richtig wäre',
    'wrong',
    'incorrect',
    'try this',
]

const APPROVAL_PHRASES = [
    'richtig',
    'genau',
    'ja',
    'perfekt',
    'super',
    'gut',
    'danke',
    'correct',
    'yes',
    'good',
]

// ============================================
// Credential Extraction Patterns
// ============================================

export interface ExtractedCredentials {
    user?: string
    password?: string
    port?: number
    host?: string
}

/**
 * Extract credentials from user message
 * Handles patterns like:
 * - "user myuser pw mypassword"
 * - "username: abc password: xyz"
 * - "benutzer abc passwort xyz port 22"
 */
export function extractCredentialsFromMessage(message: string): ExtractedCredentials {
    const creds: ExtractedCredentials = {}
    const lower = message.toLowerCase()
    const original = message

    // User patterns
    const userPatterns = [
        /user[name]?\s*[:=]?\s*(\S+)/i,
        /benutzer\s*[:=]?\s*(\S+)/i,
        /login\s*[:=]?\s*(\S+)/i,
        /nutzer\s*[:=]?\s*(\S+)/i,
    ]
    for (const pattern of userPatterns) {
        const match = original.match(pattern)
        if (match && match[1] && !match[1].match(/^(pw|pass|port|host)/i)) {
            creds.user = match[1]
            break
        }
    }

    // Password patterns - use original to preserve case
    const pwPatterns = [
        /(?:pw|pass(?:word)?|passwort|kennwort)\s*[:=]?\s*(\S+)/i,
    ]
    for (const pattern of pwPatterns) {
        const match = original.match(pattern)
        if (match && match[1]) {
            creds.password = match[1]
            break
        }
    }

    // Port patterns
    const portPatterns = [
        /port\s*[:=]?\s*(\d+)/i,
        /-p\s*(\d+)/i,
    ]
    for (const pattern of portPatterns) {
        const match = message.match(pattern)
        if (match && match[1]) {
            creds.port = parseInt(match[1])
            break
        }
    }

    // Host/IP patterns
    const hostPatterns = [
        /host\s*[:=]?\s*(\S+)/i,
        /server\s*[:=]?\s*(\S+)/i,
        /ip\s*[:=]?\s*(\d+\.\d+\.\d+\.\d+)/i,
        /(\d+\.\d+\.\d+\.\d+)/,  // Raw IP
    ]
    for (const pattern of hostPatterns) {
        const match = message.match(pattern)
        if (match && match[1]) {
            creds.host = match[1]
            break
        }
    }

    if (Object.keys(creds).length > 0) {
        console.log(`[CorrectionDetector] Extracted credentials:`, {
            ...creds,
            password: creds.password ? '***' : undefined
        })
    }

    return creds
}

// Session credential storage (PERSISTED TO DISK!)
const DATA_DIR = join(process.cwd(), '.nova-data')
const CREDS_FILE = join(DATA_DIR, 'session-credentials.json')

let sessionCredentials: ExtractedCredentials = {}

// Load credentials on module init
function loadSessionCredentials(): void {
    try {
        if (existsSync(CREDS_FILE)) {
            sessionCredentials = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'))
            console.log(`[CorrectionDetector] Loaded saved credentials for host: ${sessionCredentials.host || 'none'}`)
        }
    } catch { }
}

// Save credentials to disk
function saveSessionCredentials(): void {
    try {
        if (!existsSync(DATA_DIR)) {
            mkdirSync(DATA_DIR, { recursive: true })
        }
        writeFileSync(CREDS_FILE, JSON.stringify(sessionCredentials, null, 2))
    } catch (err) {
        console.log(`[CorrectionDetector] Failed to save credentials: ${err}`)
    }
}

// Initialize on module load
loadSessionCredentials()

export function updateSessionCredentials(creds: ExtractedCredentials): void {
    sessionCredentials = { ...sessionCredentials, ...creds }
    saveSessionCredentials()  // PERSIST TO DISK!
    console.log(`[CorrectionDetector] Updated session credentials:`, {
        ...sessionCredentials,
        password: sessionCredentials.password ? '***' : undefined
    })
}

export function getSessionCredentials(): ExtractedCredentials {
    return sessionCredentials
}

export function clearSessionCredentials(): void {
    sessionCredentials = {}
    saveSessionCredentials()
}

// ============================================
// Session State (in-memory + persisted)
// ============================================

// DATA_DIR is already declared above
const STATE_FILE = join(DATA_DIR, 'correction-state.json')

let state: CorrectionState = {
    awaitingCorrection: false,
    lastToolCall: null,
    failedApproaches: [],
}

function loadState(): void {
    try {
        if (existsSync(STATE_FILE)) {
            state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
        }
    } catch { }
}

function saveState(): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true })
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// Initialize on load
loadState()

// ============================================
// Correction Detection
// ============================================

export function isCorrection(message: string, principalId?: string): boolean {
    const lower = message.toLowerCase().trim()

    // Require correction language, not a substring inside a status/metric such
    // as "Falsche Fertigmeldungen: 0" or "automatische Korrekturen".
    if (/^(?:nein[,:;!? -]+)?(?:falsch|nicht richtig|korrektur|wrong|incorrect)\b/i.test(lower)
        || /\b(?:das|dies|es|die antwort|deine antwort|die angabe|das ergebnis|der befehl)\s+(?:ist|war)\s+(?:falsch|nicht richtig)\b/i.test(lower)
        || /\b(?:das stimmt nicht|der befehl ist falsch|das ist falsch)\b/i.test(lower)) {
        return true
    }
    if (/\bnicht\s+.{2,100}?\s*[,;—–-]\s*sondern\b/i.test(message)
        || /\b(?:richtig\s+ist|eigentlich\s+ist|ich\s+meinte)\b/i.test(message)) {
        return true
    }

    // "nein" alone is only a correction if there was a RECENT tool call (within 2 min)
    // This prevents false positives when user casually says "nein" in conversation
    const hasRecentToolCall = isRecentToolCall(state.lastToolCall)
        && (!principalId || state.lastToolCall?.principalId === principalId)

    if (/^nein[!?.,]?\s*$/.test(lower) && hasRecentToolCall) {
        return true
    }

    // "Nein, [correction follows]" — only if recent tool call
    if (lower.startsWith('nein,') && hasRecentToolCall) {
        return true
    }

    // Explicit correction intent phrases (always match, even without tool call)
    const explicitPhrases = ['versuch es so', 'mach es so', 'richtig wäre', 'try this']
    if (explicitPhrases.some(phrase => lower.includes(phrase))) {
        return true
    }

    return false
}

export function isApproval(message: string): boolean {
    const lower = message.toLowerCase().trim()
    return APPROVAL_PHRASES.some(phrase => lower.includes(phrase))
}

export function containsCorrectVersion(message: string): boolean {
    // Check if message contains what looks like a command or instruction
    return (
        message.includes('ssh ') ||
        message.includes('node ') ||
        message.includes('python ') ||
        message.includes('-p ') ||
        message.includes('@') ||
        message.length > 20  // Likely contains instructions
    )
}

// ============================================
// Tool Call Tracking
// ============================================

export function recordToolCall(
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
    userRequest: string,
    principalId?: string,
): void {
    state.lastToolCall = {
        toolName,
        params,
        result,
        userRequest,
        timestamp: Date.now(),
        principalId,
    }
    saveState()
    console.log(`[CorrectionDetector] Recorded tool call: ${toolName}`)
}

export function getLastToolCall(): LastToolCall | null {
    return state.lastToolCall
}

// ============================================
// Failure Memory
// ============================================

export function recordFailedApproach(
    toolName: string,
    params: Record<string, unknown>,
    error: string,
    userRequest: string
): void {
    state.failedApproaches.push({
        toolName,
        params,
        error,
        timestamp: Date.now(),
        userRequest,
    })

    // Keep only last 50 failures
    if (state.failedApproaches.length > 50) {
        state.failedApproaches = state.failedApproaches.slice(-50)
    }

    saveState()
    console.log(`[FailureMemory] Recorded failed approach: ${toolName}`)
}

export function hasFailedBefore(toolName: string, params: Record<string, unknown>): boolean {
    const key = JSON.stringify({ toolName, params })
    return state.failedApproaches.some(f =>
        JSON.stringify({ toolName: f.toolName, params: f.params }) === key
    )
}

export function getFailedApproaches(toolName?: string): FailedApproach[] {
    if (toolName) {
        return state.failedApproaches.filter(f => f.toolName === toolName)
    }
    return state.failedApproaches
}

export function getRecentFailures(limit: number = 5): FailedApproach[] {
    return state.failedApproaches.slice(-limit)
}

// ============================================
// Correction Flow
// ============================================

export function startCorrectionFlow(principalId?: string): void {
    state.awaitingCorrection = true
    state.awaitingCorrectionFor = principalId
    saveState()
    console.log('[CorrectionDetector] Awaiting correction from user')
}

export function endCorrectionFlow(): void {
    state.awaitingCorrection = false
    state.awaitingCorrectionFor = undefined
    saveState()
}

export function isAwaitingCorrection(principalId?: string): boolean {
    if (!state.awaitingCorrection) return false
    if (!principalId) return true
    return state.awaitingCorrectionFor === principalId
}

// ============================================
// Build Failure Context for LLM
// ============================================

export function buildFailureContext(): string {
    const failures = getRecentFailures(3)
    if (failures.length === 0) return ''

    let context = '\n## Vorherige fehlgeschlagene Versuche (NICHT wiederholen!):\n'
    for (const f of failures) {
        context += `- ${f.toolName}(${JSON.stringify(f.params).slice(0, 100)}): ${f.error.slice(0, 100)}\n`
    }
    return context
}

// ============================================
// Process User Message for Corrections
// ============================================

export interface CorrectionResult {
    isCorrection: boolean
    hasCorrectVersion: boolean
    shouldTriggerLearning: boolean
    lastToolCall: LastToolCall | null
    message: string
}

export function isRecentToolCall(last: LastToolCall | null, now = Date.now(), maxAgeMs = 120_000): boolean {
    return Boolean(last && now >= last.timestamp && now - last.timestamp <= maxAgeMs)
}

export function processForCorrection(message: string, principalId?: string): CorrectionResult {
    const correction = isCorrection(message, principalId)
    const hasVersion = containsCorrectVersion(message)
    const recordedLast = getLastToolCall()
    // A correction may only punish or rewrite a tool when it immediately
    // follows that execution. Stale global state is context, not causality.
    const last = isRecentToolCall(recordedLast)
        && (!principalId || recordedLast?.principalId === principalId)
        ? recordedLast : null

    if (correction) {
        console.log('[CorrectionDetector] Correction detected!')

        if (hasVersion) {
            // A concrete correction is useful even when no tool call preceded
            // it. Tool-specific auto-update remains conditional on evidence.
            if (last) autoUpdateFromCorrection(message, last)
            return {
                isCorrection: true,
                hasCorrectVersion: true,
                shouldTriggerLearning: true,
                lastToolCall: last,
                // A concrete correction is evidence to ingest, not a reason to
                // terminate the conversation with a canned acknowledgement.
                // The normal pipeline must verify and answer it in context.
                message: '',
            }
        } else {
            // Just said it's wrong - wait for correct version
            startCorrectionFlow(principalId)
            return {
                isCorrection: true,
                hasCorrectVersion: false,
                shouldTriggerLearning: false,
                lastToolCall: last,
                message: `Ok, wie wäre es richtig?`,
            }
        }
    }

    // Check if we're awaiting correction and this is the answer
    if (isAwaitingCorrection(principalId) && last) {
        endCorrectionFlow()
        autoUpdateFromCorrection(message, last)
        return {
            isCorrection: false,
            hasCorrectVersion: true,
            shouldTriggerLearning: true,
            lastToolCall: last,
            message: '',
        }
    }

    return {
        isCorrection: false,
        hasCorrectVersion: false,
        shouldTriggerLearning: false,
        lastToolCall: null,
        message: '',
    }
}

// ============================================
// Auto-Update from Corrections
// ============================================

/**
 * When a correction contains an IP or device info, auto-update:
 * 1. hosts.json (SSH targets)
 * 2. CORE_FACTS.json (always-injected facts)
 * 3. MEMORY.md (long-term memory)
 */
function autoUpdateFromCorrection(message: string, lastToolCall: LastToolCall): void {
    try {
        // Extract IP from correction message
        const ipMatch = message.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)
        if (!ipMatch) return

        const newIp = ipMatch[1]
        const wasSSH = lastToolCall.toolName === 'ssh_command' || lastToolCall.toolName === 'ssh_persistent'

        // Try to extract device name from context
        const devicePatterns = [
            /(?:pi|raspberry|pi\s*5|rpi|beamer|tv|server|jetson)/i,
            /(\w+)\s+(?:hat|ist|IP|unter)/i,
        ]
        let deviceName = ''
        for (const pattern of devicePatterns) {
            const m = message.match(pattern)
            if (m) {
                deviceName = m[0].trim()
                break
            }
        }

        // 1. Update hosts.json if SSH-related
        if (wasSSH || deviceName) {
            if (!updateHostsJson(newIp, deviceName, lastToolCall)) return
        }

        // 2. One governed correction; Core Facts and KG are projections.
        const governed = getMemoryGovernanceCoordinator().propose({
            content: `${deviceName || 'GerÃ¤t'} erreichbar unter ${newIp}${wasSSH ? ' (SSH)' : ''}`,
            kind: 'context', scope: 'global', source: 'correction-detector', evidence: 'correction',
            confidence: 1, verified: true, subject: deviceName || 'GerÃ¤t', predicate: 'ip_address', value: newIp,
        })
        if (governed) void getMemoryGovernanceCoordinator().publish(governed.id)

        console.log(`[CorrectionDetector] ✅ Auto-update completed for IP ${newIp}`)
    } catch (err) {
        console.log(`[CorrectionDetector] Auto-update error: ${err}`)
    }
}

/**
 * Update hosts.json with corrected IP
 */
function updateHostsJson(newIp: string, deviceName: string, lastToolCall: LastToolCall): boolean {
    try {
        const db = loadHosts()

        // Find old IP from the failed tool call
        const oldIp = (lastToolCall.params as any)?.host || (lastToolCall.params as any)?.ip || ''

        // Try to find matching host entry
        const existingHost = db.hosts.find((h: any) =>
            h.ip === oldIp ||
            h.name?.toLowerCase() === deviceName.toLowerCase() ||
            h.alias?.some((a: string) => a.toLowerCase() === deviceName.toLowerCase())
        )

        if (existingHost) {
            if (existingHost.passwordEnv && existingHost.ip !== newIp) {
                throw new Error('Credential-bound host address changes require explicit owner host management')
            }
            // Update existing host
            console.log(`[CorrectionDetector] Updating host ${existingHost.name}: ${existingHost.ip} → ${newIp}`)
            existingHost.ip = newIp
            existingHost.lastSeen = new Date().toISOString()
        } else if (deviceName) {
            // Add new host
            db.hosts.push({
                name: deviceName,
                alias: [],
                ip: newIp,
                user: (lastToolCall.params as any)?.user || 'root',
                description: `Auto-discovered via correction (${new Date().toISOString().slice(0, 10)})`,
                lastSeen: new Date().toISOString(),
            })
            console.log(`[CorrectionDetector] Added new host: ${deviceName} @ ${newIp}`)
        }

        saveHosts(db)
        return true
    } catch (err) {
        console.log(`[CorrectionDetector] hosts.json update error: ${err}`)
        return false
    }
}

export default {
    isCorrection,
    isApproval,
    recordToolCall,
    getLastToolCall,
    recordFailedApproach,
    hasFailedBefore,
    getFailedApproaches,
    buildFailureContext,
    processForCorrection,
}
