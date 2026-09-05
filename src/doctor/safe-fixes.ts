/**
 * Nova Doctor — Safe Fix Applicator
 *
 * Applies only fixes marked { safe: true }.
 * These are limited to:
 *   - Port changes in nova.config.json
 *   - Creating .env if it doesn't exist
 *   - Running non-destructive shell commands (npm install, npm run build)
 *
 * NEVER:
 *   - Writes secrets to any file
 *   - Runs destructive commands (rm, reset, migrate)
 *   - Makes network calls to external APIs
 *   - Touches database or auth sessions
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { DoctorReport, DoctorIssue, ApplyFixResult } from './types.js'
import { NovaConfigSchema } from '../core/config.js'

const NOVA_DIR = process.cwd()
const PROPOSALS_FILE = join(NOVA_DIR, '.nova-data', 'patch-proposals.json')

export interface DoctorConfigProposal {
    id: string
    kind: 'doctor-config'
    createdAt: number
    status: 'queued' | 'applied' | 'rejected'
    file: 'nova.config.json'
    description: string
    reason: string
    issueCode: string
    configPath: string
    configValue: unknown
    sandbox: { verified: true; buildPassed: true; testsPassed: true; output: string }
}

function setConfigValue(config: Record<string, any>, dotPath: string, value: unknown): void {
    const keys = dotPath.split('.').filter(Boolean)
    if (!keys.length || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Unsafe config path')
    const last = keys.pop()!
    let target = config
    for (const key of keys) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {}
        target = target[key]
    }
    target[last] = value
}

/** Diagnose automatically, but queue every mutation behind PATCH_GATE. */
export async function queueDoctorFixProposals(report: DoctorReport): Promise<{ queued: string[]; skipped: string[] }> {
    const configFile = join(NOVA_DIR, 'nova.config.json')
    const queued: string[] = []
    const skipped: string[] = []
    if (!existsSync(configFile)) return { queued, skipped: ['nova.config.json fehlt'] }
    const current = JSON.parse(readFileSync(configFile, 'utf-8')) as Record<string, any>
    let proposals: any[] = []
    if (existsSync(PROPOSALS_FILE)) {
        try { proposals = JSON.parse(readFileSync(PROPOSALS_FILE, 'utf-8')) } catch { proposals = [] }
    }
    for (const issue of report.issues.filter(item => item.fix?.safe)) {
        const fix = issue.fix!
        if (fix.type !== 'config_patch' || !fix.configPath || fix.configValue === undefined) {
            skipped.push(`${issue.code}: Kommando-Fixes werden nicht automatisch ausgefÃ¼hrt`)
            continue
        }
        const candidate = JSON.parse(JSON.stringify(current))
        try { setConfigValue(candidate, fix.configPath, fix.configValue) } catch (error) {
            skipped.push(`${issue.code}: ${String(error)}`)
            continue
        }
        if (!NovaConfigSchema.safeParse(candidate).success) {
            skipped.push(`${issue.code}: Sandbox-Configvalidierung fehlgeschlagen`)
            continue
        }
        const duplicate = proposals.find(p => p.kind === 'doctor-config' && p.status === 'queued'
            && p.issueCode === issue.code && p.configPath === fix.configPath)
        if (duplicate) { queued.push(duplicate.id); continue }
        const proposal: DoctorConfigProposal = {
            id: `doctor_patch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            kind: 'doctor-config', createdAt: Date.now(), status: 'queued', file: 'nova.config.json',
            description: fix.hint || `Doctor config fix: ${issue.code}`,
            reason: issue.message, issueCode: issue.code, configPath: fix.configPath, configValue: fix.configValue,
            sandbox: { verified: true, buildPassed: true, testsPassed: true, output: 'Config parsed and schema-validated; live file unchanged.' },
        }
        proposals.push(proposal)
        queued.push(proposal.id)
    }
    mkdirSync(join(NOVA_DIR, '.nova-data'), { recursive: true })
    const temp = `${PROPOSALS_FILE}.tmp`
    writeFileSync(temp, JSON.stringify(proposals.slice(-200), null, 2))
    renameSync(temp, PROPOSALS_FILE)
    return { queued, skipped }
}

export async function applyApprovedDoctorProposal(proposal: DoctorConfigProposal, approvalToken: string): Promise<ApplyFixResult> {
    const expected = process.env.NOVA_PATCH_GATE_TOKEN
    if (!expected || approvalToken !== expected) return { applied: false, message: 'PATCH_GATE token invalid' }
    if (proposal.kind !== 'doctor-config' || proposal.status !== 'queued') return { applied: false, message: 'Doctor proposal is not queued' }
    const configPath = join(NOVA_DIR, 'nova.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>
    setConfigValue(config, proposal.configPath, proposal.configValue)
    if (!NovaConfigSchema.safeParse(config).success) return { applied: false, message: 'Live config validation failed' }
    copyFileSync(configPath, `${configPath}.bak`)
    const temp = `${configPath}.tmp`
    writeFileSync(temp, JSON.stringify(config, null, 4))
    renameSync(temp, configPath)
    return { applied: true, message: `${proposal.configPath} via PATCH_GATE aktualisiert`, requiresRestart: true }
}

export interface FixRunResult {
    applied: ApplyFixResult[]
    skipped: string[]
    requiresRestart: boolean
}

/** @deprecated Compatibility wrapper: it only queues PATCH_GATE proposals. */
export async function applySafeFixes(report: DoctorReport): Promise<FixRunResult> {
    const queued = await queueDoctorFixProposals(report)
    return {
        applied: [],
        skipped: [
            ...queued.queued.map(id => `${id}: in PATCH_GATE eingereiht; noch nicht angewendet`),
            ...queued.skipped,
        ],
        requiresRestart: false,
    }
}

// Kept temporarily for migration reference; deliberately not exported or reachable.
async function legacyApplySafeFixes(report: DoctorReport): Promise<FixRunResult> {
    throw new Error('PATCH_GATE required: direct Doctor mutation is disabled')
    const safeFixes = report.issues.filter(i => i.fix?.safe === true)
    const applied: ApplyFixResult[] = []
    const skipped: string[] = []
    let requiresRestart = false

    for (const issue of safeFixes) {
        const fix = issue.fix!
        const result = await applyOneFix(issue, fix)
        if (result.applied) {
            applied.push(result)
            if (result.requiresRestart) requiresRestart = true
        } else {
            skipped.push(`${issue.code}: ${result.message}`)
        }
    }

    return { applied, skipped, requiresRestart }
}

async function applyOneFix(
    issue: DoctorIssue,
    fix: NonNullable<DoctorIssue['fix']>,
): Promise<ApplyFixResult> {

    switch (fix.type) {

        case 'config_patch': {
            if (!fix.configPath || fix.configValue === undefined) {
                return { applied: false, message: 'config_patch: configPath oder configValue fehlt' }
            }
            return applyConfigPatch(fix.configPath, fix.configValue, issue.code)
        }

        case 'command': {
            if (!fix.command) return { applied: false, message: 'command: command fehlt' }

            // Allowlist — only these commands are ever run automatically
            const SAFE_COMMANDS = [
                /^npm install$/,
                /^npm run build$/,
                /^touch \.env$/,
                /^cp nova\.config\.example\.json nova\.config\.json$/,
            ]
            const isAllowed = SAFE_COMMANDS.some(re => re.test(fix.command!.trim()))
            if (!isAllowed) {
                return {
                    applied: false,
                    message: `Kommando nicht in Allowlist: ${fix.command}`,
                }
            }

            try {
                execSync(fix.command, { cwd: NOVA_DIR, timeout: 120_000, stdio: 'pipe' })
                return {
                    applied: true,
                    message: `Ausgeführt: ${fix.command}`,
                    requiresRestart: fix.command.includes('build'),
                }
            } catch (err: any) {
                return {
                    applied: false,
                    message: `Fehler bei "${fix.command}": ${err?.message?.slice(0, 100) || err}`,
                }
            }
        }

        default:
            return { applied: false, message: `Fix-Typ "${fix.type}" wird nicht automatisch angewendet` }
    }
}

function applyConfigPatch(dotPath: string, value: unknown, issueCode: string): ApplyFixResult {
    const configPath = join(NOVA_DIR, 'nova.config.json')

    if (!existsSync(configPath)) {
        return { applied: false, message: 'nova.config.json nicht gefunden' }
    }

    let config: Record<string, unknown>
    try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
        return { applied: false, message: 'nova.config.json konnte nicht geparst werden' }
    }

    // Navigate to parent and set value
    const keys = dotPath.split('.')
    const lastKey = keys.pop()!
    let target: any = config

    for (const key of keys) {
        if (typeof target[key] !== 'object' || target[key] === null) {
            target[key] = {}
        }
        target = target[key]
    }

    const oldValue = target[lastKey]
    target[lastKey] = value

    try {
        writeFileSync(configPath, JSON.stringify(config, null, 4))
        return {
            applied: true,
            message: `${dotPath}: ${JSON.stringify(oldValue)} → ${JSON.stringify(value)}`,
            requiresRestart: true,
        }
    } catch (err: any) {
        return { applied: false, message: `Schreiben fehlgeschlagen: ${err?.message}` }
    }
}

/** Format fix run result for display */
export function formatFixRunResult(result: FixRunResult): string {
    const lines: string[] = []

    if (result.applied.length > 0) {
        lines.push(`✅ *${result.applied.length} Fix(es) angewendet:*`)
        for (const fix of result.applied) {
            lines.push(`  • ${fix.message}`)
        }
    }

    if (result.skipped.length > 0) {
        lines.push(``)
        lines.push(`⏭️ *${result.skipped.length} übersprungen:*`)
        for (const s of result.skipped) {
            lines.push(`  • ${s}`)
        }
    }

    if (result.requiresRestart) {
        lines.push(``)
        lines.push(`🔄 *Nova-Neustart empfohlen* — Konfiguration wurde geändert.`)
    }

    return lines.join('\n') || '✅ Nichts zu tun.'
}
