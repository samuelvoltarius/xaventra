import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'

export interface OperationalEvent {
    id: string; source: string; summary: string; severity: 'info' | 'warning' | 'error' | 'critical'
    confidence: number; evidenceRefs: string[]; affectedSystems: string[]; recommendedAction?: string
    observedAt: string; expiresAt: string; dedupeKey: string; actionable: boolean; reason: string
}
interface EventFile { version: 1; updatedAt: string; events: OperationalEvent[] }
const TRUSTED_PRODUCER = /^(?:health-monitor|node-health|codex-continuity|mesh|release|self-doctor|outcome-ledger|user-reminder|heartbeat|tool-health)/

export class OperationalEventBus {
    private events: OperationalEvent[] = []
    constructor(private readonly path = getNovaDataDir('operational-events.json')) {
        try { if (existsSync(path)) this.events = (JSON.parse(readFileSync(path, 'utf8')) as EventFile).events || [] } catch { this.events = [] }
    }
    ingest(input: {
        source: string; summary: string; severity: OperationalEvent['severity']; confidence: number
        evidenceRefs?: string[]; affectedSystems?: string[]; recommendedAction?: string; dedupeKey?: string; ttlMs?: number
    }): OperationalEvent {
        const observedAt = new Date().toISOString()
        const dedupeKey = input.dedupeKey || `${input.source}:${input.summary}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 200)
        const evidenceRefs = [...new Set((input.evidenceRefs || []).filter(ref => /^(?:outcome|tool|health|mesh|trace|doctor|user):/.test(ref)))].slice(0, 20)
        const trusted = TRUSTED_PRODUCER.test(input.source)
        const actionable = (trusted || evidenceRefs.length > 0) && input.confidence >= 0.6
        const event: OperationalEvent = {
            id: createHash('sha256').update(`${dedupeKey}\0${observedAt.slice(0, 16)}`).digest('hex').slice(0, 24),
            source: input.source, summary: input.summary.slice(0, 500), severity: input.severity,
            confidence: Math.max(0, Math.min(1, input.confidence)), evidenceRefs,
            affectedSystems: [...new Set(input.affectedSystems || [])].slice(0, 10), recommendedAction: input.recommendedAction,
            observedAt, expiresAt: new Date(Date.now() + Math.max(30_000, input.ttlMs || 15 * 60_000)).toISOString(),
            dedupeKey, actionable, reason: actionable ? 'verified event producer or explicit evidence' : 'no trusted producer or explicit evidence',
        }
        this.events.push(event); this.events = this.events.slice(-2_000)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: observedAt, events: this.events } satisfies EventFile)
        return structuredClone(event)
    }
    list(limit = 100): OperationalEvent[] { return this.events.slice(-limit).map(item => structuredClone(item)) }
}
let singleton: OperationalEventBus | null = null
export function getOperationalEventBus(): OperationalEventBus { return singleton ||= new OperationalEventBus() }
export function setOperationalEventBus(value: OperationalEventBus): void { singleton = value }
