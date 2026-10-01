/**
 * Stufe 3 — der feste Rezeptkatalog (S3.1). Drei auto-Rezepte (Alfred
 * 01.10.2026) und drei Vorschlags-Rezepte, die nie selbst etwas ausführen.
 *
 * Every filesystem effect goes through `resolveInDataDir`; nothing here spawns
 * a process, opens a shell or talks SSH. Symptom thresholds come from
 * measurements (stat, statfs, HTTP probe, Nachtwache evidence), not guesses.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { resolveInDataDir, type EndpointController, type EndpointEntry, type HealContext, type HealOutcome, type HealRecipe, type HealSymptom } from './self-heal.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Own append-only logs/audits (all written by path with appendFileSync, so a
 * rename hands later writes a fresh file). Fixed list, relative to the data dir. */
export const OWN_LOG_FILES: readonly string[] = Object.freeze([
    'subagent-audit.jsonl',
    'lifecycle-audit.jsonl',
    'memory/governance/audit.jsonl',
    'outcome-router-shadow.jsonl',
])

/** Own regenerable caches/temp. Fixed list, relative to the data dir. */
export const OWN_CACHE_DIRS: readonly string[] = Object.freeze(['tmp', 'cache', 'bench-temp'])
export const OWN_CACHE_FILES: readonly string[] = Object.freeze(['resolver-cache.json'])

export type GzipFn = (source: string, target: string) => Promise<void>
export interface DiskUsage { usedPercent: number; freeBytes: number; totalBytes: number }

export interface RecipeDeps {
    gzip?: GzipFn
    files?: readonly string[]
    rename?: (from: string, to: string) => void
    diskUsage?: (path: string) => DiskUsage | null
    endpoints?: EndpointController
    retryDelayMs?: number
    leaseFailures?: () => Array<{ service: string; status: number; failures: number }>
    fenceStatus?: () => Record<string, unknown>
}

const defaultGzip: GzipFn = async (source, target) => {
    await pipeline(createReadStream(source), createGzip(), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
}

async function sha256Gunzip(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path).pipe(createGunzip())) hash.update(chunk as Buffer)
    return hash.digest('hex')
}

const stamp = (ctx: HealContext) => new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')
const flat = (rel: string) => rel.replace(/[\\/]/g, '__')
const relOf = (ctx: HealContext, abs: string) => relative(ctx.dataDir, abs).replace(/\\/g, '/')
const plainFile = (abs: string) => { try { const st = lstatSync(abs); return st.isFile() && !st.isSymbolicLink() ? st : null } catch { return null } }

// ---------------------------------------------------------------------------
// auto 1: eigene Log-/Audit-Dateien rotieren + komprimieren (nie löschen)
// ---------------------------------------------------------------------------

export function createLogRotationRecipe(deps: Pick<RecipeDeps, 'gzip' | 'files'>): HealRecipe {
    const files = deps.files ?? OWN_LOG_FILES
    const gzip = deps.gzip ?? defaultGzip
    const archiveCount = (ctx: HealContext, rel: string) => {
        const dir = resolveInDataDir(ctx.dataDir, 'self-heal/archive')
        return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(`${flat(rel)}.`) && name.endsWith('.gz')).length : 0
    }
    return {
        id: 'log-rotation',
        level: 'auto',
        title: 'Eigene Log-/Audit-Datei ins Archiv rotiert',
        effects: ['fs:eigene-logs-archivieren'],
        targets: [...files],
        cooldownMs: HOUR,
        maxPerDay: 12,
        async detect(ctx) {
            const out: HealSymptom[] = []
            for (const rel of files) {
                const abs = resolveInDataDir(ctx.dataDir, rel)
                const st = plainFile(abs)
                if (st && st.size >= ctx.settings.logRotateBytes) {
                    out.push({ signature: `log-gross:${rel}`, evidence: { datei: rel, bytes: st.size, schwelle: ctx.settings.logRotateBytes }, data: { rel } })
                }
            }
            return out
        },
        async measure(ctx, symptom) {
            const rel = symptom.data.rel as string
            const abs = resolveInDataDir(ctx.dataDir, rel)
            const st = plainFile(abs)
            return { datei: rel, bytes: st ? st.size : 0, sha256: st ? await sha256File(abs) : null, archive: archiveCount(ctx, rel) }
        },
        async act(ctx, symptom) {
            const rel = symptom.data.rel as string
            const abs = resolveInDataDir(ctx.dataDir, rel)
            const rotating = resolveInDataDir(ctx.dataDir, `${rel}.heal-rotating`)
            if (existsSync(rotating)) return { ok: false, evidence: { fehler: 'Rest einer früheren Rotation vorhanden' }, undo: { rel, abs, rotating: null } }
            renameSync(abs, rotating)
            const undo: Record<string, unknown> = { rel, abs, rotating }
            try {
                const bytes = statSync(rotating).size
                const sha = await sha256File(rotating)
                const archiveDir = resolveInDataDir(ctx.dataDir, 'self-heal/archive')
                mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
                const archive = resolveInDataDir(ctx.dataDir, `self-heal/archive/${flat(rel)}.${stamp(ctx)}.gz`)
                Object.assign(undo, { archive, bytes, sha })
                await gzip(rotating, archive)
                return { ok: true, evidence: { archiv: relOf(ctx, archive) }, undo }
            } catch (error) {
                return { ok: false, evidence: { fehler: String((error as Error)?.message || error).slice(0, 300) }, undo }
            }
        },
        async probe(_ctx, _symptom, acted) {
            const { rotating, archive, bytes, sha } = acted.undo
            if (!existsSync(rotating) || !existsSync(archive)) return { ok: false, evidence: { probe: 'Quelle oder Archiv fehlt' } }
            if (statSync(rotating).size !== bytes || await sha256File(rotating) !== sha) return { ok: false, evidence: { probe: 'Quelle während der Rotation verändert' } }
            const archived = await sha256Gunzip(archive).catch(() => null)
            if (archived !== sha) return { ok: false, evidence: { probe: 'Archiv entpackt nicht bytegleich' } }
            return { ok: true, evidence: { archivBytes: statSync(archive).size, sha256: sha } }
        },
        async commit(_ctx, _symptom, acted) {
            // Content lives on, verified, in the archive; only the uncompressed duplicate goes.
            unlinkSync(acted.undo.rotating)
        },
        async rollback(_ctx, _symptom, acted) {
            const { abs, rotating, archive } = acted.undo || {}
            if (!rotating || !existsSync(rotating)) return { ok: Boolean(abs && existsSync(abs)), evidence: { rueckweg: 'nichts umbenannt' } }
            if (existsSync(abs)) {
                // Lines appended after the rename: keep them, after the original content.
                appendFileSync(rotating, readFileSync(abs))
                unlinkSync(abs)
            }
            renameSync(rotating, abs)
            let marked: string | null = null
            if (archive && existsSync(archive)) {
                marked = `${archive}.unvollstaendig`
                renameSync(archive, marked) // never deleted, never counted as an archive
            }
            return { ok: existsSync(abs), evidence: { rueckweg: 'Datei wiederhergestellt', unvollstaendigesArchiv: marked ? 'markiert' : null } }
        },
    }
}

// ---------------------------------------------------------------------------
// auto 2: eigene Zwischenspeicher nach fester Liste leeren (nur bei Platte >= Schwelle)
// ---------------------------------------------------------------------------

interface CacheEntry { rel: string; bytes: number }

function treeBytes(abs: string): number {
    const st = lstatSync(abs)
    if (st.isSymbolicLink() || !st.isDirectory()) return st.size
    let total = 0
    for (const name of readdirSync(abs)) total += treeBytes(join(abs, name))
    return total
}

function listCacheEntries(ctx: HealContext): CacheEntry[] {
    const entries: CacheEntry[] = []
    for (const dir of OWN_CACHE_DIRS) {
        const abs = resolveInDataDir(ctx.dataDir, dir)
        let st
        try { st = lstatSync(abs) } catch { continue }
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        for (const name of readdirSync(abs).sort()) {
            const rel = `${dir}/${name}`
            entries.push({ rel, bytes: treeBytes(resolveInDataDir(ctx.dataDir, rel)) })
        }
    }
    for (const file of OWN_CACHE_FILES) {
        const st = plainFile(resolveInDataDir(ctx.dataDir, file))
        if (st) entries.push({ rel: file, bytes: st.size })
    }
    return entries
}

export function createCacheRecipe(deps: Pick<RecipeDeps, 'diskUsage' | 'rename'>): HealRecipe {
    const rename = deps.rename ?? renameSync
    return {
        id: 'cache-leeren',
        level: 'auto',
        title: 'Eigene Zwischenspeicher geleert',
        effects: ['fs:eigene-caches-leeren'],
        targets: [...OWN_CACHE_DIRS, ...OWN_CACHE_FILES],
        cooldownMs: 6 * HOUR,
        maxPerDay: 4,
        async detect(ctx) {
            const usage = deps.diskUsage?.(ctx.dataDir) ?? null
            if (!usage || usage.usedPercent < ctx.settings.diskPercent) return []
            const entries = listCacheEntries(ctx)
            if (!entries.length) return []
            return [{ signature: 'platte-voll:eigene-caches', evidence: { plattenProzent: usage.usedPercent, schwelle: ctx.settings.diskPercent, cacheBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), eintraege: entries.length } }]
        },
        async measure(ctx) {
            const entries = listCacheEntries(ctx)
            return { eintraege: entries.map(entry => `${entry.rel}:${entry.bytes}`), cacheBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }
        },
        async act(ctx) {
            const quarantineRel = `self-heal/quarantine/${stamp(ctx)}`
            const quarantine = resolveInDataDir(ctx.dataDir, quarantineRel)
            const moves: Array<{ from: string; to: string; bytes: number }> = []
            const undo = { quarantine, moves }
            try {
                mkdirSync(quarantine, { recursive: true, mode: 0o700 })
                for (const entry of listCacheEntries(ctx)) {
                    const from = resolveInDataDir(ctx.dataDir, entry.rel)
                    const to = resolveInDataDir(ctx.dataDir, `${quarantineRel}/${flat(entry.rel)}`)
                    rename(from, to)
                    moves.push({ from, to, bytes: entry.bytes })
                }
                return { ok: true, evidence: { verschoben: moves.length, freiBytes: moves.reduce((sum, move) => sum + move.bytes, 0) }, undo }
            } catch (error) {
                return { ok: false, evidence: { fehler: String((error as Error)?.message || error).slice(0, 300), verschoben: moves.length }, undo }
            }
        },
        async probe(_ctx, _symptom, acted) {
            const moves = acted.undo.moves as Array<{ from: string; to: string }>
            const ok = moves.every(move => !existsSync(move.from) && existsSync(move.to))
            return { ok, evidence: { probe: ok ? 'alle Einträge aus den Cache-Pfaden entfernt' : 'Einträge unvollständig verschoben' } }
        },
        async commit(_ctx, _symptom, acted) {
            rmSync(acted.undo.quarantine, { recursive: true, force: true })
        },
        async rollback(_ctx, _symptom, acted) {
            const { quarantine, moves } = acted.undo || { moves: [] }
            let restored = 0
            for (const move of [...(moves as Array<{ from: string; to: string }>)].reverse()) {
                if (existsSync(move.to) && !existsSync(move.from)) { renameSync(move.to, move.from); restored++ }
            }
            try { if (quarantine && existsSync(quarantine)) rmdirSync(quarantine) } catch { /* not empty: keep */ }
            const ok = (moves as Array<{ from: string }>).every(move => existsSync(move.from))
            return { ok, evidence: { zurueckverschoben: restored } }
        },
    }
}

// ---------------------------------------------------------------------------
// auto 3: Modell-Endpoint tot → zweiter bekannter Endpoint, zurück wenn wieder da
// ---------------------------------------------------------------------------

const origin = (endpoint: string) => { try { return new URL(endpoint).origin } catch { return '?' } }

export function createEndpointRecipe(deps: Pick<RecipeDeps, 'endpoints' | 'retryDelayMs'>): HealRecipe {
    const delay = deps.retryDelayMs ?? 2_000
    const probeTwice = async (controller: EndpointController, endpoint: string) => {
        if (await controller.probe(endpoint)) return true
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        return controller.probe(endpoint)
    }
    const entryFor = (ctx: HealContext, which: 'primary' | 'secondary'): EndpointEntry => ctx.settings.endpoints![which]
    return {
        id: 'endpoint-umschalten',
        level: 'auto',
        title: 'Modell-Endpoint umgeschaltet',
        effects: ['llm:endpoint-umschalten'],
        cooldownMs: 15 * MINUTE,
        maxPerDay: 12,
        async detect(ctx) {
            const controller = deps.endpoints
            if (!controller || !ctx.settings.endpoints) return []
            const active = ctx.state.endpointActive
            // Someone else (owner, /model, scanner) switched: not ours to undo.
            if (controller.currentModel() !== entryFor(ctx, active).model) return []
            const primary = entryFor(ctx, 'primary')
            const secondary = entryFor(ctx, 'secondary')
            if (active === 'primary') {
                if (await probeTwice(controller, primary.endpoint)) return []
                if (!await controller.probe(secondary.endpoint)) return []
                return [{ signature: 'endpoint-tot:primary', evidence: { erster: origin(primary.endpoint), ersterErreichbar: false, versuche: 2, zweiter: origin(secondary.endpoint), zweiterErreichbar: true }, data: { from: 'primary', to: 'secondary' } }]
            }
            if (!await probeTwice(controller, primary.endpoint)) return []
            return [{ signature: 'endpoint-zurueck:primary', evidence: { erster: origin(primary.endpoint), ersterErreichbar: true }, data: { from: 'secondary', to: 'primary' } }]
        },
        async measure(ctx) {
            return { aktiv: ctx.state.endpointActive, modell: deps.endpoints?.currentModel() ?? null }
        },
        async act(ctx, symptom) {
            const target = entryFor(ctx, symptom.data.to)
            const ok = await deps.endpoints!.switchTo(target)
            if (ok) ctx.state.endpointActive = symptom.data.to
            return { ok, evidence: { nach: origin(target.endpoint), modell: target.model }, undo: { from: symptom.data.from } }
        },
        async probe(ctx, symptom) {
            const target = entryFor(ctx, symptom.data.to)
            const ok = deps.endpoints!.currentModel() === target.model && ctx.state.endpointActive === symptom.data.to && await deps.endpoints!.probe(target.endpoint)
            return { ok, evidence: { probe: ok ? 'neuer Endpoint antwortet' : 'neuer Endpoint antwortet nicht' } }
        },
        async rollback(ctx, symptom) {
            const previous = entryFor(ctx, symptom.data.from)
            const ok = await deps.endpoints!.switchTo(previous)
            if (ok) ctx.state.endpointActive = symptom.data.from
            return { ok: ok && deps.endpoints!.currentModel() === previous.model, evidence: { zurueck: origin(previous.endpoint) } }
        },
    }
}

// ---------------------------------------------------------------------------
// Vorschläge: nie selbst ausführen
// ---------------------------------------------------------------------------

const isNasNode = (nodeId: string) => /(^|[-_.])nas($|[-_.\d])/i.test(nodeId)
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const NIGHTWATCH_MAX_AGE_MS = 90 * MINUTE

export function createRestartProposalRecipe(): HealRecipe {
    return {
        id: 'dienst-neustart-vorschlag',
        level: 'vorschlag',
        title: 'Dienst-Neustart vorgeschlagen',
        effects: ['vorschlag:einreihen', 'owner:melden'],
        cooldownMs: 6 * HOUR, // höchstens 1× je 6 h, danach Alfred
        maxPerDay: 4,
        async detect(ctx) {
            const report = ctx.nightwatch
            if (!report || report.error) return []
            const finished = Date.parse(report.finishedAt)
            if (!Number.isFinite(finished) || ctx.now() - finished > NIGHTWATCH_MAX_AGE_MS) return []
            const hanging = report.results.filter(result => {
                if (result.kind !== 'http' || result.status !== 'fehler') return false
                const url = /^GET\s+(\S+)/.exec(result.evidence?.command || '')?.[1]
                try { return Boolean(url && LOOPBACK.has(new URL(url).hostname)) } catch { return false }
            })
            if (!hanging.length) return []
            return [{
                signature: `rest-haengt:${hanging.map(result => result.id).sort().join(',')}`,
                evidence: { nachtwache: report.finishedAt, pruefungen: hanging.map(result => ({ id: result.id, label: result.label, befund: result.message, beleg: result.evidence.command, geprueft: result.evidence.checkedAt })) },
            }]
        },
        proposal(ctx, symptom) {
            const labels = (symptom.evidence.pruefungen as Array<{ label: string }>).map(item => item.label).join(', ')
            if (isNasNode(ctx.nodeId)) {
                return { title: 'Eigener Dienst antwortet nicht (NAS)', message: `${labels} hängt. NAS: Neustart ist nicht erlaubt (nur Rezepte ohne Neustart) — bitte selbst prüfen.` }
            }
            return { title: 'Eigener Dienst antwortet nicht', message: `${labels} hängt laut Nachtwache. Vorschlag: Dienst-Neustart (höchstens 1× je 6 h). Ja-Knopf (CL-10) fehlt noch — ich starte nichts selbst neu, nur Alfred.` }
        },
    }
}

export function createDiskReportRecipe(deps: Pick<RecipeDeps, 'diskUsage'>): HealRecipe {
    return {
        id: 'platte-voll-melden',
        level: 'vorschlag',
        title: 'Platte fast voll',
        effects: ['owner:melden'],
        cooldownMs: 6 * HOUR,
        maxPerDay: 4,
        async detect(ctx) {
            const usage = deps.diskUsage?.(ctx.dataDir) ?? null
            if (!usage || usage.usedPercent < ctx.settings.diskPercent) return []
            const cacheBytes = listCacheEntries(ctx).reduce((sum, entry) => sum + entry.bytes, 0)
            return [{ signature: 'platte-voll', evidence: { plattenProzent: usage.usedPercent, frei: usage.freeBytes, schwelle: ctx.settings.diskPercent, eigeneCachesBytes: cacheBytes } }]
        },
        proposal(_ctx, symptom) {
            return { title: 'Platte fast voll', message: `Platte des Datenverzeichnisses ${symptom.evidence.plattenProzent} % belegt (Grenze ${symptom.evidence.schwelle} %). Eigene Caches: ${symptom.evidence.eigeneCachesBytes} Bytes. Ich lösche sonst nichts — bitte prüfen.` }
        },
    }
}

export function createLeaseReportRecipe(deps: Pick<RecipeDeps, 'leaseFailures' | 'fenceStatus'>): HealRecipe {
    return {
        id: 'lease-verloren-melden',
        level: 'vorschlag',
        title: 'Lease-Koordinator verweigert',
        effects: ['owner:melden'],
        cooldownMs: 6 * HOUR,
        maxPerDay: 4,
        async detect() {
            const failing = (deps.leaseFailures?.() ?? []).filter(item => item.failures >= 3)
            if (!failing.length) return []
            return [{
                signature: `lease:${failing.map(item => `${item.service}:${item.status}`).sort().join(',')}`,
                evidence: { lease: failing.map(item => ({ service: item.service, status: item.status, failures: item.failures })), fencing: deps.fenceStatus?.() ?? null },
            }]
        },
        proposal(_ctx, symptom) {
            const text = (symptom.evidence.lease as Array<{ service: string; status: number; failures: number }>).map(item => `${item.service} → HTTP ${item.status} (${item.failures}×)`).join(', ')
            return { title: 'Lease verloren/verweigert', message: `Lease-Koordinator: ${text}. Nur Meldung + Diagnosedaten, keine DB-Änderung.` }
        },
    }
}

/** The whole catalog, in run order: heal first, then report what is left. */
export function createDefaultRecipes(deps: RecipeDeps): HealRecipe[] {
    return [
        createLogRotationRecipe(deps),
        createCacheRecipe(deps),
        createEndpointRecipe(deps),
        createDiskReportRecipe(deps),
        createRestartProposalRecipe(),
        createLeaseReportRecipe(deps),
    ]
}
