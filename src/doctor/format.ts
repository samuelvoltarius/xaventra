/**
 * Nova Doctor — Human-Readable Formatter
 *
 * Converts a DoctorReport to Telegram-friendly Markdown.
 * Two modes: compact (Telegram/chat) and full (CLI --deep).
 */

import type { DoctorReport, DoctorIssue, CheckResult } from './types.js'

const SEV_ICON: Record<DoctorIssue['severity'], string> = {
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
}

const STATUS_ICON = (r: CheckResult) => r.ok ? '✅' : r.issues.some(i => i.severity === 'error') ? '❌' : '⚠️'

/** Compact Telegram output (fits in one message) */
export function formatReportCompact(report: DoctorReport): string {
    const { summary, checks } = report
    const healthIcon = summary.healthy ? '✅' : summary.errors > 0 ? '❌' : '⚠️'
    const healthLabel = summary.healthy ? 'Alles OK' : summary.errors > 0 ? `${summary.errors} Fehler` : `${summary.warnings} Warnung(en)`

    const lines: string[] = [
        `🩺 *Nova Doctor* — ${healthIcon} ${healthLabel}`,
        ``,
    ]

    // Check overview table
    const checkOrder: Array<keyof typeof checks> = ['config', 'env', 'runtime', 'gpu', 'ports', 'providers', 'channels', 'mesh']
    const labelWidth = 22
    for (const key of checkOrder) {
        const r = checks[key]
        const icon = STATUS_ICON(r)
        const label = r.label.padEnd(labelWidth, ' ')
        lines.push(`${icon} \`${label}\` ${r.status}`)
    }

    // Issue details (errors + warnings only)
    const actionable = report.issues.filter(i => i.severity !== 'info')
    if (actionable.length > 0) {
        lines.push(``)
        lines.push(`*Probleme:*`)
        for (const issue of actionable.slice(0, 8)) {
            const icon = SEV_ICON[issue.severity]
            lines.push(`${icon} ${issue.message}`)
            if (issue.fix?.hint) {
                lines.push(`   → ${issue.fix.hint}`)
            }
        }
        if (actionable.length > 8) {
            lines.push(`   _… und ${actionable.length - 8} weitere. /doctor --deep für alles_`)
        }
    }

    // Safe fixes summary
    const safeFixes = report.issues.filter(i => i.fix?.safe)
    if (safeFixes.length > 0) {
        lines.push(``)
        lines.push(`*💊 Sichere Fixes verfügbar (${safeFixes.length}):*`)
        for (const issue of safeFixes.slice(0, 3)) {
            lines.push(`  • ${issue.fix!.hint}`)
        }
        lines.push(`_/doctor fix — alle sicheren Fixes anwenden_`)
    }

    // Footer
    lines.push(``)
    lines.push(`_${new Date(report.timestamp).toLocaleString('de-AT')} · Nova ${report.version} · ${report.platform} ${report.nodeVersion}_`)

    return lines.join('\n')
}

/** Full CLI output (all details, no length limit) */
export function formatReportFull(report: DoctorReport): string {
    const { summary, checks } = report

    const lines: string[] = [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🩺  Nova Doctor  v${report.version}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Platform: ${report.platform}  Node: ${report.nodeVersion}`,
        `Time:     ${new Date(report.timestamp).toLocaleString('de-AT')}`,
        ``,
    ]

    // All checks
    const checkOrder: Array<keyof typeof checks> = ['config', 'env', 'runtime', 'gpu', 'ports', 'providers', 'channels', 'mesh']
    for (const key of checkOrder) {
        const r = checks[key]
        const icon = STATUS_ICON(r)
        lines.push(`  ${icon}  ${r.label.padEnd(20)} ${r.status}`)
    }

    lines.push(``)
    lines.push(`  Errors: ${summary.errors}  Warnings: ${summary.warnings}  OK: ${summary.ok}`)

    // All issues with details
    if (report.issues.length > 0) {
        lines.push(``)
        lines.push(`━━ Issues ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

        let currentSev = ''
        for (const issue of report.issues) {
            if (issue.severity !== currentSev) {
                currentSev = issue.severity
                const sevLabel = issue.severity === 'error' ? '❌ ERRORS' :
                    issue.severity === 'warning' ? '⚠️ WARNINGS' : 'ℹ️ INFO'
                lines.push(``, `  ${sevLabel}`)
            }
            lines.push(`    [${issue.code}] ${issue.message}`)
            if (issue.detail) lines.push(`      ${issue.detail}`)
            if (issue.fix) {
                const safeTag = issue.fix.safe ? '[SAFE]' : '[MANUAL]'
                lines.push(`      → ${safeTag} ${issue.fix.hint}`)
                if (issue.fix.type === 'command' && issue.fix.command) {
                    lines.push(`         $ ${issue.fix.command}`)
                }
            }
        }
    }

    // Config snapshot
    if (report.configSnapshot) {
        lines.push(``)
        lines.push(`━━ Config Snapshot ━━━━━━━━━━━━━━━━━━━`)
        lines.push(`  Provider:  ${report.configSnapshot.provider || '(nicht gesetzt)'}`)
        lines.push(`  Model:     ${report.configSnapshot.model || '(nicht gesetzt)'}`)
        lines.push(`  REST Port: ${report.configSnapshot.restPort}`)
        if (report.configSnapshot.channels) {
            const enabledCh = Object.entries(report.configSnapshot.channels)
                .filter(([, v]) => v).map(([k]) => k)
            const disabledCh = Object.entries(report.configSnapshot.channels)
                .filter(([, v]) => !v).map(([k]) => k)
            if (enabledCh.length > 0) lines.push(`  Channels:  ✅ ${enabledCh.join(', ')}`)
            if (disabledCh.length > 0) lines.push(`             ⬜ ${disabledCh.join(', ')} (deaktiviert)`)
        }
    }

    // Safe fix summary
    const safeFixes = report.issues.filter(i => i.fix?.safe)
    if (safeFixes.length > 0) {
        lines.push(``)
        lines.push(`━━ Safe Fixes ━━━━━━━━━━━━━━━━━━━━━━━━`)
        for (const issue of safeFixes) {
            lines.push(`  💊 ${issue.code}`)
            lines.push(`     ${issue.fix!.hint}`)
            if (issue.fix!.command) lines.push(`     $ ${issue.fix!.command}`)
        }
        lines.push(``)
        lines.push(`  Run: /doctor fix`)
    }

    lines.push(``)
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    return lines.join('\n')
}

/** JSON output for machine consumption / small LLM */
export function formatReportJson(report: DoctorReport): string {
    // Strip fix details to keep payload small for LLM context
    const compact = {
        timestamp: report.timestamp,
        version: report.version,
        platform: report.platform,
        nodeVersion: report.nodeVersion,
        summary: report.summary,
        config: report.configSnapshot,
        checks: Object.fromEntries(
            Object.entries(report.checks).map(([k, r]) => [k, {
                ok: r.ok,
                status: r.status,
                issueCount: r.issues.length,
            }])
        ),
        issues: report.issues.map(i => ({
            code: i.code,
            severity: i.severity,
            message: i.message,
            fixType: i.fix?.type,
            fixHint: i.fix?.hint,
            safe: i.fix?.safe ?? false,
        })),
    }
    return JSON.stringify(compact, null, 2)
}
