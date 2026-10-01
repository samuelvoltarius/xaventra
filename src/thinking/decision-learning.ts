/**
 * Phase 3 — Lernen aus Knopf-Antworten (Autonomie-Plan G).
 *
 * API: `recordDecision(kind, answer)`. Jede Antwort landet im Outcome-Ledger
 * (`recordApproval`, Lauf-ID `decision-<art>`).
 * - Nach 5× „Ja" in Folge für dieselbe Art (Untergrenze fest, per Config nur
 *   anhebbar) ein Gedanke „Immer erlauben?" (Stufe `fragen`) — einmal pro
 *   Serie. Nie für physische/nach außen wirkende Arten (drucken, schalten,
 *   senden, kaufen; Alfreds Regel 23.09.) und nie für die Nie-Liste.
 * - „Nein" beendet die Serie und senkt die künftige Wichtigkeit dieser Art
 *   (`importanceFactor`, mindestens 0,2). „Ja" hebt sie langsam wieder.
 * Dieses Modul erlaubt nichts selbst: das „Immer erlauben" setzt erst der
 * Knopf der Karten (Phase 1).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { isNieAktionsart, isPhysischOderExtern, nieEffekt } from '../core/action-policy.js'
import { newThoughtId, type Thought, type ThoughtSink, type ThinkingSettings } from './ports.js'

export type DecisionAnswer = 'ja' | 'nein' | 'spaeter'

/** Physisch/nach außen und Nie-Liste: Phase 6b bezieht beide Listen aus der
 * einheitlichen Aktions-Policy (Union der früheren Listen, nur strenger). */

export function normalizeKind(kind: string): string {
    return String(kind || '').toLowerCase().normalize('NFC').trim().replace(/\s+/g, '-').slice(0, 80)
}
export function isPhysicalOrExternalKind(kind: string): boolean {
    return isPhysischOderExtern(normalizeKind(kind))
}
export function isNeverKind(kind: string): boolean {
    const value = normalizeKind(kind)
    return nieEffekt(value) !== null || isNieAktionsart(value)
}

interface KindStats { yesStreak: number; yes: number; no: number; later: number; penalty: number; proposedForStreak: boolean; lastAt: string }
interface DecisionFile { version: 1; kinds: Record<string, KindStats> }

export interface DecisionLedgerPort { recordApproval(runId: string, approval: Record<string, unknown>): void }

export class DecisionLearner {
    private readonly path: string
    private data: DecisionFile = { version: 1, kinds: {} }
    constructor(private readonly deps: { settings: ThinkingSettings; sink: ThoughtSink; path?: string; ledger?: DecisionLedgerPort; now?: () => Date }) {
        this.path = deps.path || getNovaDataDir('thinking', 'decisions.json')
        try { if (existsSync(this.path)) this.data = { version: 1, kinds: JSON.parse(readFileSync(this.path, 'utf8')).kinds || {} } } catch { /* frisch */ }
    }

    /** Wichtigkeits-Faktor 0,2…1 für künftige Gedanken dieser Art. */
    importanceFactor(kind: string): number {
        const stats = this.data.kinds[normalizeKind(kind)]
        return stats ? Math.max(0.2, 0.75 ** stats.penalty) : 1
    }

    async recordDecision(kind: string, answer: DecisionAnswer, options: { reason?: string } = {}): Promise<{ recorded: boolean; proposed?: Thought }> {
        const cfg = this.deps.settings.learning
        if (!this.deps.settings.enabled || !cfg.enabled) return { recorded: false }
        if (!['ja', 'nein', 'spaeter'].includes(answer)) return { recorded: false }
        const key = normalizeKind(kind)
        if (!key) return { recorded: false }
        const now = (this.deps.now || (() => new Date()))()
        const stats = this.data.kinds[key] || { yesStreak: 0, yes: 0, no: 0, later: 0, penalty: 0, proposedForStreak: false, lastAt: now.toISOString() }
        if (answer === 'ja') { stats.yes++; stats.yesStreak++; stats.penalty = Math.max(0, stats.penalty - 0.25) }
        else if (answer === 'nein') { stats.no++; stats.yesStreak = 0; stats.proposedForStreak = false; stats.penalty = Math.min(20, stats.penalty + 1) }
        else stats.later++
        stats.lastAt = now.toISOString()
        this.data.kinds[key] = stats
        this.save()
        try {
            this.deps.ledger?.recordApproval(`decision-${key.replace(/[^a-z0-9_@-]+/g, '-').replace(/^-+/, '').slice(0, 80) || 'art'}`, {
                kind: key, answer, source: 'knopf', ...(options.reason ? { reason: String(options.reason).slice(0, 200) } : {}),
            })
        } catch { /* Ledger optional */ }

        const threshold = Math.max(5, cfg.alwaysAllowAfter)
        if (answer !== 'ja' || stats.yesStreak < threshold || stats.proposedForStreak) return { recorded: true }
        if (isPhysicalOrExternalKind(key) || isNeverKind(key)) return { recorded: true }
        stats.proposedForStreak = true
        this.save()
        const thought: Thought = {
            id: newThoughtId('lernen', now), createdAt: now.toISOString(), source: 'lernen', kind: `immer-erlauben:${key}`,
            title: `Immer erlauben? (${key})`,
            text: `Du hast ${stats.yesStreak}× in Folge „Ja" zu „${key}" gesagt. Soll ich das künftig ohne Rückfrage tun? Sichtbar bleibt es trotzdem.`,
            evidence: [
                { metric: 'ja-in-folge', value: stats.yesStreak, source: 'Knopf-Antworten' },
                { metric: 'nein-gesamt', value: stats.no, source: 'Knopf-Antworten' },
            ],
            importance: 0.4, proposal: { action: 'immer-erlauben', params: { art: key }, autoExecute: false },
            stufe: 'fragen', status: 'neu', dedupeKey: `immer-erlauben:${key}`,
        }
        await this.deps.sink.emit(thought)
        return { recorded: true, proposed: thought }
    }

    private save(): void {
        try { mkdirSync(dirname(this.path), { recursive: true }); atomicWriteJsonSync(this.path, this.data) } catch { /* nächstes Mal */ }
    }
}
