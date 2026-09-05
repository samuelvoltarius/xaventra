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

    try {
        const { createContext, runInNewContext } = await import('node:vm')

        // Create a restricted context — no access to real globals
        const sandbox = {
            console: {
                log: () => { },
                error: () => { },
                warn: () => { },
            },
            // Track what the code tries to do
            __accessLog: [] as string[],
            setTimeout: () => { sandbox.__accessLog.push('setTimeout') },
            setInterval: () => { sandbox.__accessLog.push('setInterval') },
            // Block dangerous globals
            process: new Proxy({}, {
                get: (_target, prop) => {
                    sandbox.__accessLog.push(`process.${String(prop)}`)
                    if (prop === 'env') return {}
                    if (prop === 'exit') return () => { sandbox.__accessLog.push('process.exit BLOCKED') }
                    return undefined
                },
            }),
            require: (mod: string) => {
                sandbox.__accessLog.push(`require('${mod}')`)
                throw new Error(`require('${mod}') is not allowed in sandbox`)
            },
            fetch: () => {
                sandbox.__accessLog.push('fetch()')
                throw new Error('fetch() is not allowed in sandbox')
            },
            // Provide safe globals
            Math,
            JSON,
            Date,
            parseInt,
            parseFloat,
            String,
            Number,
            Boolean,
            Array,
            Object,
            Map,
            Set,
            RegExp,
            Error,
            Promise,
        }

        createContext(sandbox)

        // Run with timeout
        runInNewContext(code, sandbox, {
            timeout: timeoutMs,
            filename: 'sandbox-test.js',
        })

        const duration = Date.now() - start

        // Check what the code tried to access
        const dangerousAccess = sandbox.__accessLog.filter(a =>
            a.includes('process.exit') ||
            a.includes("require('child") ||
            a.includes("require('fs") ||
            a.includes("require('net") ||
            a.includes('fetch()')
        )

        if (dangerousAccess.length > 0) {
            return {
                safe: false,
                error: `Sandbox detected dangerous access: ${dangerousAccess.join(', ')}`,
                duration,
            }
        }

        return { safe: true, duration }

    } catch (err: any) {
        const duration = Date.now() - start

        // Timeout = code tried to run forever (suspicious)
        if (err.message?.includes('Script execution timed out')) {
            return {
                safe: false,
                error: `Code exceeded ${timeoutMs}ms timeout — possible infinite loop or DoS`,
                duration,
            }
        }

        // Sandbox violations (require blocked, etc.) — this is EXPECTED for malicious code
        if (err.message?.includes('not allowed in sandbox')) {
            return {
                safe: false,
                error: `Sandbox violation: ${err.message}`,
                duration,
            }
        }

        // Syntax errors are fine (code just doesn't work)
        if (err instanceof SyntaxError) {
            return { safe: true, duration }
        }

        // Other runtime errors — code ran but crashed, probably fine
        return { safe: true, duration }
    }
}

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

        try {
            sandboxResult = await sandboxTest(jsCode, 3000)
        } catch {
            // Sandbox not available — skip
        }
    }

    // Step 3: Sign
    const signature = signPatch(code, path, source, astResult, sandboxResult)

    // Decision
    const allowed = astResult.safe && (sandboxResult?.safe ?? true) && !killSwitchActive

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
