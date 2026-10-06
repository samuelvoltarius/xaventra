/**
 * 2.88 „Sehen und lenken“ Teil 2: Aktivität.
 *
 * EINE Liste von allem, was Xaventra gerade und im Hintergrund tut — gebaut
 * aus den vorhandenen Quellen, nichts wird neu erfunden:
 *   Aufgabe      task-tracker / Telegram-Statuskarten (core/now-view.ts)
 *   Projekt      Auftrag (core/autonomous-executor.ts) und Missionen der
 *                Verantwortungen (core/missions.ts via readArbeitState)
 *   Helfer       Unteragenten (agents/subagent-orchestrator.ts)
 *   Übergeben    Delegationen (core/delegation.ts)
 *   Verantwortung core/responsibilities.ts
 *   Wächter / Lernen / Geplant   Planer-Jobs (planner/planner.ts)
 *
 * Pro Eintrag: was sie gerade tut (ein kurzer Satz), Status, Node, Grund und
 * die Knöpfe „Stopp“, „Später“, „Anders: …“ (+ „Weiter“ nach Pause). Jeder
 * Knopf ruft genau die vorhandene Funktion der Quelle auf (cancelMission,
 * setPaused, cancelSubagent, withdraw, setEnabled). „Anders: …“ geht als
 * Gedanke an den Planer (planner/thoughts.ts). „Später“ pausiert und merkt
 * sich, wann es weitergeht (<data>/aktivitaet/spaeter.json); fortgesetzt wird
 * nur, was „Später“ selbst angehalten hat. Grundfunktionen (Wächter,
 * Berichte, sys-Jobs) lassen sich nicht dauerhaft stoppen, nur auf später.
 *
 * Nur der Owner sieht und steuert das (API ownerOnly, Telegram Owner-Chat).
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type AktivitaetArt = 'aufgabe' | 'auftrag' | 'mission' | 'subagent' | 'delegation' | 'verantwortung' | 'waechter' | 'lernen' | 'geplant'
export type AktivitaetStatus = 'laeuft' | 'wartet' | 'pausiert' | 'geplant' | 'spaeter'
export type AktivitaetAktion = 'stopp' | 'spaeter' | 'weiter' | 'anders'

export interface Aktivitaet {
    id: string
    art: AktivitaetArt
    artText: string
    titel: string
    /** Was sie gerade tut, kurz („Browser: suche Doku zu ESPHome“, „Projekt Website 4/7“). */
    tut: string
    status: AktivitaetStatus
    statusText: string
    node: string
    grund: string
    seit: string | null
    naechster: string | null
    /** true = läuft jetzt; false = Hintergrund/geplant. */
    jetzt: boolean
    aktionen: AktivitaetAktion[]
    spaeterBis?: string
}

export interface AktivitaetView { generatedAt: string; eintraege: Aktivitaet[]; probleme: string[] }

const ART_TEXT: Record<AktivitaetArt, string> = {
    aufgabe: 'Aufgabe', auftrag: 'Projekt', mission: 'Projekt', subagent: 'Helfer', delegation: 'Übergeben',
    verantwortung: 'Verantwortung', waechter: 'Wächter', lernen: 'Lernen', geplant: 'Geplant',
}
const STATUS_TEXT: Record<AktivitaetStatus, string> = { laeuft: 'läuft', wartet: 'wartet', pausiert: 'pausiert', geplant: 'geplant', spaeter: 'später' }
const ID = /^(aufgabe|auftrag|mission|subagent|delegation|verantwortung|waechter|lernen|geplant):[A-Za-z0-9_.:@-]{1,120}$/
const SPAETER_MIN = 15
const SPAETER_MAX = 24 * 60
export const SPAETER_STANDARD_MIN = 60

const clean = (value: unknown, max = 200) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const iso = (value: unknown): string | null => {
    const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

// ---------------------------------------------------------------------------
// Quellen (in Tests ersetzbar)
// ---------------------------------------------------------------------------

interface TaskLike { summary?: string; userMessage?: string; status?: string; channel?: string; startedAt?: number; currentStep?: number; steps?: Array<{ description?: string }> }
interface AuftragLike { id: string; goal?: string; summary?: string; status: string; currentStep?: number; steps?: Array<{ description?: string; status?: string }>; createdAt?: number; ownerNode?: string; channel?: string }
interface MissionLike { id: string; responsibilityId: string; titel: string; status: string; cursor: number; steps: Array<{ titel: string; status: string; node?: string }>; node?: string; anlass?: string[]; grund?: string; createdAt?: string; updatedAt?: string }
interface VerantwortungLike { id: string; titel: string; ziel?: string; status: string; herkunft?: string; lastCheck?: { at?: string; erfuellt?: boolean | null } }
interface JobLike { id: string; kind: string; title: string; enabled: boolean; status: string; nextRunAt: string | null; lastRunAt?: string; lastStatus?: string; schedule?: { type: string; time?: string; minutes?: number } }

export interface AktivitaetQuellen {
    dataDir?: string
    now?: () => number
    nodeId?: () => string
    aufgaben?: () => Promise<Array<{ label: string; since: number; source: string }>>
    aktuelleAufgabe?: () => Promise<TaskLike | null>
    auftrag?: () => Promise<AuftragLike | null>
    arbeit?: () => Promise<{ missions: MissionLike[]; responsibilities: VerantwortungLike[] }>
    subagenten?: () => Promise<Array<{ id: string; task: string; status: string; durationMs: number }>>
    delegationen?: () => Promise<Array<{ id: string; to: string; auftrag: string; status: string; updatedAt?: string; fristAt?: string; missionId?: string }>>
    jobs?: () => Promise<JobLike[] | null>
    // Steuern — jeweils die vorhandene Funktion der Quelle.
    auftragStopp?: () => Promise<string>
    auftragPause?: () => Promise<string>
    auftragWeiter?: () => Promise<string>
    verantwortungPause?: (id: string, paused: boolean, by: string) => Promise<{ ok: boolean; message: string }>
    subagentStopp?: (id: string) => Promise<boolean>
    delegationZurueck?: (id: string, grund: string) => Promise<{ ok: boolean; message: string }>
    jobAn?: (id: string, an: boolean) => Promise<boolean>
    gedanke?: (input: { title: string; evidence: string; proposal: string; node?: string }) => Promise<boolean>
}

function produktion(q: AktivitaetQuellen): Required<Omit<AktivitaetQuellen, 'dataDir'>> & { dataDir: string } {
    const plannerRuntime = async () => (await import('../planner/runtime.js')).getPlannerRuntime()
    return {
        dataDir: q.dataDir || getNovaDataDir(),
        now: q.now || Date.now,
        nodeId: q.nodeId || (() => { try { return process.env.NOVA_NODE_ID || 'main' } catch { return 'main' } }),
        aufgaben: q.aufgaben || (async () => {
            const { listActiveStatusCards } = await import('../channels/telegram-status-card.js')
            return listActiveStatusCards().map(card => ({ label: card.text, since: card.startedAt, source: 'Telegram' }))
        }),
        aktuelleAufgabe: q.aktuelleAufgabe || (async () => (await import('../core/task-tracker.js')).getTaskData().current as TaskLike | null),
        auftrag: q.auftrag || (async () => (await import('../core/autonomous-executor.js')).getMissionData().active as AuftragLike | null),
        arbeit: q.arbeit || (async () => (await import('../core/responsibility-runtime.js')).readArbeitState() as any),
        subagenten: q.subagenten || (async () => (await import('../agents/subagent-orchestrator.js')).listSubagents()),
        delegationen: q.delegationen || (async () => (await import('../core/delegation.js')).getDelegationService().list({ open: true, limit: 30 }) as any),
        jobs: q.jobs || (async () => (await plannerRuntime())?.planner.listJobs({ status: 'aktiv' }) as JobLike[] ?? null),
        auftragStopp: q.auftragStopp || (async () => (await import('../core/autonomous-executor.js')).cancelMission()),
        auftragPause: q.auftragPause || (async () => (await import('../core/autonomous-executor.js')).pauseMission()),
        auftragWeiter: q.auftragWeiter || (async () => (await import('../core/autonomous-executor.js')).resumeMission()),
        verantwortungPause: q.verantwortungPause || (async (id, paused, by) => {
            const runtime = (await import('../core/responsibility-runtime.js')).getResponsibilityRuntime()
            if (!runtime) return { ok: false, message: 'Verantwortungen laufen gerade nicht.' }
            return runtime.responsibilities.setPaused(id, paused, by)
        }),
        subagentStopp: q.subagentStopp || (async id => (await import('../agents/subagent-orchestrator.js')).cancelSubagent(id)),
        delegationZurueck: q.delegationZurueck || (async (id, grund) => (await import('../core/delegation.js')).getDelegationService().withdraw(id, grund)),
        jobAn: q.jobAn || (async (id, an) => Boolean((await plannerRuntime())?.planner.setEnabled(id, an))),
        gedanke: q.gedanke || (async input => {
            const runtime = await plannerRuntime()
            const store = runtime?.thoughts || (await import('../planner/index.js')).getThoughtStore()
            store.add({ source: 'owner-lenkung', kind: 'vorschlag', title: input.title, evidence: input.evidence, proposal: input.proposal, severity: 'info', permission: 'fragen', ...(input.node ? { node: input.node } : {}) })
            return true
        }),
    }
}

// ---------------------------------------------------------------------------
// „Später“: was diese Ansicht angehalten hat und wann es weitergeht
// ---------------------------------------------------------------------------

interface SpaeterEintrag { id: string; bis: string; by: string; titel: string }
const spaeterDatei = (dataDir: string) => join(dataDir, 'aktivitaet', 'spaeter.json')
export function ladeSpaeter(dataDir: string): SpaeterEintrag[] {
    try {
        const raw = JSON.parse(readFileSync(spaeterDatei(dataDir), 'utf8'))
        return raw?.version === 1 && Array.isArray(raw.items) ? raw.items.filter((item: SpaeterEintrag) => item && ID.test(String(item.id))) : []
    } catch { return [] }
}
function speichereSpaeter(dataDir: string, items: SpaeterEintrag[]): void {
    mkdirSync(join(dataDir, 'aktivitaet'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(spaeterDatei(dataDir), { version: 1, items: items.slice(-200) })
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

const SYSTEM_JOB = /^sys-/
function jobArt(job: JobLike): AktivitaetArt {
    const text = `${job.kind} ${job.title}`.toLowerCase()
    if (/waechter|wächter|nachtwache|geraet-nochmal|verantwortungen|auto-pruefung/.test(text)) return 'waechter'
    if (/lern|denk|idee|prozedur|training|reflex|nachtlauf|gedanken/.test(text)) return 'lernen'
    return 'geplant'
}
function rhythmus(job: JobLike): string {
    const s = job.schedule
    if (s?.type === 'taeglich') return `täglich ${clean(s.time, 5)}`
    if (s?.type === 'intervall') return `alle ${Number(s.minutes) || 0} min`
    if (s?.type === 'einmal') return 'einmal'
    return ''
}

async function versuch<T>(label: string, work: () => Promise<T>, probleme: string[]): Promise<T | null> {
    try { return await work() } catch (error) { probleme.push(`${label}: ${clean((error as Error)?.message || error, 120)}`); return null }
}

export async function sammleAktivitaet(quellen: AktivitaetQuellen = {}): Promise<AktivitaetView> {
    const q = produktion(quellen)
    const now = q.now()
    await setzeFaelligeFort(quellen).catch(() => undefined)
    const probleme: string[] = []
    const spaeter = new Map(ladeSpaeter(q.dataDir).map(item => [item.id, item]))
    const node = clean(q.nodeId(), 60) || 'main'
    const out: Aktivitaet[] = []
    const push = (item: Omit<Aktivitaet, 'artText' | 'statusText'>) => {
        const later = spaeter.get(item.id)
        const status: AktivitaetStatus = later && item.status === 'pausiert' ? 'spaeter' : item.status
        out.push({ ...item, status, artText: ART_TEXT[item.art], statusText: later && status === 'spaeter' ? `später (ab ${later.bis.slice(11, 16)} UTC)` : STATUS_TEXT[status], ...(later ? { spaeterBis: later.bis } : {}) })
    }

    // Aufgaben (laufende Chat-Anfragen)
    const task = await versuch('Aufgabe', q.aktuelleAufgabe, probleme)
    if (task && (task.status === 'active' || task.status === 'planning')) {
        const step = task.steps?.[task.currentStep ?? 0]
        const total = task.steps?.length || 0
        push({
            id: `aufgabe:${clean(String(task.startedAt || 'jetzt'), 40).replace(/[^A-Za-z0-9_.:@-]/g, '')}`, art: 'aufgabe',
            titel: clean(task.summary || task.userMessage, 120),
            tut: step ? `${clean(step.description, 90)}${total > 1 ? ` (${(task.currentStep ?? 0) + 1}/${total})` : ''}` : 'denkt nach',
            status: 'laeuft', node, grund: `Du hast gefragt (${clean(task.channel || 'Chat', 20)})`, seit: iso(task.startedAt), naechster: null, jetzt: true, aktionen: ['anders'],
        })
    }
    for (const [index, card] of ((await versuch('Telegram', q.aufgaben, probleme)) || []).slice(0, 6).entries()) {
        push({ id: `aufgabe:tg-${index}-${Math.floor(Number(card.since) || 0)}`, art: 'aufgabe', titel: clean(card.label, 120), tut: clean(card.label, 90), status: 'laeuft', node, grund: `Du hast gefragt (${clean(card.source, 20)})`, seit: iso(card.since), naechster: null, jetzt: true, aktionen: ['anders'] })
    }

    // Projekt (Auftrag)
    const auftrag = await versuch('Projekt', q.auftrag, probleme)
    if (auftrag && ['planning', 'active', 'paused'].includes(auftrag.status)) {
        const steps = auftrag.steps || []
        const done = steps.filter(step => step.status === 'done').length
        const current = steps[auftrag.currentStep ?? 0]
        const paused = auftrag.status === 'paused'
        push({
            id: `auftrag:${clean(auftrag.id, 80).replace(/[^A-Za-z0-9_.:@-]/g, '')}`, art: 'auftrag', titel: clean(auftrag.summary || auftrag.goal, 120),
            tut: `Projekt ${clean(auftrag.summary || auftrag.goal, 50)} ${Math.min(done + (paused ? 0 : 1), steps.length || 1)}/${steps.length || 1}${current?.description && !paused ? `: ${clean(current.description, 60)}` : ''}`,
            status: paused ? 'pausiert' : 'laeuft', node: clean(auftrag.ownerNode || node, 60), grund: `Dein Auftrag (${clean(auftrag.channel || 'Chat', 20)})`,
            seit: iso(auftrag.createdAt), naechster: null, jetzt: !paused, aktionen: paused ? ['weiter', 'stopp', 'anders'] : ['stopp', 'spaeter', 'anders'],
        })
    }

    // Missionen + Verantwortungen
    const arbeit = await versuch('Verantwortungen', q.arbeit, probleme)
    const titelVerantwortung = new Map((arbeit?.responsibilities || []).map(item => [item.id, item.titel]))
    for (const mission of (arbeit?.missions || []).filter(item => ['geplant', 'in-arbeit', 'wartet-auf-alfred', 'wartet-auf-delegation', 'blockiert'].includes(item.status)).slice(-12)) {
        const step = mission.steps[mission.cursor]
        const total = mission.steps.length
        const paused = mission.status === 'blockiert'
        const wartet = mission.status.startsWith('wartet')
        push({
            id: `mission:${clean(mission.id, 40)}`, art: 'mission', titel: clean(mission.titel, 120),
            tut: `Projekt ${clean(mission.titel, 50)} ${Math.min(mission.cursor + 1, total || 1)}/${total || 1}${step ? `: ${clean(step.titel, 60)}` : ''}`,
            status: paused ? 'pausiert' : wartet ? 'wartet' : mission.status === 'geplant' ? 'geplant' : 'laeuft', node: clean(step?.node || mission.node || node, 60),
            grund: clean(mission.grund || (mission.anlass || [])[0] || `Verantwortung „${titelVerantwortung.get(mission.responsibilityId) || mission.responsibilityId}“`, 160),
            seit: iso(mission.createdAt), naechster: null, jetzt: mission.status === 'in-arbeit',
            aktionen: ['stopp', 'spaeter', 'anders'],
        })
    }
    for (const item of (arbeit?.responsibilities || []).filter(entry => entry.status === 'aktiv' || entry.status === 'pausiert').slice(0, 30)) {
        const paused = item.status === 'pausiert'
        push({
            id: `verantwortung:${clean(item.id, 100)}`, art: 'verantwortung', titel: clean(item.titel, 120),
            tut: paused ? 'pausiert' : item.lastCheck?.erfuellt === false ? `kümmert sich: ${clean(item.ziel || item.titel, 70)}` : `passt auf: ${clean(item.ziel || item.titel, 70)}`,
            status: paused ? 'pausiert' : 'laeuft', node, grund: item.herkunft === 'owner' ? 'Du hast es ihr aufgetragen' : 'Selbst abgeleitet',
            seit: iso(item.lastCheck?.at), naechster: null, jetzt: false, aktionen: paused ? ['weiter', 'anders'] : ['stopp', 'spaeter', 'anders'],
        })
    }

    // Helfer (Unteragenten)
    for (const agent of ((await versuch('Helfer', q.subagenten, probleme)) || []).filter(item => item.status === 'running' || item.status === 'pending').slice(0, 6)) {
        push({
            id: `subagent:${clean(agent.id, 100).replace(/[^A-Za-z0-9_.:@-]/g, '')}`, art: 'subagent', titel: clean(agent.task, 120), tut: `Helfer: ${clean(agent.task, 80)}`,
            status: agent.status === 'running' ? 'laeuft' : 'wartet', node, grund: 'Teil einer größeren Aufgabe', seit: iso(now - (Number(agent.durationMs) || 0)), naechster: null, jetzt: agent.status === 'running',
            aktionen: agent.status === 'running' ? ['stopp', 'anders'] : ['anders'],
        })
    }

    // Übergeben (Delegationen)
    for (const record of ((await versuch('Übergeben', q.delegationen, probleme)) || []).filter(item => ['wartet-auf-freigabe', 'gesendet', 'angenommen'].includes(item.status)).slice(0, 10)) {
        const wartet = record.status === 'wartet-auf-freigabe'
        push({
            id: `delegation:${clean(record.id, 60)}`, art: 'delegation', titel: clean(record.auftrag, 120), tut: `${wartet ? 'wartet auf dein Ja für' : 'bei'} ${clean(record.to, 20)}: ${clean(record.auftrag, 60)}`,
            status: wartet ? 'wartet' : 'laeuft', node: clean(record.to, 30), grund: record.missionId ? `Schritt im Projekt ${clean(record.missionId, 20)}` : 'Übergeben an einen anderen Agenten',
            seit: iso(record.updatedAt), naechster: iso(record.fristAt), jetzt: !wartet, aktionen: wartet ? ['stopp', 'anders'] : ['anders'],
        })
    }

    // Wächter / Lernen / Geplant (Planer)
    for (const job of ((await versuch('Planer', q.jobs, probleme)) || []).slice(0, 60)) {
        const art = jobArt(job)
        const system = SYSTEM_JOB.test(job.id)
        const paused = job.enabled === false
        push({
            id: `${art}:${clean(job.id, 60)}`, art, titel: clean(job.title, 120),
            tut: paused ? 'pausiert' : `${art === 'waechter' ? 'prüft' : art === 'lernen' ? 'lernt' : 'geplant'} ${rhythmus(job)}`.trim(),
            status: paused ? 'pausiert' : 'geplant', node: 'main', grund: system ? 'Grundfunktion' : 'Von dir oder ihr eingeplant',
            seit: iso(job.lastRunAt), naechster: paused ? null : iso(job.nextRunAt), jetzt: false,
            aktionen: paused ? ['weiter', 'anders'] : system ? ['spaeter', 'anders'] : ['stopp', 'spaeter', 'anders'],
        })
    }

    const order: Record<AktivitaetStatus, number> = { laeuft: 0, wartet: 1, geplant: 2, spaeter: 3, pausiert: 4 }
    out.sort((a, b) => Number(b.jetzt) - Number(a.jetzt) || order[a.status] - order[b.status] || String(a.naechster || '9').localeCompare(String(b.naechster || '9')))
    return { generatedAt: new Date(now).toISOString(), eintraege: out.slice(0, 80), probleme }
}

// ---------------------------------------------------------------------------
// Steuern
// ---------------------------------------------------------------------------

export interface SteuerAntwort { ok: boolean; message: string }

const refOf = (id: string) => id.slice(id.indexOf(':') + 1)
const ok = (message: string): SteuerAntwort => ({ ok: true, message })
const nein = (message: string): SteuerAntwort => ({ ok: false, message })
const emojiFrei = (text: string) => clean(text.replace(/^[^\p{L}\p{N}„"]+/u, ''), 240)

async function anhalten(q: ReturnType<typeof produktion>, item: Aktivitaet, by: string, dauerhaft: boolean): Promise<SteuerAntwort> {
    const ref = refOf(item.id)
    switch (item.art) {
        case 'auftrag': {
            const text = dauerhaft ? await q.auftragStopp() : await q.auftragPause()
            return /^❌/.test(text) ? nein(emojiFrei(text)) : ok(dauerhaft ? `Gestoppt: ${item.titel}.` : `Angehalten: ${item.titel}.`)
        }
        case 'mission': {
            const mission = ((await q.arbeit()).missions || []).find(entry => entry.id === ref)
            if (!mission) return nein('Dieses Projekt gibt es nicht mehr.')
            const r = await q.verantwortungPause(mission.responsibilityId, true, by)
            return r.ok ? ok(`${dauerhaft ? 'Gestoppt' : 'Angehalten'}: ${item.titel} (die Verantwortung dahinter ruht).`) : nein(r.message)
        }
        case 'verantwortung': {
            const r = await q.verantwortungPause(ref, true, by)
            return r.ok ? ok(`${dauerhaft ? 'Pausiert' : 'Angehalten'}: ${item.titel}.`) : nein(r.message)
        }
        case 'subagent': {
            if (!dauerhaft) return nein('Einen Helfer kann ich nur stoppen, nicht verschieben.')
            return (await q.subagentStopp(ref)) ? ok(`Helfer gestoppt: ${item.titel}.`) : nein('Der Helfer läuft schon nicht mehr.')
        }
        case 'delegation': {
            if (!dauerhaft) return nein('Eine Übergabe kann ich nur zurückziehen.')
            const r = await q.delegationZurueck(ref, `vom Owner gestoppt (${by})`)
            return r.ok ? ok(`Zurückgezogen: ${item.titel}.`) : nein(r.message)
        }
        case 'waechter': case 'lernen': case 'geplant': {
            if (dauerhaft && SYSTEM_JOB.test(ref)) return nein('Das ist eine Grundfunktion – die kann ich nur auf später verschieben, nicht abschalten.')
            return (await q.jobAn(ref, false)) ? ok(`${dauerhaft ? 'Gestoppt' : 'Angehalten'}: ${item.titel}.`) : nein('Der Planer läuft gerade nicht.')
        }
        default: return nein('Eine laufende Antwort kann ich nicht anhalten – sag mir einfach „Anders: …“.')
    }
}

async function fortsetzen(q: ReturnType<typeof produktion>, id: string, by: string): Promise<SteuerAntwort> {
    const art = id.slice(0, id.indexOf(':')) as AktivitaetArt
    const ref = refOf(id)
    if (art === 'auftrag') { const text = await q.auftragWeiter(); return /^❌/.test(text) ? nein(emojiFrei(text)) : ok('Geht weiter.') }
    if (art === 'verantwortung') { const r = await q.verantwortungPause(ref, false, by); return r.ok ? ok('Geht weiter.') : nein(r.message) }
    if (art === 'mission') {
        const mission = ((await q.arbeit()).missions || []).find(entry => entry.id === ref)
        if (!mission) return nein('Dieses Projekt gibt es nicht mehr.')
        const r = await q.verantwortungPause(mission.responsibilityId, false, by)
        return r.ok ? ok('Geht weiter.') : nein(r.message)
    }
    if (art === 'waechter' || art === 'lernen' || art === 'geplant') return (await q.jobAn(ref, true)) ? ok('Geht weiter.') : nein('Der Planer läuft gerade nicht.')
    return nein('Das lässt sich nicht fortsetzen.')
}

/** Setzt fort, was „Später“ angehalten hat und dessen Zeit gekommen ist. */
export async function setzeFaelligeFort(quellen: AktivitaetQuellen = {}): Promise<number> {
    const q = produktion(quellen)
    const now = q.now()
    const items = ladeSpaeter(q.dataDir)
    const due = items.filter(item => Date.parse(item.bis) <= now)
    if (!due.length) return 0
    let resumed = 0
    for (const item of due) {
        try { if ((await fortsetzen(q, item.id, item.by)).ok) resumed++ } catch { /* the entry goes; the owner sees the real state */ }
    }
    speichereSpaeter(q.dataDir, items.filter(item => !due.includes(item)))
    return resumed
}

/**
 * Ein Knopf auf einem Eintrag. Nur Owner (Aufrufer prüft). `text` nur für
 * „anders“, `minuten` nur für „spaeter“ (15 min … 24 h, Standard 60).
 */
export async function steuereAktivitaet(id: unknown, aktion: unknown, opts: { by: string; text?: unknown; minuten?: unknown }, quellen: AktivitaetQuellen = {}): Promise<SteuerAntwort> {
    const key = String(id ?? '')
    if (!ID.test(key)) return nein('Unbekannter Eintrag.')
    if (!['stopp', 'spaeter', 'weiter', 'anders'].includes(String(aktion))) return nein('Unbekannter Knopf.')
    const q = produktion(quellen)
    const by = clean(opts.by, 80) || 'owner'
    const view = await sammleAktivitaet(quellen)
    const item = view.eintraege.find(entry => entry.id === key)
    const later = ladeSpaeter(q.dataDir)
    if (aktion === 'weiter') {
        if (!item || !item.aktionen.includes('weiter')) return nein(item ? 'Das läuft schon.' : 'Diesen Eintrag gibt es nicht mehr.')
        const r = await fortsetzen(q, key, by)
        if (r.ok) speichereSpaeter(q.dataDir, later.filter(entry => entry.id !== key))
        return r
    }
    if (!item) return nein('Diesen Eintrag gibt es nicht mehr.')
    if (aktion === 'anders') {
        const text = clean(opts.text, 500)
        if (text.length < 2) return nein('Schreib kurz, was ich stattdessen tun soll.')
        const done = await q.gedanke({
            title: clean(`Anders: ${item.titel}`, 150), evidence: `Owner lenkt um (${item.artText}, ${item.statusText}): „${text}“`,
            proposal: text, node: item.node,
        }).catch(() => false)
        return done ? ok(`Gut, ich nehme das in meine Planung: „${text}“. ${item.status === 'laeuft' ? 'Soll ich das Laufende dafür anhalten, drück „Stopp“.' : ''}`.trim())
            : nein('Ich konnte es gerade nicht in meine Planung schreiben.')
    }
    if (!item.aktionen.includes(aktion as AktivitaetAktion)) {
        return nein(aktion === 'stopp' && item.aktionen.includes('spaeter') ? 'Das ist eine Grundfunktion – die kann ich nur auf später verschieben.' : 'Das geht bei diesem Eintrag nicht.')
    }
    if (aktion === 'stopp') {
        const r = await anhalten(q, item, by, true)
        if (r.ok) speichereSpaeter(q.dataDir, later.filter(entry => entry.id !== key))
        return r
    }
    const minuten = Math.min(SPAETER_MAX, Math.max(SPAETER_MIN, Math.round(Number(opts.minuten) || SPAETER_STANDARD_MIN)))
    const r = await anhalten(q, item, by, false)
    if (!r.ok) return r
    const bis = new Date(q.now() + minuten * 60_000).toISOString()
    speichereSpaeter(q.dataDir, [...later.filter(entry => entry.id !== key), { id: key, bis, by, titel: item.titel }])
    const wann = minuten >= 60 && minuten % 60 === 0 ? `${minuten / 60} Stunde${minuten === 60 ? '' : 'n'}` : `${minuten} Minuten`
    return ok(`Mache ich später – in ${wann} geht „${item.titel}“ weiter.`)
}

// ---------------------------------------------------------------------------
// Telegram (eine Seite)
// ---------------------------------------------------------------------------

const ZEICHEN: Record<AktivitaetStatus, string> = { laeuft: '▶️', wartet: '⏳', geplant: '🗓', spaeter: '⏰', pausiert: '⏸' }

export function aktivitaetText(view: AktivitaetView, max = 12): string {
    const lines = ['👀 Was ich gerade tue']
    const jetzt = view.eintraege.filter(item => item.jetzt)
    const rest = view.eintraege.filter(item => !item.jetzt)
    if (!jetzt.length) lines.push('', 'Gerade arbeite ich an nichts Bestimmtem.')
    for (const item of [...jetzt, ...rest].slice(0, max)) lines.push(`${ZEICHEN[item.status]} ${item.artText}: ${item.tut}${item.node && item.node !== 'main' ? ` · ${item.node}` : ''}`)
    if (view.eintraege.length > max) lines.push(`… und ${view.eintraege.length - max} weitere in der App unter „Aktivität“.`)
    return lines.join('\n')
}
