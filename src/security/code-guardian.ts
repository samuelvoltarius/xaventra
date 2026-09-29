/**
 * Nova Code Guardian — Security Layer
 * 
 * Prevents Indirect Prompt Injection → RCE attacks through:
 * 1. AST Analysis: Parse code for dangerous patterns (not just regex)
 * 2. Anomaly Detection: Kill-switch when patterns are unusual
 * 3. Shadow Runtime: Test code in sandbox before deployment
 * 4. Signed Patches: Confidence-level tracking for code changes
 * 
 * Philosophy: Defense in depth — multiple layers, each catches what others miss.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'security')

// ============================================
// 1. REAL AST Analysis (via acorn parser)
// ============================================

/**
 * Analyze code security using a REAL AST parser (acorn).
 * Detects obfuscated attacks that regex misses:
 * - String concatenation: require('chi' + 'ld_process')
 * - Dynamic globals: globalThis[variable]
 * - Prototype pollution: obj.__proto__ = ...
 * - Hidden eval: setTimeout("code string")
 */
export async function analyzeCodeSecurity(code: string, filename?: string): Promise<{
    safe: boolean
    confidence: number
    findings: Array<{ severity: string; pattern?: string; category?: string; description: string; line?: number }>
}> {
    try {
        // Use REAL AST analyzer
        const { analyzeAST } = await import('./ast-analyzer.js')
        const result = analyzeAST(code, filename)

        // Map findings to legacy format for backward compatibility
        return {
            safe: result.safe,
            confidence: result.confidence,
            findings: result.findings.map(f => ({
                severity: f.severity,
                pattern: f.category,
                category: f.category,
                description: f.description,
                line: f.line,
            })),
        }
    } catch (err) {
        // AST analyzer not available — fallback to basic regex checks
        console.log(`[CodeGuardian] ⚠️ AST analyzer unavailable, using regex fallback: ${err}`)
        return analyzeCodeSecurityFallback(code)
    }
}

/**
 * Fallback: Basic regex checks when AST parser is not available.
 * This is the OLD method — kept as backup only.
 */
function analyzeCodeSecurityFallback(code: string): {
    safe: boolean
    confidence: number
    findings: Array<{ severity: string; pattern: string; description: string; line?: number }>
} {
    const findings: Array<{ severity: string; pattern: string; description: string; line?: number }> = []

    const criticalPatterns = [
        { regex: /\beval\s*\(/g, desc: 'eval()' },
        { regex: /\bnew\s+Function\s*\(/g, desc: 'new Function()' },
        { regex: /child_process/g, desc: 'child_process' },
        { regex: /\bglobal\s*\[/g, desc: 'global[] dynamic access' },
        { regex: /\bglobalThis\s*\[/g, desc: 'globalThis[] dynamic access' },
    ]

    for (const { regex, desc } of criticalPatterns) {
        if (regex.test(code)) {
            findings.push({ severity: 'critical', pattern: 'regex-fallback', description: desc })
        }
    }

    const criticalCount = findings.length
    return {
        safe: criticalCount === 0,
        confidence: Math.max(0, 100 - criticalCount * 30),
        findings,
    }
}

// ============================================
// 2. Anomaly Detection & Kill-Switch
// ============================================

interface AnomalyMetrics {
    toolCallsPerMinute: number[]
    codeGenerationSizes: number[]
    shellCommandLengths: number[]
    writeAttempts: number[]
    timestamps: number[]
}

const anomalyWindow: AnomalyMetrics = {
    toolCallsPerMinute: [],
    codeGenerationSizes: [],
    shellCommandLengths: [],
    writeAttempts: [],
    timestamps: [],
}

let killSwitchActive = false
let killSwitchReason = ''

/**
 * Record a metric for anomaly detection
 */
export function recordMetric(type: 'tool_call' | 'code_gen' | 'shell_cmd' | 'write_attempt', value: number): void {
    const now = Date.now()

    // Keep only last 5 minutes of data
    const fiveMinAgo = now - 5 * 60 * 1000
    pruneOldData(fiveMinAgo)

    anomalyWindow.timestamps.push(now)

    switch (type) {
        case 'tool_call':
            anomalyWindow.toolCallsPerMinute.push(value)
            break
        case 'code_gen':
            anomalyWindow.codeGenerationSizes.push(value)
            break
        case 'shell_cmd':
            anomalyWindow.shellCommandLengths.push(value)
            break
        case 'write_attempt':
            anomalyWindow.writeAttempts.push(value)
            break
    }

    // Check for anomalies
    checkAnomalies()
}

function pruneOldData(cutoff: number): void {
    const validIdx = anomalyWindow.timestamps.findIndex(t => t >= cutoff)
    if (validIdx > 0) {
        anomalyWindow.timestamps = anomalyWindow.timestamps.slice(validIdx)
        anomalyWindow.toolCallsPerMinute = anomalyWindow.toolCallsPerMinute.slice(validIdx)
        anomalyWindow.codeGenerationSizes = anomalyWindow.codeGenerationSizes.slice(validIdx)
        anomalyWindow.shellCommandLengths = anomalyWindow.shellCommandLengths.slice(validIdx)
        anomalyWindow.writeAttempts = anomalyWindow.writeAttempts.slice(validIdx)
    }
}

function checkAnomalies(): void {
    // Anomaly 1: Too many write attempts in short time (> 10 in 1 min)
    const oneMinAgo = Date.now() - 60_000
    const recentWrites = anomalyWindow.writeAttempts.filter((_, i) =>
        anomalyWindow.timestamps[i] > oneMinAgo
    ).length
    if (recentWrites > 10) {
        triggerKillSwitch(`Zu viele Schreibzugriffe: ${recentWrites} in 1 Minute (Limit: 10)`)
        return
    }

    // Anomaly 2: Very large generated code (> 10KB in a single generation)
    const recentLargeGen = anomalyWindow.codeGenerationSizes.filter(s => s > 10_000)
    if (recentLargeGen.length > 3) {
        triggerKillSwitch(`Ungewöhnlich große Code-Generierung: ${recentLargeGen.length}x > 10KB`)
        return
    }

    // Anomaly 3: Very long shell commands (> 500 chars) — potential injection
    const longCmds = anomalyWindow.shellCommandLengths.filter(l => l > 500)
    if (longCmds.length > 3) {
        triggerKillSwitch(`Ungewöhnlich lange Shell-Befehle: ${longCmds.length}x > 500 Zeichen`)
        return
    }

    // Anomaly 4: Burst of tool calls (> 50 in 1 min)
    const recentToolCalls = anomalyWindow.toolCallsPerMinute.filter((_, i) =>
        anomalyWindow.timestamps[i] > oneMinAgo
    ).length
    if (recentToolCalls > 50) {
        triggerKillSwitch(`Tool-Call-Burst: ${recentToolCalls} Calls in 1 Minute (Limit: 50)`)
        return
    }
}

function triggerKillSwitch(reason: string): void {
    killSwitchActive = true
    killSwitchReason = reason
    console.log(`[SECURITY] 🚨🚨🚨 KILL-SWITCH ACTIVATED: ${reason}`)
    console.log('[SECURITY] Auto-Updater und Self-Evolution PAUSIERT!')

    // Persist kill-switch state
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'kill-switch.json'), JSON.stringify({
            active: true,
            reason,
            activatedAt: new Date().toISOString(),
            metrics: {
                writes: anomalyWindow.writeAttempts.length,
                codeGens: anomalyWindow.codeGenerationSizes.length,
                shellCmds: anomalyWindow.shellCommandLengths.length,
            },
        }, null, 2))
    } catch { /* non-critical */ }
}

export function isKillSwitchActive(): boolean {
    return killSwitchActive
}

export function getKillSwitchStatus(): { active: boolean; reason: string } {
    return { active: killSwitchActive, reason: killSwitchReason }
}

export function resetKillSwitch(): string {
    killSwitchActive = false
    killSwitchReason = ''
    console.log('[SECURITY] ✅ Kill-Switch reset by admin')
    try {
        writeFileSync(join(DATA_DIR, 'kill-switch.json'), JSON.stringify({ active: false }, null, 2))
    } catch { /* non-critical */ }
    return '✅ Kill-Switch deaktiviert. Auto-Updater wieder aktiv.'
}

// ============================================
// 3. Shadow/Canary Runtime Sandbox
// ============================================

/**
 * Run code in an isolated sandbox to detect malicious behavior.
 * Uses Node.js vm module with restricted globals.
 * 
 * Returns true if code is safe, false if it tried something dangerous.
 */
export async function sandboxTest(code: string, timeoutMs: number = 3000): Promise<{
    safe: boolean
    error?: string
    duration: number
}> {
    const start = Date.now()
    const done = (safe: boolean, error?: string) => ({ ...(error ? { safe, error } : { safe }), duration: Date.now() - start })

    let vm: typeof import('node:vm')
    let isProxy: (value: unknown) => boolean
    try {
        vm = await import('node:vm')
        isProxy = (await import('node:util')).types.isProxy
    } catch (error) {
        // Fail-closed: without a sandbox nothing is vouched for.
        return done(false, `Sandbox nicht verfügbar: ${String(error).slice(0, 120)}`)
    }

    // Compile in the host first: a syntax error is a host SyntaxError and the
    // code is simply not verifiable (fail-closed).
    let script: import('node:vm').Script
    try {
        script = new vm.Script(code, { filename: 'sandbox-test.js' })
    } catch {
        return done(false, 'Code ist im Sandbox-Test nicht auswertbar (Syntaxfehler) — ohne Prüfung keine Freigabe')
    }

    // Isolated realm: no host objects or functions are placed into the
    // context (they would leak the host Function constructor and with it
    // `process`). All stubs are created INSIDE the context; string code
    // generation (eval/new Function) is disabled; microtasks are bounded by
    // the timeout.
    let context: import('node:vm').Context
    try {
        context = vm.createContext(Object.create(null), {
            codeGeneration: { strings: false, wasm: false },
            microtaskMode: 'afterEvaluate',
        })
        vm.runInContext(SANDBOX_PRELUDE, context, { timeout: timeoutMs })
    } catch (error) {
        return done(false, `Sandbox konnte nicht vorbereitet werden: ${String(error).slice(0, 120)}`)
    }

    const readAccessLog = (): string[] => {
        try {
            const raw = vm.runInContext('__nova_readAccessLog()', context, { timeout: 250 })
            if (typeof raw !== 'string') return ['access log unreadable']
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed) ? parsed.map(entry => String(entry)) : ['access log unreadable']
        } catch {
            return ['access log unreadable']
        }
    }
    const dangerousAccess = (log: string[]) => log.filter(a =>
        a.includes('process.exit') ||
        a.includes("require('") ||
        a.includes('fetch()') ||
        a.includes('access log unreadable'))

    try {
        script.runInContext(context, { timeout: timeoutMs })
    } catch (error: unknown) {
        // Never read properties of a thrown value that may come from the
        // sandbox (getters/proxies would run attacker code in the host).
        let code: unknown
        if (!isProxy(error) && error !== null && typeof error === 'object') {
            try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value } catch { code = undefined }
        }
        if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
            return done(false, `Code exceeded ${timeoutMs}ms timeout — possible infinite loop or DoS`)
        }
        const violations = dangerousAccess(readAccessLog())
        if (violations.length > 0) return done(false, `Sandbox violation: ${violations.join(', ')}`)
        // Fail-closed: a crash during the sandbox run is not evidence of safety.
        return done(false, 'Code warf beim Sandbox-Test einen Laufzeitfehler — ohne erfolgreichen Lauf keine Freigabe')
    }

    const violations = dangerousAccess(readAccessLog())
    if (violations.length > 0) {
        return done(false, `Sandbox detected dangerous access: ${violations.join(', ')}`)
    }
    return done(true)
}

/**
 * Runs inside the sandbox context before the tested code. Everything here is
 * created in the context's own realm. The access log lives in a closure and is
 * only readable through a non-configurable accessor that serialises with the
 * JSON.stringify captured at setup time.
 */
const SANDBOX_PRELUDE = `(() => {
    'use strict';
    const log = [];
    const stringify = JSON.stringify;
    const push = (entry) => { log[log.length] = String(entry); };
    const define = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
    define('__nova_readAccessLog', () => stringify(log));
    define('console', Object.freeze({ log: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }));
    define('setTimeout', () => { push('setTimeout'); });
    define('setInterval', () => { push('setInterval'); });
    define('require', (mod) => { push("require('" + String(mod) + "')"); throw new Error("require('" + String(mod) + "') is not allowed in sandbox"); });
    define('fetch', () => { push('fetch()'); throw new Error('fetch() is not allowed in sandbox'); });
    define('process', new Proxy(Object.freeze({}), {
        get: (_target, prop) => {
            push('process.' + String(prop));
            if (prop === 'env') return {};
            if (prop === 'exit') return () => { push('process.exit BLOCKED'); throw new Error('process.exit is not allowed in sandbox'); };
            return undefined;
        },
    }));
    const moduleObject = { exports: {} };
    globalThis.module = moduleObject;
    globalThis.exports = moduleObject.exports;
})();`

// ============================================
// 4. Signed Patches — Confidence Tracking
// ============================================

export interface PatchSignature {
    hash: string
    timestamp: string
    source: 'user' | 'nova-self' | 'mission' | 'sub-agent' | 'web-research' | 'unknown'
    confidence: 'high' | 'medium' | 'low'
    astFindings: number
    sandboxPassed: boolean
    path: string
    approved: boolean
}

const patchLog: PatchSignature[] = []

/**
 * Sign a patch — creates a hash + confidence level
 */
type ASTResult = { safe: boolean; confidence: number; findings: Array<{ severity: string; description: string;[key: string]: any }> }
type SandboxResult = { safe: boolean; error?: string; duration: number }

export function signPatch(
    content: string,
    path: string,
    source: PatchSignature['source'],
    astResult: ASTResult,
    sandboxResult: SandboxResult | null
): PatchSignature {
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)

    // Determine confidence
    let confidence: PatchSignature['confidence'] = 'high'
    if (source === 'web-research' || source === 'unknown') confidence = 'low'
    if (source === 'sub-agent' || source === 'mission') confidence = 'medium'
    if (astResult.findings.length > 0) confidence = 'low'
    if (sandboxResult && !sandboxResult.safe) confidence = 'low'

    const signature: PatchSignature = {
        hash,
        timestamp: new Date().toISOString(),
        source,
        confidence,
        astFindings: astResult.findings.length,
        sandboxPassed: sandboxResult?.safe ?? true,
        path,
        approved: confidence === 'high',  // Only high-confidence patches auto-approve
    }

    patchLog.push(signature)

    // Persist
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        // Keep only last 100 patches
        const recent = patchLog.slice(-100)
        writeFileSync(join(DATA_DIR, 'patch-log.json'), JSON.stringify(recent, null, 2))
    } catch { /* non-critical */ }

    // Log
    const icon = signature.approved ? '✅' : '⚠️'
    console.log(`[CodeGuardian] ${icon} Patch ${hash}: ${path} (source: ${source}, confidence: ${confidence}, AST: ${astResult.findings.length} findings, sandbox: ${sandboxResult?.safe ?? 'skipped'})`)

    return signature
}

/**
 * Get patch log
 */
export function getPatchLog(count = 20): PatchSignature[] {
    return patchLog.slice(-count)
}

/**
 * Full security check pipeline: AST → Sandbox → Sign
 */
export async function fullSecurityCheck(
    code: string,
    path: string,
    source: PatchSignature['source'] = 'unknown'
): Promise<{
    allowed: boolean
    signature: PatchSignature
    astResult: ASTResult
    sandboxResult: SandboxResult | null
    reason?: string
}> {
    // Kill-switch check
    if (killSwitchActive) {
        const sig = signPatch(code, path, source, { safe: false, confidence: 0, findings: [] }, null)
        sig.approved = false
        return {
            allowed: false,
            signature: sig,
            astResult: { safe: false, confidence: 0, findings: [] },
            sandboxResult: null,
            reason: `🚨 Kill-Switch aktiv: ${killSwitchReason}`,
        }
    }

    // Step 1: AST Analysis (REAL acorn parser)
    const astResult = await analyzeCodeSecurity(code, path)

    // Step 2: Sandbox (only for JS/TS code)
    let sandboxResult: SandboxResult | null = null
    if (path.endsWith('.js') || path.endsWith('.ts') || path.endsWith('.mjs')) {
        // Strip TypeScript types for sandbox (basic strip)
        const jsCode = code
            .replace(/:\s*(string|number|boolean|any|unknown|void|never)\b/g, '')
            .replace(/\binterface\s+\w+\s*\{[^}]*\}/g, '')
            .replace(/\btype\s+\w+\s*=\s*[^;]+;/g, '')
            .replace(/\bexport\s+/g, '')
            .replace(/\bimport\s+.*?from\s+['"][^'"]+['"];?/g, '')

        // Never execute code the static analysis already rejected.
        if (astResult.safe) {
            try {
                sandboxResult = await sandboxTest(jsCode, 3000)
            } catch (error) {
                // Fail-closed: an unavailable sandbox is not a pass.
                sandboxResult = { safe: false, error: `Sandbox nicht verfügbar: ${String(error).slice(0, 120)}`, duration: 0 }
            }
        }
    }

    // Step 3: Sign
    const signature = signPatch(code, path, source, astResult, sandboxResult)

    // Decision
    // Code files need a successful sandbox run; missing/failed runs are unsafe.
    const needsSandbox = path.endsWith('.js') || path.endsWith('.ts') || path.endsWith('.mjs')
    const allowed = astResult.safe && (needsSandbox ? sandboxResult?.safe === true : true) && !killSwitchActive

    if (!allowed) {
        const reasons: string[] = []
        if (!astResult.safe) reasons.push(`AST: ${astResult.findings.filter(f => f.severity === 'critical').map(f => f.description).join(', ')}`)
        if (sandboxResult && !sandboxResult.safe) reasons.push(`Sandbox: ${sandboxResult.error}`)
        return { allowed, signature, astResult, sandboxResult, reason: reasons.join(' | ') }
    }

    return { allowed, signature, astResult, sandboxResult }
}

// ============================================
// Init: Load persisted state
// ============================================

export function initCodeGuardian(): void {
    try {
        const ksPath = join(DATA_DIR, 'kill-switch.json')
        if (existsSync(ksPath)) {
            const data = JSON.parse(readFileSync(ksPath, 'utf-8'))
            if (data.active) {
                killSwitchActive = true
                killSwitchReason = data.reason || 'Loaded from disk'
                console.log(`[CodeGuardian] ⚠️ Kill-Switch was active: ${killSwitchReason}`)
            }
        }
    } catch { /* fresh start */ }

    console.log(`[CodeGuardian] ✅ Security Layer initialized (AST + Anomaly + Sandbox + Signed Patches)`)
}
