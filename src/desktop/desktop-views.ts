/**
 * Lesesichten fuer Xaventra Desktop (Redesign): Heute, Arbeit, System,
 * Gedaechtnis. Die App ist ein Fenster zum Mitschauen und Knoepfe-Druecken;
 * diese Datei liest nur vorhandene Module (now-view, Knopf-Karten, Planer,
 * Missionen/Verantwortungen, Auftraege, Delegation, Waechter, Proxmox,
 * Entscheidungen, Werkzeug-Schmiede, Desktop-Direkt) und gibt typisierte,
 * gekuerzte Daten ohne Geheimnisse zurueck. Einzige Schreibstelle: eine
 * Karten-Antwort, und die laeuft durch answerApprovalCard (Owner, Einmal-Token).
 *
 * Jede Quelle ist optional: faellt eine aus, bleibt die Sicht stehen und
 * nennt den Grund, statt die ganze Seite zu verlieren.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../security/secret-redaction.js'
import { getNovaDataDir } from '../core/data-root.js'
import { answerApprovalCard, listApprovalCards, type ApprovalCard, type CardAnswer, type CardStoreOptions } from '../core/approval-cards.js'

export interface ViewOptions extends CardStoreOptions { dataDir?: string; now?: () => number }

const DAY_MS = 24 * 60 * 60_000
export const DESKTOP_CARD_ID = /^k[a-f0-9]{12}$/

/** Short, single-line, redacted text for every free-form field leaving the Core. */
export function clean(value: unknown, max = 400): string {
    if (value === undefined || value === null) return ''
    return redactSecrets(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

const iso = (value: unknown): string | null => {
    const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

async function attempt<T>(label: string, work: () => T | Promise<T>, problems: string[]): Promise<T | null> {
    try { return await work() } catch (error) {
        problems.push(`${label}: ${clean((error as Error)?.message || error, 160)}`)
        return null
    }
}

// ---------------------------------------------------------------------------
// Knopf-Karten
// ---------------------------------------------------------------------------

export interface DesktopCard {
    id: string
    art: string
    titel: string
    beleg: string
    vorschlag: string
    wirkung: string
    node: string
    quelle: string
    status: string
    createdAt: string | null
    expiresAt: string | null
    /** Which answers this card offers right now. Never the button tokens. */
    antworten: CardAnswer[]
    zustellung: 'bericht' | 'sofort'
    decidedAt: string | null
    antwort: string | null
    entschiedenUeber: string | null
    ergebnis: { ok: boolean; text: string } | null
}

/** Public card: no button tokens, no used tokens, no Telegram chat/message ids, no owner id. */
export function publicCard(card: ApprovalCard): DesktopCard {
    return {
        id: clean(card.id, 40), art: clean(card.art, 60), titel: clean(card.titel, 200), beleg: clean(card.beleg, 1200),
        vorschlag: clean(card.vorschlag, 600), wirkung: clean(card.wirkung, 20), node: clean(card.node, 80), quelle: clean(card.quelle, 80),
        status: clean(card.status, 20), createdAt: iso(card.createdAt), expiresAt: iso(card.expiresAt),
        antworten: card.status === 'offen' ? card.buttons.map(button => button.answer) : [],
        zustellung: card.zustellung === 'bericht' ? 'bericht' : 'sofort',
        decidedAt: iso(card.decidedAt), antwort: card.answer ? clean(card.answer, 20) : null,
        // Only the channel ("telegram", "even-g2", "desktop"), never the numeric owner id.
        entschiedenUeber: card.decidedBy ? clean(String(card.decidedBy).split(':')[0], 20) : null,
        ergebnis: card.result ? { ok: card.result.ok === true, text: clean(card.result.message, 400) } : null,
    }
}

/**
 * Owner answers a card in the Desktop app. Exactly the Telegram/Even-G2 path:
 * the card's own single-use button token goes through answerApprovalCard with
 * a configured numeric owner id; the first answer consumes every button.
 */
export async function answerCardFromDesktop(cardId: string, answer: unknown, opts: CardStoreOptions & { ownerIds: readonly string[] }): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!['ja', 'nein', 'spaeter', 'immer'].includes(String(answer))) return { status: 400, body: { ok: false, error: 'Antwort muss ja, nein, spaeter oder immer sein.' } }
    if (!DESKTOP_CARD_ID.test(String(cardId ?? ''))) return { status: 404, body: { ok: false, error: 'Unbekannte Karte.' } }
    const ownerIds = (opts.ownerIds || []).map(item => String(item).trim()).filter(item => /^\d{1,20}$/.test(item))
    if (!ownerIds.length) return { status: 403, body: { ok: false, error: 'Kein Owner konfiguriert (channels.telegram.allowFrom).' } }
    const card = listApprovalCards(opts).find(item => item.id === cardId)
    if (!card) return { status: 404, body: { ok: false, error: 'Unbekannte Karte.' } }
    const button = card.status === 'offen' ? card.buttons.find(item => item.answer === answer) : undefined
    if (!button) return { status: 409, body: { ok: false, error: card.status === 'offen' ? 'Diese Antwort gibt es für die Karte nicht.' : 'Karte wurde bereits beantwortet.', karte: publicCard(card) } }
    const result = await answerApprovalCard(`ac:${button.token}`, { userId: ownerIds[0], ownerIds, via: 'desktop' }, opts)
    const status = result.ok ? 200
        : result.code === 'verbraucht' ? 409
            : result.code === 'abgelaufen' ? 410
                : result.code === 'unbekannt' ? 404
                    : result.code === 'kein-owner' || result.code === 'nie-liste' || result.code === 'nicht-erlaubt' ? 403
                        : 500
    return { status, body: { ok: result.ok, code: result.code, message: clean(result.message, 400), karte: result.card ? publicCard(result.card) : null } }
}

// ---------------------------------------------------------------------------
// Heute: was sie gerade tut, offene Karten, Bericht, Gedanken
// ---------------------------------------------------------------------------

export interface DesktopReport {
    art: 'morgen' | 'abend'
    titel: string
    text: string
    seit: string
    zahlen: Record<string, number>
    geplant: { morgen: string; abend: string; an: boolean } | null
    /** 2.86 Paket M: report sections (owner text) for the cockpit tiles. */
    abschnitte?: Array<{ titel: string; zeilen: string[] }>
}

/** Live preview of the next morning/evening report (read-only; delivery state and bundled cards untouched). */
export async function previewReport(opts: ViewOptions = {}): Promise<DesktopReport> {
    const now = (opts.now || Date.now)()
    const { getPlannerRuntime } = await import('../planner/runtime.js')
    const { getThoughtStore } = await import('../planner/index.js')
    const { buildBriefing } = await import('../planner/briefing.js')
    const { DEFAULT_TIME_ZONE, zonedHour } = await import('../planner/time.js')
    const { bundledCards } = await import('../core/approval-cards.js')
    const { trustChangesSince } = await import('../core/action-policy.js')
    const runtime = opts.dataDir ? null : getPlannerRuntime()
    const dataDir = opts.dataDir || getNovaDataDir()
    const timeZone = runtime?.settings.briefing.timeZone || DEFAULT_TIME_ZONE
    let lastDelivered: number | null = null
    try {
        const value = Date.parse(JSON.parse(readFileSync(join(dataDir, 'planner', 'briefing-state.json'), 'utf8'))?.lastDeliveredAt)
        lastDelivered = Number.isFinite(value) ? value : null
    } catch { lastDelivered = null }
    const since = Math.max(lastDelivered ?? now - DAY_MS, now - 36 * 3_600_000)
    // Not Intl de-AT: it formats the hour as „08 Uhr“ (no number → always „abend“).
    const hour = zonedHour(now, timeZone)
    const art: 'morgen' | 'abend' = hour < 14 ? 'morgen' : 'abend'
    const briefing = buildBriefing(art, {
        dataDir, thoughts: opts.dataDir ? getThoughtStore(dataDir) : (runtime?.thoughts || getThoughtStore()),
        runsFile: runtime?.planner.paths.runs || join(dataDir, 'planner', 'runs.jsonl'), timeZone,
        // Read-only: listing bundled cards here must never release them.
        cards: { bundled: () => bundledCards({ dataDir }), release: () => 0 },
        trust: { changesSince: (from: number, until: number) => trustChangesSince(from, until, { dataDir }) },
    }, since, now)
    const text = redactSecrets(String(briefing.text || '')).slice(0, 3500)
    return {
        art, titel: clean(briefing.title, 120), text, seit: new Date(since).toISOString(), zahlen: { ...briefing.counts },
        abschnitte: (briefing.sections || []).slice(0, 14).map(section => ({ titel: clean(section.titel, 60), zeilen: section.zeilen.slice(0, 12).map(line => clean(line, 240)) })),
        geplant: runtime ? { morgen: runtime.settings.briefing.morning, abend: runtime.settings.briefing.evening, an: runtime.settings.briefing.enabled } : null,
    }
}

export interface HeuteView {
    generatedAt: string
    jetzt: { aufgaben: Array<{ text: string; quelle: string; seit: string | null }>; warteschlange: string[] }
    karten: DesktopCard[]
    entschieden: DesktopCard[]
    bericht: DesktopReport | null
    gedanken: Array<{ at: string; quelle: string; status: string; text: string }>
    probleme: string[]
    /** 2.86 Paket M: questions waiting behind the first one (they come one at a time). */
    wartend?: number
    /** 2.86 Paket M: four traffic-light tiles (Läuft alles? · Braucht dich · getan · gelernt). */
    cockpit?: import('../guided/ampel.js').Kachel[]
}

export async function collectHeute(opts: ViewOptions = {}): Promise<HeuteView> {
    const problems: string[] = []
    const now = (opts.now || Date.now)()
    const { collectJetzt, collectGedanken } = await import('../core/now-view.js')
    const jetzt = await attempt('Jetzt', () => collectJetzt(opts), problems)
    const gedanken = await attempt('Gedanken', () => collectGedanken(opts), problems)
    const bericht = await attempt('Bericht', () => previewReport(opts), problems)
    // 2.86 Paket M: open questions in queue order (the visible one first), the cockpit tiles.
    const { orderedOpenQuestions, waitingQuestionCount } = await import('../core/question-queue.js')
    const { isBundleVisible } = await import('../core/card-bundle.js')
    const offen = orderedOpenQuestions(jetzt?.openCards || [], now)
    const wartend = await attempt('Warteschlange', () => waitingQuestionCount({ dataDir: opts.dataDir, now: opts.now, bundleVisible: key => isBundleVisible(key, { dataDir: opts.dataDir }) }), problems) ?? 0
    const kritisch = await attempt('Ampel', async () => {
        const { getThoughtStore, isOpenThought } = await import('../planner/index.js')
        return getThoughtStore(opts.dataDir).list({ limit: 500 }).filter(item => isOpenThought(item) && item.importance === 'dringend').length
    }, problems) ?? 0
    const verbindungFehler = await attempt('Verbindungen', async () => {
        const { loadConnections } = await import('../connections/connection-store.js')
        return loadConnections({ dataDir: opts.dataDir }).filter(item => item.status === 'fehler' || item.status === 'abgelaufen').length
    }, problems) ?? 0
    const { buildCockpit, cockpitZeilen } = await import('../guided/ampel.js')
    const zeilen = cockpitZeilen(bericht?.abschnitte)
    const cockpit = buildCockpit({ kritisch, verbindungFehler, probleme: problems.length, frage: offen[0] ? { id: offen[0].id, titel: clean(offen[0].kurz || offen[0].titel, 200) } : null, wartend: Math.max(wartend, offen.length - 1), getan: zeilen.getan, gelernt: zeilen.gelernt })
    return {
        generatedAt: new Date(now).toISOString(),
        jetzt: {
            aufgaben: (jetzt?.tasks || []).slice(0, 8).map(task => ({ text: clean(task.label, 240), quelle: clean(task.source, 40), seit: iso(task.since) })),
            warteschlange: (jetzt?.queue || []).slice(0, 8).map(item => clean(item, 240)),
        },
        karten: [...offen, ...(jetzt?.openCards || []).filter(card => card.status === 'spaeter')].slice(0, 20).map(publicCard),
        entschieden: (jetzt?.decisions || []).slice(-6).reverse().map(publicCard),
        bericht,
        gedanken: (gedanken || []).slice(-40).reverse().map(item => ({ at: clean(item.at, 40), quelle: clean(item.quelle, 60), status: clean(item.status, 30), text: clean(item.text, 400) })),
        probleme: problems,
        wartend: Math.max(wartend, offen.length - 1),
        cockpit,
    }
}

// ---------------------------------------------------------------------------
// Arbeit: Missionen, Auftraege, Delegationen, Verantwortungen
// ---------------------------------------------------------------------------

export async function collectArbeit(): Promise<Record<string, unknown>> {
    const problems: string[] = []
    const { readArbeitState } = await import('../core/responsibility-runtime.js')
    const state = await attempt('Missionen/Verantwortungen', () => readArbeitState(), problems)
    const missions = (state?.missions || []).slice(-30).reverse().map(mission => ({
        id: clean(mission.id, 40), titel: clean(mission.titel, 200), status: clean(mission.status, 30),
        anlass: (mission.anlass || []).slice(0, 5).map(item => clean(item, 200)),
        fertigWenn: (mission.vertrag?.doneWhen || []).slice(0, 5).map(item => clean(item, 200)),
        schritte: (mission.steps || []).slice(0, 12).map(step => ({ id: clean(step.id, 12), titel: clean(step.titel, 160), status: clean(step.status, 20), node: clean(step.node, 60), ergebnis: clean(step.result, 240) })),
        cursor: mission.cursor, versuch: Math.min(mission.versuche + 1, mission.maxVersuche), maxVersuche: mission.maxVersuche,
        uebergabe: clean(mission.handoff, 400), grund: clean(mission.grund, 240), node: clean(mission.node, 60),
        createdAt: iso(mission.createdAt), updatedAt: iso(mission.updatedAt), frist: iso(mission.budget?.deadlineAt),
        verlauf: (mission.log || []).slice(-6).map(entry => ({ at: iso(entry.at), text: clean(entry.text, 240) })),
    }))
    const responsibilities = (state?.responsibilities || []).filter(item => item.status !== 'abgelehnt').map(item => ({
        id: clean(item.id, 80), titel: clean(item.titel, 200), ziel: clean(item.ziel, 300), status: clean(item.status, 20),
        herkunft: item.herkunft === 'owner' ? 'von Alfred' : 'selbst abgeleitet', bisStufe: clean(item.maxLevel, 8),
        kriterien: (item.kriterien || []).slice(0, 6).map(criterion => clean(criterion.text, 200)),
        letztePruefung: item.lastCheck ? { at: iso(item.lastCheck.at), erfuellt: item.lastCheck.erfuellt, befunde: (item.lastCheck.befunde || []).slice(0, 5).map(text => clean(text, 200)) } : null,
    }))
    const executor = await attempt('Aufträge', async () => (await import('../core/autonomous-executor.js')).getMissionData(), problems)
    const auftrag = (mission: any) => mission ? {
        id: clean(mission.id, 60), ziel: clean(mission.summary || mission.goal, 300), status: clean(mission.status, 20),
        schritte: (mission.steps || []).slice(0, 15).map((step: any) => ({ text: clean(step.description, 200), status: clean(step.status, 20) })),
        aktuell: Number(mission.currentStep) || 0, createdAt: iso(mission.createdAt), finishedAt: iso(mission.finishedAt),
        fortschritt: (mission.progressUpdates || []).slice(-5).map((line: unknown) => clean(line, 240)),
    } : null
    const delegations = await attempt('Delegationen', async () => (await import('../core/delegation.js')).getDelegationService().list({ limit: 15 }), problems)
    const planner = await attempt('Planer', async () => (await import('../planner/runtime.js')).getPlannerRuntime(), problems)
    // Only title, rhythm and times; never the job payload (reminder texts stay in the planner).
    const jobs = (planner?.planner.listJobs({ status: 'aktiv' }) || []).slice(0, 60).map(job => ({
        id: clean(job.id, 60), titel: clean(job.title, 160), art: clean(job.kind, 40), an: job.enabled !== false,
        rhythmus: job.schedule?.type === 'taeglich' ? `täglich ${clean(job.schedule.time, 5)}`
            : job.schedule?.type === 'intervall' ? `alle ${Number(job.schedule.minutes) || 0} min`
                : job.schedule?.type === 'einmal' ? 'einmalig' : '',
        naechster: iso(job.nextRunAt), zuletzt: iso(job.lastRunAt), letzterStatus: clean(job.lastStatus, 40),
    }))
    return {
        an: state?.enabled ?? null,
        missionen: missions,
        verantwortungen: responsibilities,
        auftraege: { aktiv: auftrag(executor?.active), verlauf: (executor?.history || []).slice(-8).reverse().map(auftrag) },
        delegationen: (delegations || []).map(item => ({
            id: clean(item.id, 40), an: clean(item.to, 20), auftrag: clean(item.auftrag, 300), status: clean(item.status, 30), stufe: clean(item.stufe, 4),
            frist: iso(item.fristAt), aktualisiert: iso(item.updatedAt), mission: item.missionId ? clean(item.missionId, 40) : null,
            pruefung: item.pruefung ? { ergebnis: clean(item.pruefung.ergebnis, 20), detail: clean(item.pruefung.detail, 240) } : null,
        })),
        geplant: planner ? jobs : null,
        vertrauen: (state?.promoted || []).map(item => ({ art: clean(item.kind, 60), text: clean(item.text, 200), seit: iso(item.promotedAt) })),
        erlaubt: (state?.grants || []).map(item => ({ art: clean(item.kind, 60), was: clean(item.subject, 120), seit: iso(item.grantedAt) })),
        probleme: problems,
    }
}

// ---------------------------------------------------------------------------
// System: Waechter (Knoten-Status, Messverlauf), Desktops; VMs separat
// ---------------------------------------------------------------------------

export async function collectSystem(opts: { now?: () => number } = {}): Promise<Record<string, unknown>> {
    const problems: string[] = []
    const now = (opts.now || Date.now)()
    const watch = await attempt('Wächter', async () => (await import('../watch/runtime.js')).getWatchOverview(now), problems)
    const series = await attempt('Messverlauf', async () => {
        const { watchDir } = await import('../watch/runtime.js')
        const { readWatchSamples } = await import('../watch/store.js')
        const byNode = new Map<string, Array<{ at: string; ram: number; cpu: number | null; platte: number | null }>>()
        for (const sample of readWatchSamples(watchDir(), { sinceMs: now - DAY_MS })) {
            const list = byNode.get(sample.nodeId) || []
            const disk = sample.disks.length ? Math.max(...sample.disks.map(item => item.usedPct)) : null
            list.push({ at: sample.at, ram: Math.round(sample.ramUsedPct), cpu: sample.cpuLoad === null ? null : Math.round(sample.cpuLoad * 100) / 100, platte: disk === null ? null : Math.round(disk) })
            byNode.set(sample.nodeId, list)
        }
        // At most 48 points per node (about every 30 min over 24 h).
        return Object.fromEntries([...byNode].map(([node, points]) => {
            const step = Math.max(1, Math.ceil(points.length / 48))
            return [clean(node, 80), points.filter((_point, index) => index % step === 0 || index === points.length - 1)]
        }))
    }, problems)
    const desktops = await attempt('Desktops', async () => (await import('../desktop-direct/runtime.js')).listDirectDesktops(), problems)
    const snapshot = watch?.snapshot
    return {
        waechter: watch ? {
            an: watch.enabled,
            knoten: watch.nodes.map(node => ({
                id: clean(node.nodeId, 80), at: iso(node.at), alterMin: node.ageMinutes, cpu: node.cpuLoad, ram: Math.round(node.ramUsedPct),
                platten: (node.disks || []).slice(0, 6).map(disk => ({ mount: clean(disk.mount, 60), belegt: Math.round(disk.usedPct), freiGB: Math.round(disk.freeGB) })),
                tempC: node.tempC, antwortMs: node.responseMs, dienstAus: (node.servicesDown || []).slice(0, 10).map(name => clean(name, 60)),
                quelle: node.source === 'herzschlag' ? 'herzschlag' : 'messung',
            })),
            erreichbarkeit: (snapshot?.reachability || []).slice(0, 64).map(item => ({ name: clean(item.name, 80), art: clean(item.kind, 30), ok: item.ok, ms: item.ms, alarm: item.alarmed, detail: clean(item.detail, 160), herkunft: item.origin === 'selbst' ? 'selbst' : 'owner', nieErreicht: item.silent === true })),
            prognosen: (snapshot?.forecasts || []).slice(0, 12).map((item: any) => ({ art: item.kind, text: clean(item.text || [item.node, item.mount].filter(Boolean).join(' '), 200), tage: typeof item.daysLeft === 'number' ? item.daysLeft : null, schwere: clean(item.severity, 20) })),
            zertifikate: (snapshot?.certs || []).slice(0, 12).map(item => ({ name: clean(item.name, 80), tage: item.daysLeft, schwere: clean(item.severity, 20) })),
            sicherungen: (snapshot?.backups || []).slice(0, 12).map(item => ({ name: clean(item.name, 80), alterStd: item.ageHours, maxStd: item.maxAgeHours, schwere: clean(item.severity, 20) })),
            nachtwache: snapshot?.nightwatch ? {
                at: iso(snapshot.nightwatch.at), gesamt: snapshot.nightwatch.total,
                fehler: (snapshot.nightwatch.failing || []).slice(0, 10).map(item => ({ label: clean(item.label, 100), status: clean(item.status, 20), text: clean(item.message, 200) })),
            } : null,
            stand: iso(snapshot?.at),
        } : null,
        verlauf: series || {},
        desktops: desktops || { enabled: false, desktops: [] },
        probleme: problems,
    }
}

export async function collectVms(): Promise<Record<string, unknown>> {
    const { readVmsInventory } = await import('../infra/proxmox-command.js')
    const inventory = await readVmsInventory()
    return { ...inventory, reason: inventory.reason ? clean(inventory.reason, 240) : undefined }
}

// ---------------------------------------------------------------------------
// Gedaechtnis: Entscheidungen (kausales Gedaechtnis), Werkzeug-Schmiede,
// Prozeduren (2.86: mit an/aus wie /prozeduren) und Lern-Puls
// ---------------------------------------------------------------------------

export async function collectGedaechtnis(opts: { dataDir?: string; principalId?: string } = {}): Promise<Record<string, unknown>> {
    const problems: string[] = []
    const decisions = await attempt('Entscheidungen', async () => (await import('../core/decisions.js')).listDecisions(opts.dataDir ? { dataDir: opts.dataDir } : {}), problems)
    const tools = await attempt('Werkzeug-Schmiede', async () => (await import('../tools/skill-builder.js')).getSkillProposals(200), problems)
    // Numbering = the owner's /prozeduren list, so the switch hits the same entry.
    const procedures = opts.principalId ? await attempt('Prozeduren', async () => {
        const { getProcedureStore, procedureStatus } = await import('../learning/procedure-store.js')
        return getProcedureStore().list(opts.principalId).map((entry, index) => ({ entry, nr: index + 1, status: procedureStatus(entry) }))
    }, problems) : []
    const pulse = await attempt('Lern-Puls', async () => (await import('../learning/learning-flow.js')).learningFlow(), problems)
    return {
        entscheidungen: (decisions || []).slice(-80).reverse().map(item => ({
            id: clean(item.id, 40), text: clean(item.text, 300), warum: clean(item.warum, 300), status: clean(item.status, 20),
            bindend: item.bindend === true, wirksam: item.wirksam === true, nichtWirksamGrund: clean(item.nichtWirksamGrund, 200),
            quelle: clean(item.quelle?.art, 30), at: iso(item.at), gueltigBis: iso(item.gueltigBis), themen: (item.themen || []).slice(0, 6).map(topic => clean(topic, 40)),
            konflikt: item.konfliktMit ? clean(item.konfliktMit, 40) : null,
        })),
        // Never the tool code, tests or history: name, purpose, state and counters only.
        werkzeuge: (tools || []).reverse().map(item => ({
            id: clean(item.id, 60), name: clean(item.name, 60), beschreibung: clean(item.description, 300), warum: clean(item.why, 300), status: clean(item.status, 30),
            version: Number(item.version) || 1, herkunft: clean(item.origin, 20), wirkung: clean((item.manifest as any)?.wirkung, 30),
            tests: item.lastTest ? { bestanden: item.lastTest.passed, gesamt: item.lastTest.total, at: iso(item.lastTest.at) } : null,
            aufrufe: item.counters ? { gesamt: item.counters.calls, ok: item.counters.successes, fehler: item.counters.failures, zuletzt: iso(item.counters.lastUsedAt) } : null,
            gesperrt: clean(item.activationBlockedReason || item.disabledReason, 240), karte: item.cardId ? clean(item.cardId, 40) : null,
            createdAt: iso(item.createdAt),
        })),
        // Problem gekürzt, Werkzeug, Abrufe/ok, Status; nie die gespeicherte Lösung.
        prozeduren: (procedures || []).map(({ entry, nr, status }) => {
            const uses = Number(entry.uses) || 0
            return {
                nr, problem: clean(entry.problem, 120), werkzeug: clean(entry.toolName, 60), abrufe: uses,
                ok: Math.max(0, uses - (Number(entry.failures) || 0)), status: clean(status, 60),
                an: entry.disabledByOwner !== true, gelerntAm: iso(entry.learnedAt),
            }
        }),
        lernPuls: pulse ? {
            kanaele: pulse.channels.map(item => ({ kanal: item.channel, label: clean(item.label, 40), dieseWoche: item.current, vorwoche: item.previous })),
            nutzen: pulse.usage.map(item => ({ art: item.kind, label: clean(item.label, 40), abrufe: item.uses, ok: item.ok })),
        } : null,
        probleme: problems,
    }
}
