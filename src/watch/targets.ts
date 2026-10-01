/**
 * Wächter — eigene Zielliste (2.82.0 Aufräumen „ein Wächter“).
 *
 * L19 (Service Monitor, `.nova-data/monitoring.json`) hatte eine eigene
 * Zielliste und eigene HTTP-Prüfungen neben den Wächter-Zielen. Jetzt gibt es
 * eine Mess- und Ziellogik, den Wächter:
 *   - Ziele aus der Config: `autonomy.watch.targets` (unverändert)
 *   - Ziele per /monitor add und die übernommenen L19-Ziele:
 *       `<data>/watch/targets.json`  { version: 1, targets: WatchTarget[], rejected: string[], migratedFrom? }
 * Die L19-Datei wird einmal übernommen und danach in `monitoring.json.migriert`
 * umbenannt (nichts gelöscht; ein zweiter Lauf übernimmt nichts doppelt).
 * Gleiche Feste Regeln wie die Config-Ziele: keine Zugangsdaten, keine
 * Bereiche, keine Passwortmanager.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { MAX_TARGETS, normalizeWatchTarget, type WatchTarget } from './settings.js'

export interface ManagedTargets { targets: WatchTarget[]; rejected: string[]; migratedFrom?: string; migratedAt?: string }

const file = (watchDir: string) => join(watchDir, 'targets.json')

export function loadManagedTargets(watchDir: string): ManagedTargets {
    try {
        const raw = JSON.parse(readFileSync(file(watchDir), 'utf8'))
        if (raw?.version !== 1 || !Array.isArray(raw.targets)) return { targets: [], rejected: [] }
        const targets: WatchTarget[] = []
        for (const item of raw.targets.slice(0, MAX_TARGETS)) {
            const target = normalizeWatchTarget(item, 'monitor')
            if (typeof target !== 'string' && !targets.some(existing => existing.id === target.id)) targets.push(target)
        }
        return {
            targets,
            rejected: Array.isArray(raw.rejected) ? raw.rejected.map(String).slice(0, 32) : [],
            ...(typeof raw.migratedFrom === 'string' ? { migratedFrom: raw.migratedFrom } : {}),
            ...(typeof raw.migratedAt === 'string' ? { migratedAt: raw.migratedAt } : {}),
        }
    } catch { return { targets: [], rejected: [] } }
}

function save(watchDir: string, value: ManagedTargets): void {
    if (!existsSync(watchDir)) mkdirSync(watchDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(watchDir), { version: 1, ...value })
}

/** http/https URL → one Wächter target (same validation as config targets). */
export function targetFromUrl(name: unknown, url: unknown): WatchTarget | string {
    const label = String(name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60)
    let parsed: URL
    try { parsed = new URL(String(url ?? '')) } catch { return `${label || '?'}: keine gültige URL` }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `${label || parsed.hostname}: nur http/https`
    if (parsed.username || parsed.password) return `${label || parsed.hostname}: Zugangsdaten in der URL werden nie übernommen`
    if (parsed.search || parsed.hash) return `${label || parsed.hostname}: URL mit Query/Fragment wird nicht übernommen`
    const kind = parsed.protocol === 'https:' ? 'https' : 'http'
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    return normalizeWatchTarget({ name: label || host, host, kind, port: parsed.port ? Number(parsed.port) : undefined, path: parsed.pathname || '/' }, 'monitor')
}

export function addManagedTarget(watchDir: string, name: string, url: string): WatchTarget | string {
    const target = targetFromUrl(name, url)
    if (typeof target === 'string') return target
    const current = loadManagedTargets(watchDir)
    if (current.targets.some(item => item.id === target.id || item.name.toLowerCase() === target.name.toLowerCase())) return `${target.name}: schon in der Liste`
    if (current.targets.length >= MAX_TARGETS) return `höchstens ${MAX_TARGETS} Ziele`
    save(watchDir, { ...current, targets: [...current.targets, target] })
    return target
}

export function removeManagedTarget(watchDir: string, name: string): boolean {
    const current = loadManagedTargets(watchDir)
    const wanted = String(name || '').trim().toLowerCase()
    const kept = current.targets.filter(item => item.name.toLowerCase() !== wanted)
    if (kept.length === current.targets.length) return false
    save(watchDir, { ...current, targets: kept })
    return true
}

/**
 * One-time take-over of the L19 target list. Returns what happened; the legacy
 * file is renamed to `<file>.migriert` (never deleted). Without a legacy file,
 * or once migrated, nothing changes.
 */
export function migrateLegacyMonitorTargets(options: { legacyFile: string; watchDir: string; now?: () => number }): { migrated: number; rejected: string[]; reason: string } {
    const { legacyFile, watchDir } = options
    if (!existsSync(legacyFile)) return { migrated: 0, rejected: [], reason: 'keine L19-Datei' }
    let raw: any
    try { raw = JSON.parse(readFileSync(legacyFile, 'utf8')) } catch { raw = null }
    const current = loadManagedTargets(watchDir)
    const targets = [...current.targets]
    const rejected: string[] = []
    for (const item of Array.isArray(raw?.targets) ? raw.targets.slice(0, MAX_TARGETS) : []) {
        const target = targetFromUrl(item?.name, item?.url)
        if (typeof target === 'string') { rejected.push(`L19 ${target}`); continue }
        if (!targets.some(existing => existing.id === target.id)) targets.push(target)
    }
    const migrated = targets.length - current.targets.length
    save(watchDir, {
        targets: targets.slice(0, MAX_TARGETS),
        rejected: [...current.rejected, ...rejected].slice(-32),
        migratedFrom: 'monitoring.json',
        migratedAt: new Date((options.now ?? Date.now)()).toISOString(),
    })
    renameSync(legacyFile, `${legacyFile}.migriert`)
    return { migrated, rejected, reason: raw ? `${migrated} L19-Ziel(e) übernommen` : 'L19-Datei unlesbar — nur umbenannt' }
}
