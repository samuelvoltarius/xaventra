/**
 * Nova Doctor Client
 *
 * Typed API wrapping the local llama engine (node-llama-cpp) for
 * autonomous error diagnosis, fix generation, and code review.
 *
 * Nova Doctor runs IN-PROCESS using the bundled GGUF models:
 *   - nova-doctor-1.5b-q5km.gguf  (1.1 GB, production)
 *   - nova-doctor-0.5b-q5km.gguf  (401 MB, fast fallback)
 *
 * Used by: L0-self-repair, L15-self-check, L36-auto-bug-fix, L37-code-review
 */

import { getLlamaEngine, hasLocalModel } from '../llm/llama-engine.js'
import { DOCTOR_DIAGNOSIS_INSTRUCTIONS, DOCTOR_FIX_PLAN_GRAMMAR, parseDoctorDiagnosis } from './doctor-contract.js'
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Telemetry ────────────────────────────────────────────────────────────────

const TELEMETRY_DIR  = join(process.cwd(), '.nova-data', 'doctor-telemetry')
const TELEMETRY_FILE = join(TELEMETRY_DIR, 'usage.jsonl')

function recordTelemetry(event: {
    type: 'diagnose' | 'review' | 'fix'
    fromModel: boolean
    confidence?: string
    durationMs: number
    errorPrefix?: string     // First 80 chars of error — no secrets
}) {
    try {
        if (!existsSync(TELEMETRY_DIR)) mkdirSync(TELEMETRY_DIR, { recursive: true })
        const entry = JSON.stringify({ ts: new Date().toISOString(), ...event })
        appendFileSync(TELEMETRY_FILE, entry + '\n')
    } catch { /* telemetry is never critical */ }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiagnoseInput {
    /** The error message or stack trace */
    error: string
    /** Optional: the code context where the error occurred */
    code?: string
    /** Optional: filename or module path */
    file?: string
    /** Optional: additional context (e.g. OS, runtime version) */
    context?: Record<string, string>
}

export interface DiagnoseResult {
    /** Short explanation of what's wrong */
    diagnosis: string
    /** Step-by-step fix suggestion */
    fix: string
    /** Whether the fix should be applied automatically (safe) or reviewed */
    autoApply: boolean
    /** Whether the model was available for inference */
    fromModel: boolean
    /** Confidence: 'high' | 'medium' | 'low' */
    confidence: 'high' | 'medium' | 'low'
}

export interface CodeReviewResult {
    /** Issues found */
    issues: string[]
    /** Suggestions for improvement */
    suggestions: string[]
    /** Security concerns (if any) */
    security: string[]
    /** Overall severity: 'ok' | 'warning' | 'critical' */
    severity: 'ok' | 'warning' | 'critical'
}

export interface BugFixResult {
    /** The fixed code snippet */
    fixedCode: string
    /** Explanation of what was changed */
    explanation: string
    /** Whether this is a safe auto-apply candidate */
    safe: boolean
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildDiagnosePrompt(input: DiagnoseInput): string {
    const parts = [
        `Analyze the following error and provide a concise diagnosis and fix.`,
        ``,
        `ERROR:`,
        input.error,
    ]

    if (input.file) parts.push(`\nFILE: ${input.file}`)
    if (input.code) parts.push(`\nCODE CONTEXT:\n${input.code}`)
    if (input.context) {
        const ctx = Object.entries(input.context).map(([k, v]) => `  ${k}: ${v}`).join('\n')
        parts.push(`\nCONTEXT:\n${ctx}`)
    }

    parts.push(
        ``,
        `Doctor report: ${JSON.stringify({ issues: [{ code: 'RUNTIME_ERROR', severity: 'error', message: input.error }], context: input.context ?? {} })}`,
        `Only output the JSON object, no other text.`
    )

    return parts.join('\n')
}

function buildCodeReviewPrompt(code: string, file?: string): string {
    return [
        `You are Nova Doctor, an expert code reviewer.`,
        `Review the following code for bugs, security issues, and improvements.`,
        file ? `File: ${file}` : '',
        ``,
        `CODE:`,
        code,
        ``,
        `Respond in JSON:`,
        `{`,
        `  "issues": ["<issue1>", ...],`,
        `  "suggestions": ["<suggestion1>", ...],`,
        `  "security": ["<security concern1>", ...],`,
        `  "severity": "<ok|warning|critical>"`,
        `}`,
        `Only output the JSON object.`,
    ].filter(Boolean).join('\n')
}

function buildBugFixPrompt(code: string, error: string): string {
    return [
        `You are Nova Doctor. Fix the following bug in the code.`,
        ``,
        `ERROR: ${error}`,
        ``,
        `CODE TO FIX:`,
        code,
        ``,
        `Respond in JSON:`,
        `{`,
        `  "fixedCode": "<the complete fixed code>",`,
        `  "explanation": "<what was changed and why>",`,
        `  "safe": <true if safe to auto-apply without review>`,
        `}`,
        `Only output the JSON object.`,
    ].join('\n')
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function fallbackDiagnosis(input: DiagnoseInput): DiagnoseResult {
    // Rule-based heuristics when no model is available
    const err = input.error.toLowerCase()
    let diagnosis = 'Unknown error — manual investigation required.'
    let fix = 'Check logs and review the code manually.'

    if (err.includes('econnrefused') || err.includes('connection refused')) {
        diagnosis = 'Service connection refused — the target service is not running or unreachable.'
        fix = 'Start the required service, check network/firewall settings, verify the port/host.'
    } else if (err.includes('cannot find module') || err.includes('module not found')) {
        diagnosis = 'Missing Node.js module — package not installed or import path incorrect.'
        fix = 'Run `npm install` or check the import path spelling and file extension (.js).'
    } else if (err.includes('typeerror') || err.includes('is not a function')) {
        diagnosis = 'Type error — calling a method on wrong type or undefined value.'
        fix = 'Add null checks before calling methods; verify the variable type at runtime.'
    } else if (err.includes('eacces') || err.includes('permission denied')) {
        diagnosis = 'Permission denied — insufficient filesystem or network permissions.'
        fix = 'Check file/directory permissions. On Linux: `chmod`/`chown`. On Windows: run as admin or fix ACLs.'
    } else if (err.includes('syntax error')) {
        diagnosis = 'Syntax error in code — invalid JavaScript/TypeScript syntax.'
        fix = 'Run TypeScript compiler (`tsc --noEmit`) to pinpoint the syntax error location.'
    }

    return { diagnosis, fix, autoApply: false, fromModel: false, confidence: 'low' }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Diagnose an error using Nova Doctor (local GGUF model).
 * Falls back to rule-based heuristics if no model is available.
 */
export async function diagnose(input: DiagnoseInput): Promise<DiagnoseResult> {
    const t0 = Date.now()
    const engine = await getLlamaEngine()

    if (!engine) {
        const result = fallbackDiagnosis(input)
        recordTelemetry({ type: 'diagnose', fromModel: false, confidence: 'low', durationMs: Date.now() - t0, errorPrefix: input.error.slice(0, 80) })
        return result
    }

    try {
        const prompt = buildDiagnosePrompt(input)
        const raw = await engine.complete(prompt, {
            systemPrompt: DOCTOR_DIAGNOSIS_INSTRUCTIONS,
            jsonSchema: DOCTOR_FIX_PLAN_GRAMMAR,
            signal: AbortSignal.timeout(60000),
            maxTokens: 1200,
            temperature: 0.05,
            stopStrings: ['```', '\n\n\n'],
        })

        const result: DiagnoseResult = parseDoctorDiagnosis(raw, { reportedError: input.error })
        recordTelemetry({ type: 'diagnose', fromModel: true, confidence: result.confidence, durationMs: Date.now() - t0, errorPrefix: input.error.slice(0, 80) })
        return result
    } catch (err: any) {
        console.warn('[NovaDoctorClient] Diagnosis failed validation; using unverified rule-based fallback')
        recordTelemetry({ type: 'diagnose', fromModel: false, confidence: 'low', durationMs: Date.now() - t0, errorPrefix: input.error.slice(0, 80) })
        return { ...fallbackDiagnosis(input), fromModel: false }
    }
}

/**
 * Review code for bugs, security issues, and improvements.
 */
export async function reviewCode(code: string, file?: string): Promise<CodeReviewResult> {
    const t0 = Date.now()
    const engine = await getLlamaEngine()

    const empty: CodeReviewResult = { issues: [], suggestions: ['Doctor review unavailable or unverified; independent review required.'], security: [], severity: 'warning' }
    if (!engine) return empty

    try {
        const prompt = buildCodeReviewPrompt(code, file)
        const raw = await engine.complete(prompt, {
            maxTokens: 600,
            temperature: 0.1,
        })

        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (!jsonMatch) return empty

        const parsed = JSON.parse(jsonMatch[0])
        const result: CodeReviewResult = {
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
            security: Array.isArray(parsed.security) ? parsed.security : [],
            severity: ['ok', 'warning', 'critical'].includes(parsed.severity) ? parsed.severity : 'ok',
        }
        recordTelemetry({ type: 'review', fromModel: true, confidence: result.severity === 'ok' ? 'high' : 'medium', durationMs: Date.now() - t0 })
        return result
    } catch {
        return empty
    }
}

/**
 * Generate a fix for a buggy code snippet.
 */
export async function generateFix(code: string, error: string): Promise<BugFixResult | null> {
    const t0 = Date.now()
    const engine = await getLlamaEngine()
    if (!engine) return null

    try {
        const prompt = buildBugFixPrompt(code, error)
        const raw = await engine.complete(prompt, {
            maxTokens: 800,
            temperature: 0.05,
        })

        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (!jsonMatch) return null

        const parsed = JSON.parse(jsonMatch[0])
        const result: BugFixResult = {
            fixedCode: parsed.fixedCode ?? '',
            explanation: parsed.explanation ?? '',
            // A model response is never PATCH_GATE approval.
            safe: false,
        }
        recordTelemetry({ type: 'fix', fromModel: true, confidence: result.safe ? 'high' : 'medium', durationMs: Date.now() - t0, errorPrefix: error.slice(0, 80) })
        return result
    } catch {
        return null
    }
}

/**
 * Whether Nova Doctor is available (model present on disk).
 */
export function isDoctorAvailable(): boolean {
    return hasLocalModel()
}
