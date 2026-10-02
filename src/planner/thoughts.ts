/**
 * Gedanken-Speicher (Phase 1, Autonomie-Plan D): every event, idea or
 * proposal becomes a thought with source, evidence, importance (fixed rules,
 * never the model), proposal, permission and status. All thoughts stay in the
 * list, also the discarded ones, so one can see that she thinks.
 *
 * File format (read by `/gedanken`, see docs/AUTONOMY_GUIDE.md):
 *   <data>/thoughts/thoughts.json      { version: 1, items: Thought[] }  (atomic write, max 500)
 *   <data>/thoughts/notify-state.json  { day: 'YYYY-MM-DD' (local), sent: number }
 *
 * Notices: only `dringend` and `wichtig` thoughts are announced. The same
 * signature is announced once per dedupe window; quiet hours (default 22-7,
 * local) let only `dringend` through; a daily cap holds the rest back for the
 * next briefing. Only the Main delivers (planner tick); adding a thought never
 * sends anything by itself.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { cleanText, deliverVia, type DeliveryPort, type DeliveryReceipt, type PlannerOutgoing } from './delivery-port.js'
import { DEFAULT_TIME_ZONE, zonedDay, zonedHour } from './time.js'

export type ThoughtImportance = 'dringend' | 'wichtig' | 'normal' | 'niedrig'
export type ThoughtPermission = 'selbst' | 'fragen' | 'nie'
export type ThoughtStatus = 'offen' | 'erledigt' | 'verworfen' | 'wartet-auf-knopf'
export type ThoughtKind = 'ereignis' | 'idee' | 'vorschlag'
export type ThoughtNotice = 'keine' | 'ausstehend' | 'gemeldet' | 'zurueckgehalten' | 'im-bericht'
export type ThoughtSeverity = 'critical' | 'warning' | 'info'

export interface Thought {
    id: string
    createdAt: string
    updatedAt: string
    lastSeenAt: string
    source: string
    kind: ThoughtKind
    title: string
    evidence: string
    importance: ThoughtImportance
    /** The fixed rule that set the importance, e.g. `regel:kritisch`. */
    rule: string
    proposal?: string
    permission: ThoughtPermission
    status: ThoughtStatus
    statusAt?: string
    statusBy?: string
    signature: string
    /** How often the same signature was seen while this thought was current. */
    seen: number
    notice: ThoughtNotice
    noticeReason?: string
    noticedAt?: string
    node?: string
}

export interface NewThought {
    source: string
    title: string
    kind?: ThoughtKind
    evidence?: string
    severity?: ThoughtSeverity
    proposal?: string
    permission?: ThoughtPermission
    /** Dedupe key; default source + normalized title (digits ignored). */
    signature?: string
    node?: string
    /**
     * Owner-feedback weight 0…1 of this thought kind (decisions.ts,
     * thoughtImportanceFactor). Only thinking producers pass it; below 1 a
     * question or idea is not announced. Alarms never carry a weight.
     */
    weight?: number
}

export interface ThoughtSettings {
    quietStart: number
    quietEnd: number
    timeZone: string
    dedupeMinutes: number
    maxPerDay: number
}

export const DEFAULT_THOUGHT_SETTINGS: ThoughtSettings = Object.freeze({
    quietStart: 22, quietEnd: 7, timeZone: DEFAULT_TIME_ZONE, dedupeMinutes: 360, maxPerDay: 10,
})

export const THOUGHT_ID_PATTERN = /^th-[a-f0-9]{12}$/
const SOURCE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const STATUSES: readonly ThoughtStatus[] = ['offen', 'erledigt', 'verworfen', 'wartet-auf-knopf']
const PERMISSIONS: readonly ThoughtPermission[] = ['selbst', 'fragen', 'nie']
const KINDS: readonly ThoughtKind[] = ['ereignis', 'idee', 'vorschlag']
const SEVERITIES: readonly ThoughtSeverity[] = ['critical', 'warning', 'info']
const NOTICES: readonly ThoughtNotice[] = ['keine', 'ausstehend', 'gemeldet', 'zurueckgehalten', 'im-bericht']
const OPEN: ReadonlySet<ThoughtStatus> = new Set(['offen', 'wartet-auf-knopf'])
const RANK: Record<ThoughtImportance, number> = { niedrig: 0, normal: 1, wichtig: 2, dringend: 3 }
const MAX_ITEMS = 500

export function isOpenThought(thought: Pick<Thought, 'status'>): boolean {
    return OPEN.has(thought.status)
}

/**
 * Fixed rules. The model may phrase a proposal, it never sets importance.
 * A question is not automatically „wichtig“ (2.83.0): when the owner already
 * said Nein to this kind (weight < 1), an idea or proposal drops to `niedrig`
 * — report only, no notice, no card. Critical stays urgent; events (alarms,
 * watch) are never dampened.
 */
export function rateImportance(input: { severity?: ThoughtSeverity; kind: ThoughtKind; permission: ThoughtPermission; weight?: number }): { importance: ThoughtImportance; rule: string } {
    if (input.severity === 'critical') return { importance: 'dringend', rule: 'regel:kritisch' }
    if (input.kind !== 'ereignis' && typeof input.weight === 'number' && Number.isFinite(input.weight) && input.weight < 1) return { importance: 'niedrig', rule: 'regel:owner-nein-gedaempft' }
    if (input.severity === 'warning') return { importance: 'wichtig', rule: 'regel:warnung' }
    if (input.kind === 'vorschlag' && input.permission === 'fragen') return { importance: 'wichtig', rule: 'regel:braucht-freigabe' }
    if (input.kind === 'idee') return { importance: 'niedrig', rule: 'regel:idee-nur-bericht' }
    return { importance: 'normal', rule: 'regel:info-nur-bericht' }
}

const notifiable = (importance: ThoughtImportance) => importance === 'dringend' || importance === 'wichtig'

export function isQuietHour(now: number, settings: Pick<ThoughtSettings, 'quietStart' | 'quietEnd' | 'timeZone'>): boolean {
    const { quietStart: start, quietEnd: end } = settings
    if (start < 0 || end < 0 || start === end) return false
    const hour = zonedHour(now, settings.timeZone)
    return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

export function normalizeThoughtSettings(raw: Partial<ThoughtSettings> | undefined): ThoughtSettings {
    const r = raw || {}
    const hour = (value: unknown, fallback: number) => Number.isInteger(value) && (value as number) >= -1 && (value as number) <= 23 ? value as number : fallback
    const positive = (value: unknown, fallback: number, max: number) => Number.isFinite(value) && (value as number) > 0 ? Math.min(max, Math.floor(value as number)) : fallback
    return {
        quietStart: hour(r.quietStart, DEFAULT_THOUGHT_SETTINGS.quietStart),
        quietEnd: hour(r.quietEnd, DEFAULT_THOUGHT_SETTINGS.quietEnd),
        timeZone: typeof r.timeZone === 'string' && r.timeZone ? r.timeZone : DEFAULT_THOUGHT_SETTINGS.timeZone,
        dedupeMinutes: positive(r.dedupeMinutes, DEFAULT_THOUGHT_SETTINGS.dedupeMinutes, 7 * 24 * 60),
        maxPerDay: positive(r.maxPerDay, DEFAULT_THOUGHT_SETTINGS.maxPerDay, 200),
    }
}

export interface ThoughtListFilter { status?: ThoughtStatus | ThoughtStatus[]; source?: string; limit?: number }

export interface ThoughtStore {
    readonly settings: ThoughtSettings
    /** The store's clock (tests inject a fake one). */
    now(): number
    readonly paths: { file: string; notifyState: string }
    add(input: NewThought): { thought: Thought; deduped: boolean }
    list(filter?: ThoughtListFilter): Thought[]
    get(id: string): Thought | null
    setStatus(id: string, status: ThoughtStatus, by: string): Thought | null
    markNotice(id: string, notice: ThoughtNotice, reason?: string): Thought | null
    pendingNotices(): Thought[]
    budget(): { day: string; sent: number }
    countSent(): void
}

export function createThoughtStore(options: { dataDir: string; now?: () => number; settings?: Partial<ThoughtSettings> }): ThoughtStore {
    const now = options.now ?? Date.now
    const settings = normalizeThoughtSettings(options.settings)
    const dir = join(options.dataDir, 'thoughts')
    const paths = { file: join(dir, 'thoughts.json'), notifyState: join(dir, 'notify-state.json') }
    const iso = () => new Date(now()).toISOString()

    const load = (): Thought[] => {
        try {
            const raw = JSON.parse(readFileSync(paths.file, 'utf8'))
            return Array.isArray(raw?.items) ? raw.items.filter((item: Thought) => item && THOUGHT_ID_PATTERN.test(item.id)) : []
        } catch { return [] }
    }
    const save = (items: Thought[]) => {
        let kept = items
        if (kept.length > MAX_ITEMS) {
            const closed = kept.filter(item => !OPEN.has(item.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            const drop = new Set(closed.slice(0, kept.length - MAX_ITEMS).map(item => item.id))
            kept = kept.filter(item => !drop.has(item.id)).slice(-MAX_ITEMS)
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        atomicWriteJsonSync(paths.file, { version: 1, items: kept })
    }
    // Synchronous read-modify-write: no await in between, so concurrent callers
    // in this process never clobber each other.
    const mutate = <T>(fn: (items: Thought[]) => T): T => {
        const items = load()
        const result = fn(items)
        save(items)
        return result
    }

    const store: ThoughtStore = {
        settings,
        now,
        paths,
        add(input) {
            const source = String(input?.source || '')
            if (!SOURCE_PATTERN.test(source)) throw new Error(`Ungültige Gedanken-Quelle: ${source.slice(0, 40)}`)
            const title = cleanText(input.title, 160).trim()
            if (!title) throw new Error('Gedanke braucht einen Titel')
            const kind: ThoughtKind = KINDS.includes(input.kind as ThoughtKind) ? input.kind as ThoughtKind : 'ereignis'
            const permission: ThoughtPermission = PERMISSIONS.includes(input.permission as ThoughtPermission)
                ? input.permission as ThoughtPermission
                : kind === 'vorschlag' ? 'fragen' : 'selbst'
            const severity = SEVERITIES.includes(input.severity as ThoughtSeverity) ? input.severity : undefined
            const weight = typeof input.weight === 'number' && Number.isFinite(input.weight) ? Math.max(0, Math.min(1, input.weight)) : undefined
            const { importance, rule } = rateImportance({ severity, kind, permission, weight })
            const evidence = cleanText(input.evidence ?? '', 600)
            const proposal = input.proposal ? cleanText(input.proposal, 300) : undefined
            const signatureBase = input.signature ? String(input.signature) : `${source}|${title.toLowerCase().replace(/\d+/g, '#')}`
            const signature = createHash('sha256').update(signatureBase).digest('hex').slice(0, 16)
            const t = now()
            const windowMs = settings.dedupeMinutes * 60_000
            return mutate(items => {
                const existing = items.find(item => item.signature === signature
                    && (OPEN.has(item.status) || t - Date.parse(item.lastSeenAt) < windowMs))
                if (existing) {
                    const escalated = RANK[importance] > RANK[existing.importance]
                    existing.seen = (existing.seen || 1) + 1
                    existing.lastSeenAt = iso()
                    existing.updatedAt = iso()
                    if (evidence) existing.evidence = evidence
                    if (escalated) { existing.importance = importance; existing.rule = rule }
                    const windowOver = !existing.noticedAt || t - Date.parse(existing.noticedAt) >= windowMs
                    if (OPEN.has(existing.status) && notifiable(existing.importance) && existing.notice !== 'ausstehend' && (escalated || windowOver)) {
                        existing.notice = 'ausstehend'
                        existing.noticeReason = escalated ? 'hochgestuft' : 'erneut'
                    }
                    return { thought: { ...existing }, deduped: true }
                }
                const thought: Thought = {
                    id: `th-${randomBytes(6).toString('hex')}`,
                    createdAt: iso(), updatedAt: iso(), lastSeenAt: iso(),
                    source, kind, title, evidence, importance, rule,
                    ...(proposal ? { proposal } : {}),
                    permission, status: 'offen', signature, seen: 1,
                    notice: notifiable(importance) ? 'ausstehend' : 'keine',
                    ...(input.node ? { node: cleanText(input.node, 64) } : {}),
                }
                items.push(thought)
                return { thought: { ...thought }, deduped: false }
            })
        },
        list(filter = {}) {
            const statuses = filter.status ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status]) : null
            const limit = Math.max(1, Math.min(500, filter.limit ?? 50))
            return load()
                .filter(item => (!statuses || statuses.has(item.status)) && (!filter.source || item.source === filter.source))
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, limit)
        },
        get(id) {
            if (!THOUGHT_ID_PATTERN.test(String(id))) return null
            return load().find(item => item.id === id) ?? null
        },
        setStatus(id, status, by) {
            if (!THOUGHT_ID_PATTERN.test(String(id)) || !STATUSES.includes(status)) return null
            return mutate(items => {
                const item = items.find(entry => entry.id === id)
                if (!item) return null
                item.status = status
                item.statusAt = iso()
                item.statusBy = cleanText(by, 64)
                item.updatedAt = iso()
                if (!OPEN.has(status) && item.notice === 'ausstehend') item.notice = 'keine'
                return { ...item }
            })
        },
        markNotice(id, notice, reason) {
            if (!THOUGHT_ID_PATTERN.test(String(id)) || !NOTICES.includes(notice)) return null
            return mutate(items => {
                const item = items.find(entry => entry.id === id)
                if (!item) return null
                item.notice = notice
                if (reason) item.noticeReason = cleanText(reason, 64)
                if (notice === 'gemeldet') item.noticedAt = iso()
                item.updatedAt = iso()
                return { ...item }
            })
        },
        pendingNotices() {
            return load()
                .filter(item => item.notice === 'ausstehend' && OPEN.has(item.status))
                .sort((a, b) => RANK[b.importance] - RANK[a.importance] || a.createdAt.localeCompare(b.createdAt))
        },
        budget() {
            const day = zonedDay(now(), settings.timeZone)
            try {
                const raw = JSON.parse(readFileSync(paths.notifyState, 'utf8'))
                if (raw?.day === day && Number.isFinite(raw.sent)) return { day, sent: raw.sent }
            } catch { /* fresh day */ }
            return { day, sent: 0 }
        },
        countSent() {
            const current = store.budget()
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            atomicWriteJsonSync(paths.notifyState, { day: current.day, sent: current.sent + 1 })
        },
    }
    return store
}

export function formatThoughtText(thought: Thought): string {
    const mark = thought.importance === 'dringend' ? '‼️' : '⚠️'
    const lines = [`${mark} ${thought.title}`]
    if (thought.evidence) lines.push(`Beleg: ${thought.evidence}`)
    if (thought.proposal) lines.push(`Vorschlag: ${thought.proposal}`)
    if (thought.seen > 1) lines.push(`(${thought.seen}× gesehen)`)
    return lines.join('\n')
}

export interface ThoughtDeliveryLogEntry {
    at: string
    deliveryId: string
    thoughtId: string
    kind: 'gedanke'
    port: string
    status: DeliveryReceipt['status'] | 'ruhezeit' | 'tageslimit'
    detail?: string
}

/**
 * Announce pending thoughts through the port. Called by the planner tick on
 * the Main only. `briefingEnabled`: held-back thoughts go into the next
 * briefing; otherwise a thought held by quiet hours waits until they end.
 */
export async function deliverPendingThoughts(
    store: ThoughtStore,
    port: DeliveryPort | null,
    options: { now?: number; briefingEnabled: boolean; log?: (entry: ThoughtDeliveryLogEntry) => void },
): Promise<{ sent: number; held: number; limited: number; failed: number }> {
    const result = { sent: 0, held: 0, limited: 0, failed: 0 }
    const t = options.now ?? store.now()
    const at = new Date(t).toISOString()
    const portName = port?.name ?? 'keiner'
    const quiet = isQuietHour(t, store.settings)
    for (const thought of store.pendingNotices()) {
        if (thought.importance !== 'dringend') {
            if (quiet) {
                result.held++
                if (options.briefingEnabled) store.markNotice(thought.id, 'zurueckgehalten', 'ruhezeit')
                else if (thought.noticeReason !== 'ruhezeit') store.markNotice(thought.id, 'ausstehend', 'ruhezeit')
                continue
            }
            if (store.budget().sent >= store.settings.maxPerDay) {
                result.limited++
                store.markNotice(thought.id, 'zurueckgehalten', 'tageslimit')
                options.log?.({ at, deliveryId: '', thoughtId: thought.id, kind: 'gedanke', port: portName, status: 'tageslimit' })
                continue
            }
        }
        const outgoing: PlannerOutgoing = {
            id: `out-${randomBytes(6).toString('hex')}`,
            kind: 'gedanke',
            title: thought.title,
            text: formatThoughtText(thought),
            urgency: thought.importance === 'dringend' ? 'dringend' : 'normal',
            createdAt: at,
            thoughtId: thought.id,
            permission: thought.permission,
        }
        const receipt = await deliverVia(port, outgoing)
        options.log?.({ at, deliveryId: outgoing.id, thoughtId: thought.id, kind: 'gedanke', port: portName, status: receipt.status, detail: receipt.detail })
        if (receipt.status === 'zugestellt') {
            store.markNotice(thought.id, 'gemeldet')
            store.countSent()
            result.sent++
        } else {
            result.failed++
        }
    }
    return result
}
