/**
 * 2.86 Paket N „Geräte einfach und sicher“ — Schalten mit Vorschau,
 * Rückgängig, Fehler als nächster Schritt, Räume und Routinen.
 *
 * Ablauf (Aktions-Policy unverändert: physisch = Karte, jedes Mal):
 *  1. „Licht im Wohnzimmer aus“ → rooms.ts versteht und löst eindeutig auf
 *     (mehrdeutig → EINE Rückfrage mit Knöpfen, Bündel `raumwahl`).
 *  2. Vorschau-Karte in einem Satz: „Ich schalte jetzt Stehlampe im
 *     Wohnzimmer aus.“ [Ja] [Nein]. Erst das Ja schaltet — über den
 *     bestehenden Weg `proposeSmartSwitch` → `confirmSmartSwitch` →
 *     `executeSmartSwitch` (Owner, Freigabe, Fingerabdruck, Main-Autorität
 *     werden dort wie bisher geprüft).
 *  3. Danach Knopf „Rückgängig“ (5 Minuten gültig): stellt den Zustand her,
 *     den das Gerät direkt vor dem Schalten gemeldet hat. Meldet das Gerät
 *     seinen Zustand nicht, gibt es ehrlich keinen Rückgängig-Knopf.
 *  4. Fehlschlag → device-errors.ts: ein Satz + ein Angebot. „Nochmal, wenn es
 *     wieder an ist“ = ein Planer-Wächter (`geraet-nochmal`) prüft jede Minute
 *     lesend, ob das Gerät wieder erreichbar ist, und versucht die per Karte
 *     freigegebene Aktion dann GENAU einmal (Zustand vor dem Versuch
 *     gespeichert; höchstens 12 Stunden).
 *  5. Routinen (device-routines.ts): Vorschau → ein Ja → täglicher Planer-Job
 *     `geraete-routine`; jede Ausführung schaltet nur die Ziele des Ja.
 *
 * Alles hier ist eine Karten-Art (`geraet-schalten`, Wirkung physisch): nie
 * „Immer erlauben“, nie Vertrauensleiter. Die Karte trägt nur die Plan-Id.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { ApprovalCard, CardExecutionResult, CardExecutor, CardStoreOptions, NewCardInput } from '../core/approval-cards.js'
import type { JobHandler, Planner, PlannerJob } from '../planner/planner.js'
import { loadDevices, sensingDeviceFingerprint, type Approver, type DeviceRecord } from './device-registry.js'
import { bestandsUrsache, fehlerUrsache, naechsterSchritt, type FehlerUrsache } from './device-errors.js'
import { geraetAnzeige, schaltTeil, vorschauSatz } from './device-words.js'
import { aendereRoutine, aktiveRoutinen, ladeRoutinen, neueRoutine, parseRoutineSatz, type GeraeteRoutine, type RoutineZiel } from './device-routines.js'
import { loeseAuf, parseSchaltSatz, raumIndex, type RaumFunktion, type SchaltSatz } from './rooms.js'

export const SCHALT_KIND = 'geraet-schalten'
export const RAUMWAHL_BUENDEL = 'raumwahl'
export const ROUTINEN_BUENDEL = 'routinen'
export const RETRY_JOB_KIND = 'geraet-nochmal'
export const ROUTINE_JOB_KIND = 'geraete-routine'
/** Rückgängig ist 5 Minuten gültig. */
export const UNDO_MS = 5 * 60_000
/** Länger als 12 Stunden wird nicht auf „wieder erreichbar“ gewartet. */
export const RETRY_MAX_MS = 12 * 60 * 60_000
const PREVIEW_TTL_MS = 10 * 60_000
const ROUTINE_ENDE_TTL_MS = 24 * 60 * 60_000
const PLAN_REF = /^sp-[a-f0-9]{12}$/

export interface Ziel { deviceId: string; functionId: string; on: boolean; name: string; raum?: string; art: 'licht' | 'schalter'; vorher?: boolean }
export type PlanArt = 'schalten' | 'rueckgaengig' | 'nochmal' | 'neu-verbinden' | 'raumwahl' | 'routine' | 'routine-ende'
export type PlanStatus = 'offen' | 'wartet' | 'laeuft' | 'erledigt' | 'fehlgeschlagen' | 'abgelehnt'
export interface SchaltPlan {
    id: string
    art: PlanArt
    /** Wer gefragt hat (Prinzipal des Chats). */
    owner: string
    /** Wer das Ja gedrückt hat (Kanal:Id). */
    bestaetigtVon?: string
    ziele: Ziel[]
    satz: string
    status: PlanStatus
    createdAt: string
    /** Raumwahl: gemeinsame Frage aller Knöpfe. */
    frage?: string
    /** Routine: HH:MM; Routine-Ende: Routine-Id. */
    routineZeit?: string
    routineId?: string
    jobId?: string
    ablaufAt?: string
    versuchtAt?: string
    ergebnis?: string
}

export interface SchaltErgebnis { ok: boolean; vorher?: boolean; fehler?: unknown; vorbereitet: boolean }
export interface SchaltDeps {
    dataDir: string
    now?: () => number
    cardOpts?: CardStoreOptions
    /** Ein Ziel über den bestehenden Schaltweg (Standard: propose → confirm → execute). */
    schalte?: (ziel: Ziel, approver: Approver) => Promise<SchaltErgebnis>
    /** Lesend: ist das Gerät wieder erreichbar? (Standard: Bestand nur dieses Geräts neu lesen). */
    erreichbar?: (ziel: Ziel) => Promise<boolean>
    /** Karte anbieten (Standard: offerCard → sofort zustellen). */
    offer?: (input: NewCardInput) => Promise<{ ok: boolean; card?: ApprovalCard }> | { ok: boolean; card?: ApprovalCard }
    /** Planer (Standard: die laufende Planer-Laufzeit). */
    planer?: () => Planner | null | Promise<Planner | null>
    /** Anmeldung abgelaufen: die Verbinden-Karte des Geräts (Standard: device-connect). */
    neuVerbinden?: (deviceId: string) => Promise<{ ok: boolean; message: string }>
    timeZone?: string
}

const nowOf = (deps: SchaltDeps) => (deps.now || Date.now)()
const iso = (ms: number) => new Date(ms).toISOString()

// ---------------------------------------------------------------------------
// Plan-Ablage (sensing/schalt-plaene.json)
// ---------------------------------------------------------------------------

const planFile = (dataDir: string) => join(dataDir, 'sensing', 'schalt-plaene.json')
export function ladePlaene(dataDir: string): SchaltPlan[] {
    try {
        const raw = JSON.parse(readFileSync(planFile(dataDir), 'utf8'))
        return raw?.version === 1 && Array.isArray(raw.plaene) ? raw.plaene.filter((p: SchaltPlan) => p && PLAN_REF.test(p.id)) : []
    } catch { return [] }
}
function speicherePlaene(dataDir: string, plaene: SchaltPlan[]): void {
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    const offen = plaene.filter(p => p.status === 'offen' || p.status === 'wartet' || p.status === 'laeuft')
    const rest = plaene.filter(p => !offen.includes(p)).slice(-200)
    atomicWriteJsonSync(planFile(dataDir), { version: 1, plaene: [...rest, ...offen].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })
}
function neuerPlan(deps: SchaltDeps, input: Omit<SchaltPlan, 'id' | 'createdAt' | 'status'> & { status?: PlanStatus }): SchaltPlan {
    const plan: SchaltPlan = { status: 'offen', ...input, id: `sp-${randomBytes(6).toString('hex')}`, createdAt: iso(nowOf(deps)) }
    speicherePlaene(deps.dataDir, [...ladePlaene(deps.dataDir), plan])
    return plan
}
function aenderePlan(dataDir: string, id: string, patch: Partial<SchaltPlan>): SchaltPlan | undefined {
    const plaene = ladePlaene(dataDir)
    const index = plaene.findIndex(p => p.id === id)
    if (index < 0) return undefined
    plaene[index] = { ...plaene[index], ...patch, id: plaene[index].id }
    speicherePlaene(dataDir, plaene)
    return plaene[index]
}
export const findePlan = (dataDir: string, id: string) => ladePlaene(dataDir).find(p => p.id === id)

// ---------------------------------------------------------------------------
// Owner / Freigabe
// ---------------------------------------------------------------------------

const rohId = (id: unknown) => String(id ?? '').trim().replace(/^(?:telegram|desktop|even-g2):/, '')

/**
 * Der Schaltweg verlangt dieselbe Identität, die das Gerät freigegeben hat.
 * Ein Ja kommt als `telegram:<id>`, ein Chat-Befehl als Prinzipal `<id>`:
 * beides ist derselbe Owner, wenn die rohe Id gleich ist. Selbst-lesend
 * eingebundene Geräte (`auto:lesend`) passen nie.
 */
export function freigabeFuer(d: DeviceRecord | undefined, kandidaten: readonly unknown[]): Approver | null {
    if (!d?.approvedBy || d.status !== 'eingerichtet') return null
    const roh = rohId(d.approvedBy)
    if (!roh || roh.startsWith('auto:')) return null
    return kandidaten.some(k => rohId(k) === roh) ? { principalId: d.approvedBy, permission: 'owner' } : null
}

// ---------------------------------------------------------------------------
// Ausführen
// ---------------------------------------------------------------------------

interface Ausgang { ok: Ziel[]; fehl: Array<{ ziel: Ziel; ursache: FehlerUrsache }> }

async function fuehreAus(deps: SchaltDeps, ziele: readonly Ziel[], kandidaten: readonly unknown[]): Promise<Ausgang> {
    const out: Ausgang = { ok: [], fehl: [] }
    const schalte = deps.schalte || productionSchalte(deps.dataDir)
    for (const ziel of ziele.slice(0, 50)) {
        const d = loadDevices(deps.dataDir).find(item => item.id === ziel.deviceId)
        if (!d || d.status !== 'eingerichtet') { out.fehl.push({ ziel, ursache: 'anmeldung' }); continue }
        const approver = freigabeFuer(d, kandidaten)
        // Ein anderes Konto hat das Gerät freigegeben: ehrlich „weiß nicht“, kein Wiederholen.
        if (!approver) { out.fehl.push({ ziel, ursache: 'unbekannt' }); continue }
        let r: SchaltErgebnis
        try { r = await schalte(ziel, approver) } catch (error) { r = { ok: false, fehler: error, vorbereitet: true } }
        if (r.ok) { out.ok.push({ ...ziel, ...(typeof r.vorher === 'boolean' ? { vorher: r.vorher } : {}) }); continue }
        const ursache = r.fehler !== undefined ? fehlerUrsache(r.fehler) : r.vorbereitet ? 'unbekannt' : bestandsUrsache(deps.dataDir, ziel.deviceId, ziel.functionId)
        out.fehl.push({ ziel, ursache })
    }
    return out
}

async function karte(deps: SchaltDeps, input: NewCardInput): Promise<ApprovalCard | undefined> {
    if (deps.offer) return (await deps.offer(input)).card
    const { offerCard } = await import('../core/approval-card-sources.js')
    const result = offerCard(input, deps.cardOpts || { dataDir: deps.dataDir })
    return result.ok ? result.card : undefined
}

const basisKarte = (plan: SchaltPlan) => ({ art: SCHALT_KIND, aktion: { kind: SCHALT_KIND, ref: plan.id }, wirkung: 'physisch' as const, quelle: 'geraete', node: 'main' })

async function vorschauKarte(deps: SchaltDeps, plan: SchaltPlan): Promise<ApprovalCard | undefined> {
    // 2.86: the owner just asked for exactly this — a direct answer, not behind older questions.
    const card = await karte(deps, { ...basisKarte(plan), titel: plan.satz, ablaufMs: PREVIEW_TTL_MS, direkteAntwort: true,
        beleg: 'Du hast es eben gesagt. Erst dein Ja schaltet, nur genau das.', vorschlag: 'Ja = jetzt schalten. Nein = nichts passiert.' })
    return card
}

/**
 * Nach einem Schaltlauf: Ergebnis in Alltagssprache, Rückgängig-Knopf (nur
 * mit gelesenem Vorher-Zustand) und — bei einem Fehlschlag — EIN Angebot.
 */
async function nachAusfuehrung(deps: SchaltDeps, plan: SchaltPlan, ausgang: Ausgang, opts: { rueckgaengig: boolean }): Promise<{ ok: boolean; text: string }> {
    const teile: string[] = []
    if (ausgang.ok.length) teile.push(`Erledigt: ${schaltTeil(ausgang.ok)}.`)
    if (opts.rueckgaengig && ausgang.ok.length) {
        const zurueck = ausgang.ok.filter(z => typeof z.vorher === 'boolean' && z.vorher !== z.on).map(z => ({ ...z, on: z.vorher as boolean, vorher: undefined }))
        const ohneZustand = ausgang.ok.filter(z => typeof z.vorher !== 'boolean')
        if (zurueck.length) {
            const undo = neuerPlan(deps, { art: 'rueckgaengig', owner: plan.owner, bestaetigtVon: plan.bestaetigtVon, ziele: zurueck, satz: `Ich schalte ${schaltTeil(zurueck)} — wieder wie vorher.` })
            const card = await karte(deps, { ...basisKarte(undo), titel: 'Rückgängig?', ablaufMs: UNDO_MS, knopf: '↩️ Rückgängig', einKnopf: true,
                beleg: 'So war es direkt vor dem Schalten (vom Gerät gelesen).', vorschlag: undo.satz })
            teile.push(card ? 'Rückgängig geht 5 Minuten lang.' : '')
        }
        if (ohneZustand.length) teile.push(`Rückgängig gibt es für ${ohneZustand.map(z => geraetAnzeige(z.name, z.raum)).slice(0, 3).join(', ')} nicht, weil es seinen Zustand nicht meldet.`)
    }
    if (ausgang.fehl.length) {
        const erste = ausgang.fehl[0].ursache
        const gruppe = ausgang.fehl.filter(f => f.ursache === erste).map(f => f.ziel)
        const name = gruppe.length === 1 ? geraetAnzeige(gruppe[0].name, gruppe[0].raum) : `${gruppe.length} Geräte`
        const schritt = naechsterSchritt(erste, name)
        teile.push(schritt.satz)
        if (schritt.angebot === 'wenn-erreichbar') {
            const nochmal = neuerPlan(deps, { art: 'nochmal', owner: plan.owner, bestaetigtVon: plan.bestaetigtVon, ziele: gruppe.map(z => ({ ...z, vorher: undefined })), satz: schritt.satz })
            await karte(deps, { ...basisKarte(nochmal), titel: schritt.satz, ablaufMs: 6 * 60 * 60_000, knopf: schritt.knopf, einKnopf: true,
                beleg: 'Ich prüfe nur lesend, ob es wieder da ist, und versuche es dann genau einmal.', vorschlag: `Ja = ${schaltTeil(gruppe)}, sobald es wieder erreichbar ist.` })
        } else if (schritt.angebot === 'neu-verbinden') {
            const neu = neuerPlan(deps, { art: 'neu-verbinden', owner: plan.owner, bestaetigtVon: plan.bestaetigtVon, ziele: gruppe.slice(0, 1), satz: schritt.satz })
            await karte(deps, { ...basisKarte(neu), titel: schritt.satz, ablaufMs: 24 * 60 * 60_000, knopf: schritt.knopf, einKnopf: true,
                beleg: 'Ohne neue Anmeldung kann ich es nicht schalten.', vorschlag: 'Ja = ich bereite das Verbinden vor; du bestätigst es dann einmal.' })
        }
    }
    return { ok: ausgang.fehl.length === 0, text: teile.filter(Boolean).join(' ') }
}

// ---------------------------------------------------------------------------
// Karten-Antworten
// ---------------------------------------------------------------------------

async function planer(deps: SchaltDeps): Promise<Planner | null> {
    if (deps.planer) return deps.planer()
    try { const { getPlannerRuntime } = await import('../planner/runtime.js'); return getPlannerRuntime()?.planner ?? null } catch { return null }
}

const zielZuRoutine = (dataDir: string, z: Ziel): RoutineZiel | null => {
    const d = loadDevices(dataDir).find(item => item.id === z.deviceId)
    if (!d?.approvedAt) return null
    return { deviceId: z.deviceId, functionId: z.functionId, on: z.on, name: z.name, ...(z.raum ? { raum: z.raum } : {}), art: z.art, approvedAt: d.approvedAt, fingerprint: sensingDeviceFingerprint(d) }
}

export function routineJob(routine: GeraeteRoutine, timeZone?: string) {
    return { kind: ROUTINE_JOB_KIND, title: `Geräte-Routine ${routine.zeit}`, idKey: `geraete-routine:${routine.id}`,
        schedule: { type: 'taeglich' as const, time: routine.zeit, ...(timeZone ? { timeZone } : {}) }, delivers: true, mainOnly: true,
        payload: { routineId: routine.id }, maxLateMinutes: 30, expiresAfterMinutes: 120 }
}

/** Ja auf einer Karte dieser Art. */
export async function beantworteJa(deps: SchaltDeps, ref: string, decidedBy: string): Promise<CardExecutionResult> {
    if (!PLAN_REF.test(String(ref || ''))) return { ok: false, message: 'Unbekannte Aktion — nichts geschaltet.' }
    const plan = findePlan(deps.dataDir, ref)
    if (!plan || plan.status !== 'offen') return { ok: false, message: 'Das ist schon erledigt — nichts geschaltet.' }
    const now = nowOf(deps)
    const kandidaten = [plan.owner, decidedBy]
    // Zustand vor jedem Warten speichern: ein zweiter Druck oder ein Neustart schaltet nie doppelt.
    aenderePlan(deps.dataDir, plan.id, { status: 'laeuft', bestaetigtVon: decidedBy })
    const fertig = (status: PlanStatus, message: string, ok = status === 'erledigt'): CardExecutionResult => {
        aenderePlan(deps.dataDir, plan.id, { status, ergebnis: message.slice(0, 300) })
        return { ok, message }
    }
    switch (plan.art) {
        case 'schalten': {
            const ausgang = await fuehreAus(deps, plan.ziele, kandidaten)
            const nach = await nachAusfuehrung(deps, { ...plan, bestaetigtVon: decidedBy }, ausgang, { rueckgaengig: true })
            return fertig(nach.ok ? 'erledigt' : 'fehlgeschlagen', nach.text, nach.ok)
        }
        case 'rueckgaengig': {
            if (now - Date.parse(plan.createdAt) > UNDO_MS) return fertig('fehlgeschlagen', 'Rückgängig ist nur 5 Minuten möglich — nichts geschaltet.', false)
            const ausgang = await fuehreAus(deps, plan.ziele, kandidaten)
            const nach = await nachAusfuehrung(deps, { ...plan, bestaetigtVon: decidedBy }, ausgang, { rueckgaengig: false })
            return fertig(nach.ok ? 'erledigt' : 'fehlgeschlagen', nach.ok ? `Wieder wie vorher: ${schaltTeil(ausgang.ok)}.` : nach.text, nach.ok)
        }
        case 'nochmal': {
            const p = await planer(deps)
            if (!p) return fertig('fehlgeschlagen', 'Ich kann gerade nicht warten (der Planer ist aus). Sag es mir bitte später nochmal.', false)
            const job = p.addJob({ kind: RETRY_JOB_KIND, title: 'Nochmal versuchen, wenn erreichbar', idKey: `nochmal:${plan.id}`, schedule: { type: 'intervall', minutes: 1 },
                delivers: true, mainOnly: true, payload: { planId: plan.id } })
            aenderePlan(deps.dataDir, plan.id, { status: 'wartet', bestaetigtVon: decidedBy, jobId: job.id, ablaufAt: iso(now + RETRY_MAX_MS) })
            const name = plan.ziele.length === 1 ? geraetAnzeige(plan.ziele[0].name, plan.ziele[0].raum) : `${plan.ziele.length} Geräte`
            return { ok: true, message: `Gut. Sobald ${name} wieder erreichbar ist, versuche ich es genau einmal und sage dir Bescheid (ich warte höchstens 12 Stunden).` }
        }
        case 'neu-verbinden': {
            const deviceId = plan.ziele[0]?.deviceId
            const run = deps.neuVerbinden || (async (id: string) => {
                const { offerDeviceConnection, productionDeviceConnectDeps } = await import('./device-connect.js')
                return offerDeviceConnection(await productionDeviceConnectDeps(), id)
            })
            const result = deviceId ? await run(deviceId) : { ok: false, message: 'Gerät unbekannt.' }
            return fertig(result.ok ? 'erledigt' : 'fehlgeschlagen', result.ok ? 'Die Karte zum neu Verbinden ist unterwegs.' : `Neu verbinden geht gerade nicht: ${result.message}`, result.ok)
        }
        case 'raumwahl': {
            for (const other of ladePlaene(deps.dataDir).filter(p => p.frage === plan.frage && p.id !== plan.id && p.status === 'offen')) aenderePlan(deps.dataDir, other.id, { status: 'erledigt', ergebnis: 'andere Wahl' })
            const naechster = neuerPlan(deps, { art: plan.routineZeit ? 'routine' : 'schalten', owner: plan.owner, ziele: plan.ziele, satz: plan.routineZeit ? routineSatz(plan.routineZeit, plan.ziele) : vorschauSatz(plan.ziele), ...(plan.routineZeit ? { routineZeit: plan.routineZeit } : {}) })
            const card = naechster.art === 'routine' ? await routineKarte(deps, naechster) : await vorschauKarte(deps, naechster)
            return fertig('erledigt', card ? `Gut. ${naechster.satz} Bitte noch einmal Ja.` : 'Die Vorschau konnte ich nicht schicken — nichts geschaltet.', Boolean(card))
        }
        case 'routine': {
            const p = await planer(deps)
            if (!p || !plan.routineZeit) return fertig('fehlgeschlagen', 'Ich kann gerade keine Routine anlegen (der Planer ist aus). Nichts gespeichert.', false)
            const ziele = plan.ziele.map(z => zielZuRoutine(deps.dataDir, z)).filter((z): z is RoutineZiel => Boolean(z))
            if (!ziele.length) return fertig('fehlgeschlagen', 'Die Geräte sind nicht mehr freigegeben. Nichts gespeichert.', false)
            const routine = neueRoutine(deps.dataDir, { zeit: plan.routineZeit, ziele, satz: plan.satz, owner: plan.owner, bestaetigtVon: decidedBy }, now)
            const job = p.addJob(routineJob(routine, deps.timeZone))
            aendereRoutine(deps.dataDir, routine.id, { jobId: job.id })
            return fertig('erledigt', `Gespeichert: ${plan.satz} Beenden geht jederzeit unter „Routinen“.`)
        }
        case 'routine-ende': {
            const routine = plan.routineId ? ladeRoutinen(deps.dataDir).find(r => r.id === plan.routineId) : undefined
            if (!routine || routine.status !== 'aktiv') return fertig('erledigt', 'Diese Routine läuft schon nicht mehr.')
            aendereRoutine(deps.dataDir, routine.id, { status: 'beendet', beendetAt: iso(now) })
            const p = await planer(deps)
            if (p && routine.jobId) p.completeJob(routine.jobId, 'beendet')
            return fertig('erledigt', `Beendet: ${routine.satz}`)
        }
    }
    return fertig('fehlgeschlagen', 'Unbekannte Aktion — nichts geschaltet.', false)
}

/** Nein auf einer Karte dieser Art: nichts passiert; eine Raumfrage schließt ganz. */
export async function beantworteNein(deps: SchaltDeps, ref: string): Promise<CardExecutionResult> {
    const plan = PLAN_REF.test(String(ref || '')) ? findePlan(deps.dataDir, ref) : undefined
    if (!plan) return { ok: true, message: 'Gut, nichts passiert.' }
    const betroffen = plan.frage ? ladePlaene(deps.dataDir).filter(p => p.frage === plan.frage && p.status === 'offen') : [plan]
    for (const p of betroffen) aenderePlan(deps.dataDir, p.id, { status: 'abgelehnt' })
    return { ok: true, message: plan.art === 'routine-ende' ? 'Gut, die Routine bleibt.' : 'Gut, nichts geschaltet.' }
}

export function createSchaltExecutor(deps: SchaltDeps | (() => SchaltDeps)): CardExecutor {
    const get = () => typeof deps === 'function' ? deps() : deps
    return {
        kind: SCHALT_KIND,
        impact: 'physisch',
        allowAlways: () => false,
        async execute(card, _answer, ctx) { return beantworteJa(get(), card.aktion.ref, ctx.decidedBy) },
        async reject(card) { return beantworteNein(get(), card.aktion.ref) },
        isStillOpen(card) { return findePlan(get().dataDir, card.aktion.ref)?.status === 'offen' },
    }
}

// ---------------------------------------------------------------------------
// Sätze aus dem Chat
// ---------------------------------------------------------------------------

const alsZiel = (f: RaumFunktion, on: boolean): Ziel => ({ deviceId: f.deviceId!, functionId: f.functionId, on, name: f.name, ...(f.raum ? { raum: f.raum } : {}), art: f.art })

function routineSatz(zeit: string, ziele: readonly Ziel[]): string {
    return `Jeden Tag um ${zeit} schalte ich ${schaltTeil(ziele)} — nur genau das.`.slice(0, 360)
}

async function routineKarte(deps: SchaltDeps, plan: SchaltPlan): Promise<ApprovalCard | undefined> {
    return karte(deps, { ...basisKarte(plan), titel: plan.satz, ablaufMs: 24 * 60 * 60_000, direkteAntwort: true,
        beleg: 'Dein Ja gilt nur für genau diese Routine. Kommt später ein Gerät dazu, gehört es nicht dazu.', vorschlag: 'Ja = Routine speichern. Nein = nichts passiert.' })
}

async function frageKarten(deps: SchaltDeps, principal: string, frage: string, optionen: Array<{ label: string; ziele: Ziel[] }>, routineZeit?: string): Promise<boolean> {
    const frageId = `f-${randomBytes(5).toString('hex')}`
    let created = 0
    for (const option of optionen) {
        const plan = neuerPlan(deps, { art: 'raumwahl', owner: principal, ziele: option.ziele, satz: frage, frage: frageId, ...(routineZeit ? { routineZeit } : {}) })
        const card = await karte(deps, { ...basisKarte(plan), titel: frage, ablaufMs: PREVIEW_TTL_MS, buendel: RAUMWAHL_BUENDEL, gruppe: frageId, knopf: option.label.slice(0, 24), kurz: frage,
            beleg: 'Ich schalte nichts, bevor klar ist, was du meinst.', vorschlag: `${option.label}: ${schaltTeil(option.ziele)}` })
        if (card) created++
    }
    return created > 0
}

/**
 * „Licht im Wohnzimmer aus“ aus dem Chat (Owner). Antwort '' = kein fester
 * Schaltsatz bzw. nichts Passendes gefunden → das Gespräch geht normal weiter.
 */
export async function sagSchalten(deps: SchaltDeps, text: string, principal: string): Promise<string> {
    const routine = parseRoutineSatz(text)
    const satz: SchaltSatz | null = routine ? routine.satz : parseSchaltSatz(text)
    if (!satz) return ''
    const aufl = loeseAuf(raumIndex(deps.dataDir), satz)
    if (aufl.art === 'nichts') return aufl.satz
    if (aufl.art === 'nicht-schaltbar') return aufl.satz
    if (aufl.art === 'wahl') {
        const ok = await frageKarten(deps, principal, routine ? `${aufl.frage} (Routine um ${routine.zeit})` : aufl.frage,
            aufl.optionen.map(o => ({ label: o.label, ziele: o.ziele.map(f => alsZiel(f, satz.on)) })), routine?.zeit)
        return ok ? `${aufl.frage} Ich habe dir die Knöpfe geschickt.` : 'Die Rückfrage konnte ich nicht schicken — nichts geschaltet.'
    }
    const ziele = aufl.ziele.map(f => alsZiel(f, satz.on))
    if (routine) {
        const plan = neuerPlan(deps, { art: 'routine', owner: principal, ziele, satz: routineSatz(routine.zeit, ziele), routineZeit: routine.zeit })
        const card = await routineKarte(deps, plan)
        return card ? `Vorschau: ${plan.satz} Bitte auf der Karte Ja oder Nein.` : 'Die Vorschau konnte ich nicht schicken — nichts gespeichert.'
    }
    const plan = neuerPlan(deps, { art: 'schalten', owner: principal, ziele, satz: vorschauSatz(ziele) })
    const card = await vorschauKarte(deps, plan)
    return card ? `${plan.satz} Bitte auf der Karte Ja oder Nein.` : 'Die Vorschau konnte ich nicht schicken — nichts geschaltet.'
}

/** Routinen-Liste mit je einem Knopf „Beenden“ (Bündel `routinen`). */
export async function routinenListe(deps: SchaltDeps, principal: string): Promise<string> {
    const routinen = aktiveRoutinen(deps.dataDir)
    if (!routinen.length) return 'Du hast noch keine Geräte-Routinen. Sag zum Beispiel: „Jeden Abend um 23 Uhr alles aus“.'
    for (const routine of routinen.slice(0, 20)) {
        const offen = ladePlaene(deps.dataDir).some(p => p.art === 'routine-ende' && p.routineId === routine.id && p.status === 'offen')
        if (offen) continue
        const plan = neuerPlan(deps, { art: 'routine-ende', owner: principal, ziele: [], satz: routine.satz, routineId: routine.id })
        await karte(deps, { ...basisKarte(plan), titel: 'Routine beenden?', ablaufMs: ROUTINE_ENDE_TTL_MS, buendel: ROUTINEN_BUENDEL, gruppe: plan.id, knopf: 'Beenden', direkteAntwort: true,
            kurz: routine.satz.replace(/ — nur genau das\.$/, ''), beleg: 'Beenden = die Routine schaltet ab sofort nichts mehr.', vorschlag: routine.satz })
    }
    return [`Deine Geräte-Routinen (${routinen.length}):`, ...routinen.slice(0, 20).map((r, i) => `${i + 1}. ${r.satz.replace(/ — nur genau das\.$/, '')}`), 'Zum Beenden den Knopf an der Routine drücken.'].join('\n')
}

// ---------------------------------------------------------------------------
// Planer-Jobs
// ---------------------------------------------------------------------------

/** Wartet lesend auf „wieder erreichbar“ und versucht die freigegebene Aktion GENAU einmal. */
export function createRetryHandler(getDeps: () => SchaltDeps, getPlanner: () => Planner | null): JobHandler {
    return {
        async run(job: PlannerJob, ctx) {
            const deps = getDeps()
            const plan = findePlan(deps.dataDir, String(job.payload?.planId || ''))
            const fertig = () => { try { getPlanner()?.completeJob(job.id, 'fertig') } catch { /* nächster Lauf */ } }
            if (!plan || plan.art !== 'nochmal' || plan.status !== 'wartet') { fertig(); return { summary: 'nichts mehr zu tun' } }
            const name = plan.ziele.length === 1 ? geraetAnzeige(plan.ziele[0].name, plan.ziele[0].raum) : `${plan.ziele.length} Geräte`
            if (ctx.now > Date.parse(plan.ablaufAt || '')) {
                aenderePlan(deps.dataDir, plan.id, { status: 'fehlgeschlagen', ergebnis: 'zu lange nicht erreichbar' })
                return { summary: 'aufgegeben', outgoing: { kind: 'job', title: 'Gerät', text: `Ich habe 12 Stunden gewartet, ${name} war nicht erreichbar. Nichts geschaltet.`, urgency: 'normal' } }
            }
            let da = false
            try { da = await (deps.erreichbar || productionErreichbar(deps.dataDir))(plan.ziele[0]) } catch { da = false }
            if (!da) return { summary: 'wartet auf erreichbar' }
            // genau einmal: der Versuch ist gespeichert, bevor geschaltet wird
            aenderePlan(deps.dataDir, plan.id, { status: 'laeuft', versuchtAt: iso(ctx.now) })
            const ausgang = await fuehreAus(deps, plan.ziele, [plan.owner, plan.bestaetigtVon])
            const nach = await nachAusfuehrung(deps, plan, ausgang, { rueckgaengig: true })
            aenderePlan(deps.dataDir, plan.id, { status: nach.ok ? 'erledigt' : 'fehlgeschlagen', ergebnis: nach.text.slice(0, 300) })
            return { summary: nach.ok ? 'nachgeholt' : 'nochmal fehlgeschlagen', ok: nach.ok, outgoing: { kind: 'job', title: 'Gerät', text: `${name} ist wieder da. ${nach.text}`, urgency: 'normal' } }
        },
    }
}

/** Eine tägliche Routine: nur die Ziele des Ja, jedes nur bei unveränderter Freigabe. */
export function createRoutineHandler(getDeps: () => SchaltDeps, getPlanner: () => Planner | null): JobHandler {
    return {
        async run(job: PlannerJob) {
            const deps = getDeps()
            const routine = ladeRoutinen(deps.dataDir).find(r => r.id === String(job.payload?.routineId || ''))
            if (!routine || routine.status !== 'aktiv') { try { getPlanner()?.completeJob(job.id, 'beendet') } catch { /* nächster Lauf */ } return { summary: 'Routine beendet' } }
            const devices = loadDevices(deps.dataDir)
            const gueltig: Ziel[] = [], geaendert: RoutineZiel[] = []
            for (const z of routine.ziele) {
                const d = devices.find(item => item.id === z.deviceId)
                if (d && d.status === 'eingerichtet' && d.approvedAt === z.approvedAt && sensingDeviceFingerprint(d) === z.fingerprint) gueltig.push({ deviceId: z.deviceId, functionId: z.functionId, on: z.on, name: z.name, ...(z.raum ? { raum: z.raum } : {}), art: z.art })
                else geaendert.push(z)
            }
            const ausgang = await fuehreAus(deps, gueltig, [routine.owner, routine.bestaetigtVon])
            const teile: string[] = []
            if (ausgang.fehl.length) {
                const plan: SchaltPlan = { id: 'sp-000000000000', art: 'schalten', owner: routine.owner, bestaetigtVon: routine.bestaetigtVon, ziele: [], satz: routine.satz, status: 'erledigt', createdAt: iso(nowOf(deps)) }
                teile.push((await nachAusfuehrung(deps, plan, ausgang, { rueckgaengig: false })).text)
            }
            if (geaendert.length) teile.push(`${geaendert.map(z => geraetAnzeige(z.name, z.raum)).slice(0, 3).join(', ')} habe ich ausgelassen, weil sich die Freigabe geändert hat. Wenn es wieder dazugehören soll: Routine neu sagen.`)
            const summary = `${ausgang.ok.length} geschaltet, ${ausgang.fehl.length} fehlgeschlagen, ${geaendert.length} ausgelassen`
            // Meldung nur, wenn etwas nicht geklappt hat (sonst steht es im Protokoll).
            return teile.length ? { summary, ok: !ausgang.fehl.length, outgoing: { kind: 'job', title: `Routine ${routine.zeit}`, text: `Routine ${routine.zeit}: ${teile.join(' ')}`, urgency: 'normal' } } : { summary }
        },
    }
}

/** Planer-Laufzeit: beide Job-Arten registrieren (nur der Main führt mainOnly-Jobs aus). */
export function registerDeviceJobs(planner: Planner, getDeps: () => SchaltDeps): void {
    planner.register(RETRY_JOB_KIND, createRetryHandler(getDeps, () => planner))
    planner.register(ROUTINE_JOB_KIND, createRoutineHandler(getDeps, () => planner))
}

// ---------------------------------------------------------------------------
// Produktionswege (lesen/schalten nur über die bestehenden Module)
// ---------------------------------------------------------------------------

function productionSchalte(dataDir: string) {
    return async (ziel: Ziel, approver: Approver): Promise<SchaltErgebnis> => {
        const { proposeSmartSwitch, confirmSmartSwitch } = await import('./smart-control.js')
        const { executeSmartSwitch } = await import('./smart-control-http.js')
        const { getServiceFencingToken, MAIN_SERVICE } = await import('../mesh/leader-election.js')
        const action = { deviceId: ziel.deviceId, functionId: ziel.functionId, on: ziel.on }
        let proposed = proposeSmartSwitch(dataDir, action, approver)
        if (!proposed.ok) {
            // Bestand älter als zwei Minuten: nur dieses Gerät lesend neu lesen, dann einmal neu vorbereiten.
            try { const { refreshDirectInventory } = await import('./direct-smart-devices.js'); await refreshDirectInventory(dataDir, AbortSignal.timeout(10_000), { only: ziel.deviceId }) } catch { /* Ursache aus dem Bestand */ }
            proposed = proposeSmartSwitch(dataDir, action, approver)
        }
        if (!proposed.ok || !proposed.proposal) return { ok: false, vorbereitet: false }
        let vorher: boolean | undefined, fehler: unknown
        const result = await confirmSmartSwitch(dataDir, proposed.proposal.id, approver, () => Boolean(getServiceFencingToken(MAIN_SERVICE)),
            async (d, a, signal, authorize) => {
                try { return await executeSmartSwitch(dataDir, d, a, signal, authorize, { onBefore: value => { vorher = value } }) } catch (error) { fehler = error; throw error }
            })
        return { ok: result.ok, vorbereitet: true, ...(typeof vorher === 'boolean' ? { vorher } : {}), ...(fehler !== undefined ? { fehler } : {}) }
    }
}

function productionErreichbar(dataDir: string) {
    return async (ziel: Ziel): Promise<boolean> => {
        const { refreshDirectInventory } = await import('./direct-smart-devices.js')
        const rows = await refreshDirectInventory(dataDir, AbortSignal.timeout(15_000), { only: ziel.deviceId })
        const row = rows.find(r => r.deviceId === ziel.deviceId)
        const f = row?.functions.find(item => item.id === ziel.functionId)
        return row?.status === 'ok' && Boolean(f) && f!.available !== false
    }
}

/** Produktions-Abhängigkeiten (Main). */
export async function productionSchaltDeps(): Promise<SchaltDeps> {
    const { getNovaDataDir } = await import('../core/data-root.js')
    return { dataDir: getNovaDataDir() }
}
