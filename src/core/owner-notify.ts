/**
 * Ein Meldeweg an den Owner (2.82.0 Aufräumen).
 *
 * Vorher gab es zwei unabhängige Wege mit je eigener Entdopplung und Ruhezeit:
 *   A  sendGovernedProactive → OperationalEventBus → ProactiveMessenger (30 min je Schlüssel, 23–7)
 *   B  addThought → Planer-Zustellung → Telegram (Gedanken-Signatur, 22–7)
 * Was über beide kam, kam doppelt; Quellen ohne Vertrauen/Belege (Missionen,
 * Selbst-Denken, Traum-Reflexion) verschwanden auf A stumm.
 *
 * Jetzt ist jede Meldung ein Gedanke:
 *   - Der OperationalEventBus bleibt das Prüfprotokoll und die Vertrauensprüfung.
 *   - Vertrauenswürdige/belegte Meldung → Gedanke mit ihrer Schwere
 *     (critical = dringend, error/warning = wichtig, info = nur Bericht).
 *   - Ohne Vertrauen/Belege → Gedanke der Art „idee“ (nur /gedanken und
 *     Abendbericht, nie eine Sofortmeldung) — nichts geht mehr stumm verloren.
 *   - Zustellung, Entdopplung, Ruhezeit (core/quiet-hours.ts) und Tageslimit
 *     macht allein der Planer. Der ProactiveMessenger ist nur Transport.
 *   - Nur wenn der Planer ausdrücklich aus ist (autonomy.planner.enabled=false),
 *     geht eine vertrauenswürdige Meldung direkt über den Transport (gleiche
 *     Ruhezeit-Definition); sonst nie.
 */
import type { NewThought, ThoughtSeverity } from '../planner/thoughts.js'

export type OwnerNoticeSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface OwnerNotice {
    content: string
    source: string
    severity: OwnerNoticeSeverity
    confidence: number
    dedupeKey?: string
    evidenceRefs?: string[]
}

export interface OwnerNotifyDeps {
    /** Records the event (audit) and judges trust: trusted producer or explicit evidence. */
    ingest(notice: OwnerNotice): { actionable: boolean; reason: string }
    /** Live Main/Telegram authority (or a valid fence) on this node. */
    authority(): Promise<boolean>
    /** False only when the planner is switched off in the config. */
    plannerActive(): boolean
    addThought(input: NewThought): { thought: { id: string }; deduped: boolean }
    /** Fallback transport while the planner is off (ProactiveMessenger). */
    transport(notice: OwnerNotice): Promise<boolean>
    log?(line: string): void
}

export type OwnerNotifyRoute = 'gedanke' | 'idee' | 'transport' | 'verworfen'

const SOURCE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/** Planner sources are `^[a-z][a-z0-9-]{1,31}$`. */
export function thoughtSource(source: string): string {
    const clean = String(source || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/g, '').slice(0, 32).replace(/-+$/g, '')
    return SOURCE_PATTERN.test(clean) ? clean : 'meldung'
}

const stripMarkdown = (line: string) => line.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()

/** Title from the first line (plus the second when the first only introduces it), evidence from the rest. */
export function splitNotice(content: string): { title: string; evidence: string } {
    const lines = String(content || '').split(/\r?\n/).map(stripMarkdown).filter(Boolean)
    if (!lines.length) return { title: 'Meldung ohne Text', evidence: '' }
    let used = 1
    let title = lines[0]
    if (/:$/.test(title) && lines.length > 1) { title = `${title} ${lines[1]}`; used = 2 }
    return { title: title.slice(0, 160), evidence: lines.slice(used).join(' · ').slice(0, 600) }
}

const SEVERITY: Record<OwnerNoticeSeverity, ThoughtSeverity> = { critical: 'critical', error: 'warning', warning: 'warning', info: 'info' }

/** Pure mapping used by notifyOwner (exported for tests). */
export function noticeToThought(notice: OwnerNotice, trusted: boolean): NewThought {
    const source = thoughtSource(notice.source)
    const { title, evidence } = splitNotice(notice.content)
    const signature = notice.dedupeKey ? `${source}:${notice.dedupeKey}` : undefined
    if (!trusted) {
        return {
            source, title, kind: 'idee',
            evidence: `unbestätigt (keine Belege, nur Bericht)${evidence ? ` · ${evidence}` : ''}`,
            ...(signature ? { signature } : {}),
        }
    }
    return { source, title, kind: 'ereignis', permission: 'selbst', severity: SEVERITY[notice.severity] ?? 'info', evidence, ...(signature ? { signature } : {}) }
}

export async function notifyOwner(notice: OwnerNotice, deps: OwnerNotifyDeps): Promise<{ route: OwnerNotifyRoute; reason: string }> {
    const verdict = deps.ingest(notice)
    let live = false
    try { live = await deps.authority() } catch { live = false }
    if (!live) {
        // The real Main raises its own; a worker never collects thoughts it cannot deliver.
        deps.log?.(`[Meldung] ${notice.source}: keine Main/Telegram-Autorität auf diesem Knoten — nicht gemeldet`)
        return { route: 'verworfen', reason: 'keine Main/Telegram-Autorität' }
    }
    if (deps.plannerActive()) {
        const input = noticeToThought(notice, verdict.actionable)
        deps.addThought(input)
        return verdict.actionable
            ? { route: 'gedanke', reason: verdict.reason }
            : { route: 'idee', reason: `${verdict.reason} — nur Bericht` }
    }
    if (!verdict.actionable) {
        deps.log?.(`[Meldung] ${notice.source}: ${verdict.reason} (Planer aus, kein Bericht)`)
        return { route: 'verworfen', reason: verdict.reason }
    }
    return (await deps.transport(notice)) ? { route: 'transport', reason: 'Planer aus' } : { route: 'verworfen', reason: 'Transport hat nicht zugestellt' }
}
