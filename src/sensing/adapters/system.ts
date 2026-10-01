/**
 * Eigene Systeme als Quelle (nur lesend): Nachtwache-Journal, Selbstheilungs-
 * Journal, Install-Journal und Self-Doctor-Findings. Liest nur neue Zeilen seit
 * dem letzten Lauf (Byte-Offsets im Adapter-Zustand); beim ersten Lauf wird nur
 * die Ausgangslage gemerkt, keine Altlasten gemeldet.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext, RawEvent, SensingAdapter } from '../event-bus.js'

const MAX_READ = 256 * 1024

function latestDated(dir: string): string | null {
    if (!existsSync(dir)) return null
    const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
    return files.length ? join(dir, files[files.length - 1]) : null
}

/** Reads complete new lines after `offset`. Returns the new offset. */
export function readNewLines(path: string, offset: number | undefined): { lines: string[]; offset: number; baseline: boolean } {
    const fd = openSync(path, 'r')
    try {
        const size = fstatSync(fd).size
        if (offset === undefined) return { lines: [], offset: size, baseline: true }
        const start = offset > size ? 0 : offset // file rotated/truncated
        const length = Math.min(MAX_READ, size - start)
        if (length <= 0) return { lines: [], offset: start, baseline: false }
        const buf = Buffer.alloc(length)
        readSync(fd, buf, 0, length, start)
        const text = buf.toString('utf8')
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline < 0) return { lines: [], offset: start, baseline: false }
        const complete = text.slice(0, lastNewline)
        return { lines: complete.split('\n').filter(Boolean), offset: start + Buffer.byteLength(complete, 'utf8') + 1, baseline: false }
    } finally { closeSync(fd) }
}

const parse = (line: string): any => { try { return JSON.parse(line) } catch { return null } }

export function nightwatchEvents(report: any): RawEvent[] {
    if (!report || !Array.isArray(report.results)) return []
    return report.results.filter((r: any) => r && r.status === 'fehler').slice(0, 10).map((r: any): RawEvent => ({
        kind: 'system.nightwatch', subject: String(r.host || r.id || 'nachtwache'), severity: r.severity === 'critical' ? 'urgent' : 'warning',
        dedupeKey: `nightwatch:${r.id}:${String(report.startedAt || '').slice(0, 13)}`,
        summary: `Nachtwache: ${r.label || r.id} — ${r.message || 'Fehler'}`,
        evidence: { pruefung: String(r.id || ''), host: String(r.host || ''), schwere: String(r.severity || '') },
    }))
}

export function selfHealEvents(entry: any): RawEvent[] {
    if (!entry || typeof entry.ergebnis !== 'string') return []
    const map: Record<string, { severity: RawEvent['severity']; importance: 'niedrig' | 'normal' | 'hoch' | 'dringend' }> = {
        'rueckweg-gescheitert': { severity: 'urgent', importance: 'dringend' },
        zurueckgerollt: { severity: 'warning', importance: 'hoch' },
        'gesperrt-fence': { severity: 'warning', importance: 'normal' },
        vorschlag: { severity: 'info', importance: 'normal' },
        geheilt: { severity: 'info', importance: 'niedrig' },
    }
    const rule = map[entry.ergebnis]
    if (!rule) return []
    return [{
        kind: 'system.self-heal', subject: String(entry.node || 'lokal'), severity: rule.severity,
        dedupeKey: `selfheal:${entry.id || `${entry.recipe}:${entry.at}`}`,
        summary: `Selbstheilung ${entry.recipe}: ${entry.ergebnis}${entry.message ? ` — ${entry.message}` : ''}`,
        evidence: { rezept: String(entry.recipe || ''), ergebnis: entry.ergebnis, knoten: String(entry.node || '') },
        hint: { importance: rule.importance },
    }]
}

export function installEvents(entry: any): RawEvent[] {
    if (!entry || typeof entry.event !== 'string') return []
    if (entry.event.endsWith('-receipt')) {
        const ok = entry.success === true
        return [{
            kind: 'system.install', subject: String(entry.catalogId || entry.id || 'install'), severity: ok ? 'info' : 'warning',
            dedupeKey: `install:${entry.id}:${entry.event}:${entry.ticketId || ''}`,
            summary: `Installation ${entry.event.replace('-receipt', '')} ${entry.id || ''}: ${ok ? 'erfolgreich' : 'fehlgeschlagen'}`,
            evidence: { vorschlag: String(entry.id || ''), erfolg: ok },
        }]
    }
    if (entry.event.endsWith('-timeout')) {
        return [{ kind: 'system.install', subject: String(entry.id || 'install'), severity: 'warning', dedupeKey: `install:${entry.id}:${entry.event}`, summary: `Installation ${entry.id || ''}: keine Quittung (Zeitüberschreitung)`, evidence: { vorschlag: String(entry.id || '') } }]
    }
    return []
}

export function doctorEvents(findings: any[], known: Set<string>): RawEvent[] {
    return findings
        .filter(f => f && f.status === 'open' && (f.severity === 'critical' || f.severity === 'warning') && !known.has(f.id))
        .slice(0, 10)
        .map((f): RawEvent => ({
            kind: 'system.doctor', subject: String(f.category || 'doctor'), severity: f.severity === 'critical' ? 'warning' : 'info',
            dedupeKey: `doctor:${f.id}`, dedupeWindowMs: 7 * 24 * 60 * 60_000,
            summary: `Self-Doctor: ${f.title}`,
            evidence: { befund: String(f.id), schwere: f.severity, kategorie: String(f.category || '') },
            hint: { importance: f.severity === 'critical' ? 'hoch' : 'niedrig' },
        }))
}

export function createSystemAdapter(options: { dataDir: string; intervalMs: number; timeoutMs: number; nightwatchDir?: string }): SensingAdapter {
    return {
        id: 'system', source: 'system', intervalMs: options.intervalMs, timeoutMs: options.timeoutMs,
        async poll(ctx: AdapterContext): Promise<RawEvent[]> {
            const offsets = (ctx.state.offsets as Record<string, number>) || {}
            const events: RawEvent[] = []
            const tail = (path: string | null, map: (value: any) => RawEvent[]) => {
                if (!path || !existsSync(path)) return
                const result = readNewLines(path, offsets[path])
                offsets[path] = result.offset
                for (const line of result.lines) events.push(...map(parse(line)))
            }
            tail(latestDated(options.nightwatchDir || join(options.dataDir, 'nightwatch')), nightwatchEvents)
            tail(latestDated(join(options.dataDir, 'self-heal', 'journal')), selfHealEvents)
            tail(join(options.dataDir, 'install-journal.jsonl'), installEvents)
            // Keep only offsets of files that still matter (dated files rotate daily).
            ctx.state.offsets = Object.fromEntries(Object.entries(offsets).filter(([path]) => existsSync(path)).slice(-20))

            const findingsPath = join(options.dataDir, 'self-doctor', 'findings.json')
            if (existsSync(findingsPath)) {
                let findings: any[] = []
                try {
                    const raw = JSON.parse(readFileSync(findingsPath, 'utf8'))
                    findings = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : []
                } catch { findings = [] }
                const known = Array.isArray(ctx.state.doctorKnown) ? new Set(ctx.state.doctorKnown as string[]) : null
                if (known) events.push(...doctorEvents(findings, known))
                ctx.state.doctorKnown = findings.filter(f => f?.status === 'open').map(f => String(f.id)).slice(-500)
            }
            return events
        },
    }
}
