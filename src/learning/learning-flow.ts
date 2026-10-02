/**
 * Lern-Puls (2.84, Punkt 6): Lernt Xaventra überhaupt?
 *
 * Reine Lesefunktion über vorhandene Zeitstempel — keine neue Datei, keine
 * Inhalte, nur Zahlen. Je Lernspeicher die neuen Einträge der letzten 7 Tage
 * gegen die 7 davor, dazu der Nutzen des Gelernten (Abrufe und Erfolge).
 *
 * - Abendbericht: höchstens 2 Zeilen im vorhandenen Abschnitt „Lernkurve“
 *   (briefing.ts, Eingang `learning.flowLines`), kein zweiter Bericht.
 * - Bug-Finder: `learningFlowErrorSource()` ist eine Quelle des einen
 *   Bug-Finders. An jedem Tag, an dem ein wachstumspflichtiger Speicher
 *   (Gedächtnis, Prozeduren, Graph) seit 7 Tagen keinen Zufluss hatte,
 *   obwohl mindestens 20 Owner-Läufe validiert wurden, entsteht ein
 *   Vorkommen `lernkanal:<name>`; `successes()` liefert die neuen Einträge,
 *   damit der Fall gemessen schließt, sobald wieder Zufluss da ist.
 *   Routine-Skills und Schmiede wachsen bewusst selten und melden nie „stumm“.
 */
import type { ErrorOccurrence, ErrorSourcePort } from '../thinking/bug-finder.js'
import { ownerKernelRun } from '../core/validator-failure-escalation.js'

export type LearningChannel = 'gedaechtnis' | 'vektor' | 'prozeduren' | 'skills' | 'werkzeuge' | 'graph' | 'faelle'

export const CHANNEL_LABELS: Record<LearningChannel, string> = {
    gedaechtnis: 'Gedächtnis',
    vektor: 'Vektor-Projektion',
    prozeduren: 'Prozeduren',
    skills: 'Routine-Skills',
    werkzeuge: 'Werkzeuge',
    graph: 'Graph',
    faelle: 'Fälle gemessen geschlossen',
}
const CHANNEL_ORDER = Object.keys(CHANNEL_LABELS) as LearningChannel[]
/** Diese Speicher müssen bei Betrieb wachsen; Skills und Schmiede nicht. */
export const GROWTH_REQUIRED: readonly LearningChannel[] = ['gedaechtnis', 'prozeduren', 'graph']
export const MIN_OWNER_RUNS = 20

const DAY_MS = 24 * 60 * 60_000
const WEEK_MS = 7 * DAY_MS

type Maybe<T> = T | null | Promise<T | null>
export type UsageKind = 'prozeduren' | 'skills' | 'werkzeuge'

export interface LearningFlowSources {
    /** Zeitstempel (ms) der Einträge je Speicher; null = Quelle nicht verfügbar. */
    channels?: Partial<Record<LearningChannel, () => Maybe<number[]>>>
    /** Gesamtnutzen: Abrufe und davon erfolgreich. */
    usage?: () => Partial<Record<UsageKind, { uses: number; ok: number }>> | Promise<Partial<Record<UsageKind, { uses: number; ok: number }>>>
    /** Zeitstempel validierter Owner-Läufe (Kernel). */
    ownerRuns?: () => Maybe<number[]>
}

export interface ChannelFlow { channel: LearningChannel; label: string; current: number; previous: number }
export interface LearningFlow {
    channels: ChannelFlow[]
    usage: Array<{ kind: UsageKind; label: string; uses: number; ok: number }>
}

async function read(source: (() => Maybe<number[]>) | undefined): Promise<number[] | null> {
    if (!source) return null
    try {
        const value = await source()
        return Array.isArray(value) ? value.filter(Number.isFinite) : null
    } catch { return null }
}

const between = (times: readonly number[], from: number, to: number) => times.filter(at => at > from && at <= to).length

/** Zufluss je Speicher (diese Woche gegen Vorwoche) und Nutzen. Nur Speicher mit Daten. */
export async function learningFlow(now = Date.now(), sources: LearningFlowSources = defaultLearningFlowSources()): Promise<LearningFlow> {
    const channels: ChannelFlow[] = []
    for (const channel of CHANNEL_ORDER) {
        const times = await read(sources.channels?.[channel])
        if (!times) continue
        channels.push({ channel, label: CHANNEL_LABELS[channel], current: between(times, now - WEEK_MS, now), previous: between(times, now - 2 * WEEK_MS, now - WEEK_MS) })
    }
    let usageRaw: Partial<Record<UsageKind, { uses: number; ok: number }>> = {}
    try { usageRaw = (await sources.usage?.()) || {} } catch { usageRaw = {} }
    const usage = (['prozeduren', 'skills', 'werkzeuge'] as const)
        .map(kind => ({ kind, label: CHANNEL_LABELS[kind], uses: Math.max(0, Number(usageRaw[kind]?.uses) || 0), ok: Math.max(0, Number(usageRaw[kind]?.ok) || 0) }))
        .filter(item => item.uses > 0)
    return { channels, usage }
}

/** Höchstens 2 Zeilen für den Lernkurven-Abschnitt; nur Speicher mit Daten. */
export function learningFlowLines(flow: LearningFlow): string[] {
    const lines: string[] = []
    const grown = flow.channels.filter(item => item.current > 0 || item.previous > 0)
    if (grown.length) lines.push(`Gelernt diese Woche: ${grown.map(item => `${item.label} ${item.current} (Vorwoche ${item.previous})`).join(', ')}`)
    if (flow.usage.length) lines.push(`Gelerntes im Einsatz: ${flow.usage.map(item => `${item.label} ${item.uses}× (${item.ok} ok)`).join(', ')}`)
    return lines
}

const MARK = Symbol.for('xaventra.learningFlowSource')

/** Erkennt die Lern-Puls-Quelle (Verdrahtung genau einmal). */
export function isLearningFlowSource(source: unknown): boolean {
    return Boolean(source && (source as any)[MARK] === true)
}

/** Quelle für den einen Bug-Finder: stummer wachstumspflichtiger Speicher trotz Betrieb. */
export function learningFlowErrorSource(options: { sources?: LearningFlowSources; now?: () => number; minOwnerRuns?: number } = {}): ErrorSourcePort {
    const sources = () => options.sources ?? defaultLearningFlowSources()
    const clock = options.now ?? (() => Date.now())
    const minRuns = options.minOwnerRuns ?? MIN_OWNER_RUNS
    const port: ErrorSourcePort & { [MARK]: true } = {
        [MARK]: true,
        async collect(sinceMs) {
            const now = clock()
            const src = sources()
            const runs = await read(src.ownerRuns)
            if (!runs || runs.length < minRuns) return []
            const out: ErrorOccurrence[] = []
            for (const channel of GROWTH_REQUIRED) {
                const times = await read(src.channels?.[channel])
                if (!times) continue
                // Nur solange er jetzt stumm ist: kommt wieder Zufluss, verschwinden
                // die Vorkommen und der Fall schließt über successes().
                if (between(times, now - WEEK_MS, now) > 0) continue
                // Ein Prüfpunkt je Tag im Fenster: Zufluss und Betrieb der 7 Tage davor.
                for (let at = now; at >= sinceMs; at -= DAY_MS) {
                    const ownerRuns = between(runs, at - WEEK_MS, at)
                    if (ownerRuns < minRuns || between(times, at - WEEK_MS, at) > 0) continue
                    out.push({
                        source: 'lern-puls', subject: `lernkanal:${channel}`, at,
                        message: `Lernspeicher ${CHANNEL_LABELS[channel]} ohne Zufluss seit 7 Tagen trotz ${ownerRuns} validierter Owner-Läufe`,
                        ref: `lern-puls:${channel}:${new Date(at).toISOString().slice(0, 10)}`,
                    })
                }
            }
            return out
        },
        async successes(sinceMs) {
            const src = sources()
            const total: Record<string, number> = {}
            for (const channel of GROWTH_REQUIRED) {
                const times = await read(src.channels?.[channel])
                if (times) total[`lernkanal:${channel}`] = times.filter(at => at >= sinceMs).length
            }
            return total
        },
    }
    return port
}

// ---------------------------------------------------------------------------
// Standard-Quellen: nur vorhandene Speicher, nur Zeitstempel und Zähler
// ---------------------------------------------------------------------------

const iso = (value: unknown) => Date.parse(String(value ?? ''))

/** Validierte Owner-Läufe aus dem Outcome-Ledger — die eine Regel `ownerKernelRun`. */
function validatedOwnerRunTimes(runs: readonly any[]): number[] {
    return runs
        .filter(run => run && ownerKernelRun(run))
        .map(run => iso(run.updatedAt))
        .filter(Number.isFinite)
}

export function defaultLearningFlowSources(): LearningFlowSources {
    return {
        channels: {
            gedaechtnis: async () => {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                return getMemoryGovernanceCoordinator().list()
                    .filter(record => (record.status === 'verified' || record.status === 'canonical') && record.kind !== 'operational')
                    .map(record => record.createdAt)
            },
            vektor: async () => {
                // Nur wenn LanceDB in diesem Prozess schon offen ist; der Bericht öffnet keine Datenbank.
                const lance = await import('../memory/lancedb-memory.js')
                if (!lance.getActiveProjection()) return null
                const now = Date.now()
                const [current, previous] = await Promise.all([lance.countRowsBetween(now - WEEK_MS + 1, now), lance.countRowsBetween(now - 2 * WEEK_MS + 1, now - WEEK_MS)])
                if (current === null || previous === null) return null
                // Zählung statt Zeilen: als Zeitstempel in der jeweiligen Woche abbilden.
                return [...Array(current).fill(now), ...Array(previous).fill(now - WEEK_MS)]
            },
            prozeduren: async () => {
                const { getProcedureStore } = await import('./procedure-store.js')
                return getProcedureStore().list().filter(entry => entry.source === 'verifiziert').map(entry => entry.learnedAt)
            },
            skills: async () => {
                const { getRoutineSkillStore } = await import('./routine-skills.js')
                const store = getRoutineSkillStore()
                return store ? store.list().filter(skill => skill.origin !== 'eingebaut').map(skill => iso(skill.createdAt)) : null
            },
            werkzeuge: async () => {
                const { getSkillProposals } = await import('../tools/skill-builder.js')
                return getSkillProposals(10_000).filter(tool => tool.origin !== 'altbestand').map(tool => tool.createdAt)
            },
            graph: async () => {
                const { getFullGraph } = await import('../memory/knowledge-graph.js')
                return getFullGraph().nodes.map(node => node.createdAt)
            },
            faelle: async () => {
                const { getFailureResearchCoordinator } = await import('../doctor/failure-research-coordinator.js')
                return getFailureResearchCoordinator().list()
                    .filter(item => item.findingOpen === false && item.evidenceRefs.some(ref => ref.startsWith('messung:')))
                    .map(item => iso(item.updatedAt))
            },
        },
        usage: async () => {
            const out: Partial<Record<UsageKind, { uses: number; ok: number }>> = {}
            try {
                const { getProcedureStore } = await import('./procedure-store.js')
                const list = getProcedureStore().list()
                const uses = list.reduce((sum, entry) => sum + (entry.uses || 0), 0)
                out.prozeduren = { uses, ok: uses - list.reduce((sum, entry) => sum + (entry.failures || 0), 0) }
            } catch { /* optional */ }
            try {
                const { getRoutineSkillStore } = await import('./routine-skills.js')
                const list = getRoutineSkillStore()?.list() || []
                out.skills = { uses: list.reduce((sum, skill) => sum + (skill.successes || 0) + (skill.failures || 0), 0), ok: list.reduce((sum, skill) => sum + (skill.successes || 0), 0) }
            } catch { /* optional */ }
            try {
                const { getSkillProposals } = await import('../tools/skill-builder.js')
                const list = getSkillProposals(10_000)
                out.werkzeuge = { uses: list.reduce((sum, tool) => sum + (tool.counters?.calls || 0), 0), ok: list.reduce((sum, tool) => sum + (tool.counters?.successes || 0), 0) }
            } catch { /* optional */ }
            return out
        },
        ownerRuns: async () => {
            const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
            return validatedOwnerRunTimes(getOutcomeLedger().listRuns(500))
        },
    }
}