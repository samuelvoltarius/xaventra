/**
 * Ereignis-Bus (Autonomie-Plan Phase 2, „Wahrnehmen“).
 *
 * - Adapter sind nur lesend; jeder hat eigenen Takt, eigenes Zeitlimit und
 *   eigene Fehlerzählung mit Backoff. Ein werfender oder hängender Adapter
 *   bringt weder den Bus noch andere Adapter zum Stehen.
 * - Ereignisse werden entprellt (dedupeKey + Fenster), dann nach festen Regeln
 *   zu Gedanken bewertet (kein Modell entscheidet über Wichtigkeit/Erlaubnis).
 * - Ausgabe NUR über EventSink/ThoughtSink (siehe ./ports.ts). Der Bus kennt
 *   keinen Kanal und sendet nie selbst an den Owner.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import {
    EVENT_SCHEMA, THOUGHT_SCHEMA, cleanEvidence, cleanText, newId, sensingLog,
    type EventSink, type Importance, type PermissionLevel, type SensingEvent, type SensingSeverity,
    type SensingSource, type SensingThought, type ThoughtSink,
} from './ports.js'
import { DEFAULT_NOTIFY_POLICY, decideDelivery, type NotifyCounter, type SensingNotifyPolicy } from './notify-policy.js'

export interface AdapterContext {
    signal: AbortSignal
    now: number
    /** Adapter-private JSON state, persisted by the bus after every successful poll. */
    state: Record<string, unknown>
}

/** What an adapter returns; the bus fills id/at/schema. */
export type RawEvent = Omit<SensingEvent, 'schema' | 'id' | 'at' | 'source'> & { source?: SensingSource }

export interface SensingAdapter {
    id: string
    source: SensingSource
    intervalMs: number
    timeoutMs: number
    poll(ctx: AdapterContext): Promise<RawEvent[]>
}

export interface AdapterStatus {
    id: string
    runs: number
    errors: number
    consecutiveErrors: number
    lastRunAt?: string
    lastError?: string
    lastEvents: number
    running: boolean
}

export interface SensingBusOptions {
    dataDir: string
    eventSink: EventSink
    thoughtSink: ThoughtSink
    nodeId?: string
    role?: 'main' | 'worker'
    notify?: Partial<SensingNotifyPolicy>
    now?: () => number
    defaultDedupeWindowMs?: number
}

interface BusState {
    version: 1
    dedupe: Record<string, number>
    counter: NotifyCounter
    adapters: Record<string, Record<string, unknown>>
}

const MAX_DEDUPE_KEYS = 2000
const MAX_EVENTS_PER_POLL = 50
const MAX_BACKOFF = 8

const SEVERITY_IMPORTANCE: Record<SensingSeverity, Importance> = { info: 'normal', warning: 'hoch', urgent: 'dringend' }

export class AdapterTimeoutError extends Error {
    constructor(id: string, ms: number) { super(`Adapter ${id}: Zeitlimit ${ms} ms überschritten`) }
}

export class SensingBus {
    private readonly adapters = new Map<string, SensingAdapter>()
    private readonly status = new Map<string, AdapterStatus>()
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly statePath: string
    private readonly policy: SensingNotifyPolicy
    private readonly now: () => number
    private state: BusState
    private started = false

    constructor(private readonly options: SensingBusOptions) {
        this.statePath = join(options.dataDir, 'sensing', 'bus-state.json')
        this.policy = { ...DEFAULT_NOTIFY_POLICY, ...(options.notify || {}) }
        this.now = options.now || Date.now
        this.state = this.loadState()
    }

    register(adapter: SensingAdapter): void {
        if (this.adapters.has(adapter.id)) throw new Error(`Adapter doppelt: ${adapter.id}`)
        this.adapters.set(adapter.id, adapter)
        this.status.set(adapter.id, { id: adapter.id, runs: 0, errors: 0, consecutiveErrors: 0, lastEvents: 0, running: false })
        if (this.started) this.schedule(adapter.id, 0)
    }

    getStatus(): AdapterStatus[] {
        return [...this.status.values()].map(item => ({ ...item }))
    }

    start(): void {
        if (this.started) return
        this.started = true
        let offset = 0
        for (const id of this.adapters.keys()) this.schedule(id, 1000 + (offset++ * 750))
    }

    stop(): void {
        this.started = false
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
    }

    private schedule(id: string, delayMs: number): void {
        if (!this.started) return
        const previous = this.timers.get(id)
        if (previous) clearTimeout(previous)
        const timer = setTimeout(() => {
            void this.runAdapter(id).finally(() => {
                const adapter = this.adapters.get(id)
                const status = this.status.get(id)
                if (!adapter || !status) return
                const factor = Math.min(MAX_BACKOFF, 2 ** Math.min(status.consecutiveErrors, 3))
                this.schedule(id, adapter.intervalMs * (status.consecutiveErrors ? factor : 1))
            })
        }, Math.max(0, delayMs))
        timer.unref?.()
        this.timers.set(id, timer)
    }

    /** Runs one poll of one adapter. Never throws. Returns the delivered events. */
    async runAdapter(id: string): Promise<SensingEvent[]> {
        const adapter = this.adapters.get(id)
        const status = this.status.get(id)
        if (!adapter || !status || status.running) return []
        status.running = true
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const adapterState = { ...(this.state.adapters[id] || {}) }
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort()
                    reject(new AdapterTimeoutError(id, adapter.timeoutMs))
                }, adapter.timeoutMs)
                timer.unref?.()
            })
            const raw = await Promise.race([
                Promise.resolve().then(() => adapter.poll({ signal: controller.signal, now: this.now(), state: adapterState })),
                timeout,
            ])
            status.runs++
            status.consecutiveErrors = 0
            status.lastError = undefined
            status.lastRunAt = new Date(this.now()).toISOString()
            this.state.adapters[id] = adapterState
            const delivered = await this.ingest(adapter.source, Array.isArray(raw) ? raw.slice(0, MAX_EVENTS_PER_POLL) : [])
            status.lastEvents = delivered.length
            this.saveState()
            return delivered
        } catch (error) {
            status.runs++
            status.errors++
            status.consecutiveErrors++
            status.lastRunAt = new Date(this.now()).toISOString()
            status.lastError = cleanText(error instanceof Error ? error.message : error, 160)
            sensingLog(`Adapter ${id} Fehler (${status.consecutiveErrors}× in Folge): ${status.lastError}`)
            return []
        } finally {
            if (timer) clearTimeout(timer)
            status.running = false
        }
    }

    /** Runs every adapter once, isolated from each other (used by tests and /geraete). */
    async runAllOnce(): Promise<SensingEvent[]> {
        const results = await Promise.all([...this.adapters.keys()].map(id => this.runAdapter(id)))
        return results.flat()
    }

    /** Entry for producers that are not polled (discovery, accounts, quiet hours). */
    async publish(source: SensingSource, events: RawEvent[]): Promise<SensingEvent[]> {
        const delivered = await this.ingest(source, events.slice(0, MAX_EVENTS_PER_POLL))
        this.saveState()
        return delivered
    }

    private async ingest(source: SensingSource, raw: RawEvent[]): Promise<SensingEvent[]> {
        const now = this.now()
        this.pruneDedupe(now)
        const delivered: SensingEvent[] = []
        for (const item of raw) {
            if (!item || typeof item.kind !== 'string' || typeof item.dedupeKey !== 'string') continue
            const window = item.dedupeWindowMs ?? this.options.defaultDedupeWindowMs ?? 6 * 60 * 60_000
            const key = cleanText(item.dedupeKey, 200)
            const last = this.state.dedupe[key]
            if (last !== undefined && now - last < window) continue
            this.state.dedupe[key] = now
            const event: SensingEvent = {
                schema: EVENT_SCHEMA,
                id: newId('ev'),
                at: new Date(now).toISOString(),
                source: item.source || source,
                kind: cleanText(item.kind, 60),
                subject: cleanText(item.subject, 120),
                summary: cleanText(item.summary),
                severity: (['info', 'warning', 'urgent'] as const).includes(item.severity) ? item.severity : 'info',
                dedupeKey: key,
                evidence: cleanEvidence(item.evidence),
                hint: item.hint,
            }
            await this.safeSink('event', () => this.options.eventSink.writeEvent(event))
            await this.safeSink('thought', () => this.options.thoughtSink.writeThought(this.toThought(event, now)))
            delivered.push(event)
        }
        return delivered
    }

    private toThought(event: SensingEvent, now: number): SensingThought {
        const importance: Importance = event.hint?.importance || SEVERITY_IMPORTANCE[event.severity]
        // An action always needs a button, whatever the adapter hinted.
        const level: PermissionLevel = event.hint?.action ? 'fragen' : (event.hint?.level || 'selbst')
        const decided = decideDelivery(importance, this.policy, this.state.counter, now)
        this.state.counter = decided.counter
        return {
            schema: THOUGHT_SCHEMA,
            id: newId('th'),
            at: new Date(now).toISOString(),
            source: event.source,
            eventId: event.id,
            title: cleanText(event.hint?.title || event.summary, 120),
            summary: event.summary,
            evidence: event.evidence,
            importance,
            proposal: event.hint?.proposal ? cleanText(event.hint.proposal, 200) : undefined,
            level,
            status: 'neu',
            action: event.hint?.action,
            delivery: decided.delivery,
            origin: { nodeId: this.options.nodeId || 'local', role: this.options.role || 'main' },
            dedupeKey: event.dedupeKey,
        }
    }

    private async safeSink(kind: string, write: () => void | Promise<void>): Promise<void> {
        try { await write() } catch (error) {
            sensingLog(`${kind}-Sink Fehler: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private pruneDedupe(now: number): void {
        const entries = Object.entries(this.state.dedupe)
        const fresh = entries.filter(([, at]) => now - at < 7 * 24 * 60 * 60_000)
        fresh.sort((a, b) => b[1] - a[1])
        this.state.dedupe = Object.fromEntries(fresh.slice(0, MAX_DEDUPE_KEYS))
    }

    private loadState(): BusState {
        const empty: BusState = { version: 1, dedupe: {}, counter: { day: '', count: 0 }, adapters: {} }
        try {
            if (!existsSync(this.statePath)) return empty
            const raw = JSON.parse(readFileSync(this.statePath, 'utf8'))
            if (raw?.version !== 1) return empty
            return {
                version: 1,
                dedupe: raw.dedupe && typeof raw.dedupe === 'object' ? raw.dedupe : {},
                counter: raw.counter && typeof raw.counter.day === 'string' ? { day: raw.counter.day, count: Number(raw.counter.count) || 0 } : empty.counter,
                adapters: raw.adapters && typeof raw.adapters === 'object' ? raw.adapters : {},
            }
        } catch { return empty }
    }

    private saveState(): void {
        try {
            mkdirSync(join(this.options.dataDir, 'sensing'), { recursive: true, mode: 0o700 })
            atomicWriteJsonSync(this.statePath, this.state)
        } catch (error) {
            sensingLog(`Bus-Zustand nicht gespeichert: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
}
