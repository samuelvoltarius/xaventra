/**
 * Morgen- und Abendbericht (Phase 1, Autonomie-Plan A): erledigt / selbst
 * repariert (Self-Heal-Journal) / installiert (Install-Journal) / wartet auf
 * dich (offene Gedanken mit Stufe "fragen") / Ideen. Short, German, built
 * only from journals on disk (no model), every line redacted.
 *
 * P8: plus „Fragen gesammelt“ (non-time-critical Knopf-Karten bundled into the
 * report; released after delivery so their buttons follow right away) and
 * „Selbst übernommen“ (trust-ladder promotions/resets in the window).
 *
 * 2.83.0: „Lernkurve“ (evening only): success rate per task type this week
 * against last week from the Kernel-validated outcome samples, plus owner
 * rejections and optional suggestion lines. Counts only, never request text.
 *
 * 2.84 Lern-Puls (learning/learning-flow.ts): at most 2 more lines in the same
 * section — new entries per learning store this week vs. last week and how
 * often learned things were used. The job resolves them asynchronously (the
 * LanceDB count is async) before the report is built.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { readHealJournal } from '../doctor/self-heal.js'
import { decisionsForBriefing } from '../core/decisions.js'
import { cleanText } from './delivery-port.js'
import type { JobHandler } from './planner.js'
import { isOpenThought, type Thought, type ThoughtStore } from './thoughts.js'
import { formatZoned } from './time.js'
import { ampelKopf, ownerText } from '../core/owner-text.js'
import type { SuccessTrend, SuccessTrendWindow } from '../routing/outcome-router.js'

export type BriefingKind = 'morgen' | 'abend'

export interface BriefingSources {
    dataDir: string
    thoughts: ThoughtStore
    /** planner/runs.jsonl */
    runsFile: string
    /** default <dataDir>/install-journal.jsonl */
    installJournalFile?: string
    timeZone: string
    /** P8: bundled Knopf-Karten (approval-cards.ts). */
    cards?: {
        bundled(): Array<{ id: string; art: string; titel: string; vorschlag?: string }>
        release(): number
        /** 2.86 Paket M: questions waiting behind the one visible question (question-queue.ts). */
        waiting?(): number
        /** Paket L: questions that expired without an answer in the window (listed once). */
        expiredSince?(since: number, until: number): Array<{ titel: string; kurz?: string }>
    }
    /** P8: trust ladder changes (action-policy.ts). */
    trust?: { changesSince(since: number, until: number): { promoted: Array<{ kind: string; text: string }>; reset: Array<{ kind: string; reason: string }> } }
    /** 2.83.0 Lernkurve (only the evening report). */
    learning?: {
        /** Outcome router (Kernel-validated samples): this week against last week. */
        successTrend(now: number): SuccessTrend
        /**
         * Optional extra lines about suggestions (accepted/rejected,
         * suppressed suggestion kinds) from decisions.ts. Each line only when
         * there is data; without this input the section stays as it is.
         */
        suggestionLines?(since: number, until: number): string[]
        /** 2.84 Lern-Puls: at most 2 lines (learning-flow.ts). Async in the job, resolved before buildBriefing. */
        flowLines?(now: number): string[] | Promise<string[]>
    }
}

export interface Briefing {
    title: string
    text: string
    /** Held-back thoughts this briefing reports (marked `im-bericht` after delivery). */
    thoughtIds: string[]
    counts: Record<'erledigt' | 'repariert' | 'installiert' | 'wartet' | 'ideen' | 'zurueckgehalten' | 'skills' | 'gemerkt' | 'gesammelt' | 'vertrauen' | 'lernkurve', number>
    /** Paket L: every section with ALL its lines (owner text, no ids) for the paged Telegram view. */
    sections: Array<{ titel: string; zeilen: string[] }>
    /** Paket L: traffic light + one sentence. */
    kopf: string
}

const MAX_LINES = 5
const KIND_LABELS: Record<string, string> = {
    erinnerung: 'Erinnerungen ausgelöst',
    nachtwache: 'Nachtwache-Läufe',
    scout: 'Modell-Scout-Läufe',
    ideen: 'Ideen-Läufe',
}
const HEAL_LABELS: Record<string, string> = {
    geheilt: 'geheilt',
    zurueckgerollt: 'zurückgerollt',
    'rueckweg-gescheitert': 'Rückweg gescheitert',
}

function readJsonl(file: string): any[] {
    if (!existsSync(file)) return []
    const out: any[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* corrupt line */ }
    }
    return out
}

const inWindow = (at: unknown, since: number, now: number) => {
    const t = Date.parse(String(at))
    return Number.isFinite(t) && t >= since && t <= now
}

const line = (value: string) => `• ${cleanText(value, 160).replace(/\s+/g, ' ').trim()}`

function section(title: string, items: string[]): string[] {
    if (items.length === 0) return []
    const shown = items.slice(0, MAX_LINES).map(line)
    if (items.length > MAX_LINES) shown.push(`• … und ${items.length - MAX_LINES} weitere`)
    return ['', `${title}:`, ...shown]
}

const percent = (window: SuccessTrendWindow) => `${Math.round((window.successes / window.samples) * 100)} %`

/** Lernkurve: at most MAX_LINES; the Lern-Puls and extra lines are never cut off by the trend. */
function learningCurve(sources: BriefingSources, since: number, now: number): string[] {
    if (!sources.learning) return []
    let trend: SuccessTrend | null = null
    try { trend = sources.learning.successTrend(now) } catch { trend = null }
    let flow: string[] = []
    try {
        const lines = sources.learning.flowLines?.(now)
        if (Array.isArray(lines)) flow = lines.filter(item => typeof item === 'string' && item.trim()).slice(0, 2)
    } catch { /* optional input */ }
    const extras: string[] = [...flow]
    if (trend && (trend.rejected.current > 0 || trend.rejected.previous > 0)) {
        extras.push(`Owner-Zurückweisungen: ${trend.rejected.current} (Vorwoche ${trend.rejected.previous})`)
    }
    try { extras.push(...(sources.learning.suggestionLines?.(since, now) || []).filter(item => typeof item === 'string' && item.trim())) } catch { /* optional input */ }
    const shownExtras = extras.slice(0, MAX_LINES - 1)
    const rates = (trend?.taskTypes || []).slice(0, MAX_LINES - shownExtras.length).map(item =>
        `${({ none: 'Nicht klassifiziert', file: 'Dateiaufgaben' } as Record<string, string>)[item.taskType] || item.taskType} ${percent(item.previous)} → ${percent(item.current)} (Proben ${item.previous.samples}/${item.current.samples})`)
    return [...rates, ...shownExtras]
}

export function buildBriefing(kind: BriefingKind, sources: BriefingSources, since: number, now: number): Briefing {
    const thoughts = sources.thoughts.list({ limit: 500 })

    // Successful scheduler cycles are observations, not completed user work.
    const runCounts = new Map<string, number>()
    for (const entry of readJsonl(sources.runsFile)) {
        if (entry?.ergebnis !== 'ok' || !inWindow(entry.at, since, now)) continue
        if (String(entry.kind).startsWith('briefing')) continue
        runCounts.set(entry.kind, (runCounts.get(entry.kind) || 0) + 1)
    }
    const background = [...runCounts].map(([jobKind, count]) => `${KIND_LABELS[jobKind] || jobKind}: ${count}`)
    const done = [
        ...thoughts.filter(t => t.status === 'erledigt' && t.source !== 'skills' && inWindow(t.statusAt, since, now)).map(t => t.title),
    ]

    // Selbst repariert: Self-Heal-Journal.
    const repaired = readHealJournal(sources.dataDir, 500)
        .filter(entry => inWindow(entry.at, since, now) && HEAL_LABELS[entry.ergebnis])
        .map(entry => `${entry.recipe}: ${HEAL_LABELS[entry.ergebnis]} – ${entry.message}`)

    // Installiert: Install-Journal (receipts carry the queue id, tickets the catalog id).
    const installFile = sources.installJournalFile ?? join(sources.dataDir, 'install-journal.jsonl')
    const installEntries = readJsonl(installFile)
    const catalogById = new Map<string, string>()
    for (const entry of installEntries) if (entry?.id && entry.catalogId) catalogById.set(String(entry.id), String(entry.catalogId))
    const installed: string[] = []
    for (const entry of installEntries) {
        if (!inWindow(entry?.at, since, now)) continue
        const catalog = catalogById.get(String(entry.id)) || 'unbekannter Eintrag'
        if (entry.event === 'install-receipt') installed.push(entry.success ? `${catalog} installiert` : `${catalog} fehlgeschlagen`)
        if (entry.event === 'rollback-receipt' && entry.success) installed.push(`${catalog} zurückgenommen`)
    }

    const describe = (t: Thought) => t.proposal ? `${t.title} – ${t.proposal}` : t.title
    const waitingThoughts = thoughts.filter(t => isOpenThought(t) && t.permission === 'fragen' && t.kind !== 'idee')
    const waiting = waitingThoughts.map(describe)
    const ideas = thoughts.filter(t => isOpenThought(t) && t.kind === 'idee').slice(0, 3)
        .map(t => t.evidence ? `${t.title} (${t.evidence})` : t.title)
    // P8 Routine-Skills: selbst angelegte und deaktivierte Skills, eigene Zeilen.
    const skills = thoughts.filter(t => t.source === 'skills' && inWindow(t.createdAt, since, now))
        .map(t => t.title.includes('deaktiviert') && t.evidence ? `${t.title} (${t.evidence})` : t.title)
    const heldThoughts = thoughts.filter(t => isOpenThought(t) && t.notice === 'zurueckgehalten')
    // 2.84: a held-back thought already listed under „Wartet auf dich“ is not listed a second time
    // (it is still marked `im-bericht` after delivery).
    const waitingIds = new Set(waitingThoughts.map(t => t.id))
    const held = heldThoughts.filter(t => !waitingIds.has(t.id)).map(t => t.noticeReason === 'tagesbericht' ? t.title : `${t.title} (${t.noticeReason === 'tageslimit' ? 'Tageslimit' : 'Ruhezeit'})`)

    // Kausales Gedächtnis: what was remembered (or ended) without a command.
    let remembered: string[] = []
    try { remembered = decisionsForBriefing(since, now, { dataDir: sources.dataDir }) } catch { remembered = [] }
    // P8: bundled cards (gedanke cards are already listed under „Wartet auf dich“).
    let bundled: string[] = []
    try {
        bundled = (sources.cards?.bundled() || []).filter(card => card.art !== 'gedanke')
            .map(card => card.vorschlag ? `${card.titel} – ${card.vorschlag}` : card.titel)
    } catch { bundled = [] }
    let trustLines: string[] = []
    try {
        const changes = sources.trust?.changesSince(since, now)
        trustLines = [
            ...(changes?.promoted || []).map(item => `${item.text} (${item.kind}): mache ich ab jetzt selbst – 3× Ja ohne Rückweg. Zurück: „das wieder fragen“ bzw. /arbeit fragen ${item.kind}`),
            ...(changes?.reset || []).map(item => `${item.kind}: frage ich wieder (${item.reason})`),
        ]
    } catch { trustLines = [] }

    const curve = kind === 'abend' ? learningCurve(sources, since, now) : []
    // Paket L: a question never expires silently — it is listed once in the next report.
    let expired: string[] = []
    try { expired = (sources.cards?.expiredSince?.(since, now) || []).map(card => card.kurz ? `${card.titel} (${card.kurz})` : card.titel) } catch { expired = [] }

    // 2.86 Paket M: one question at a time — the report says how many wait behind the visible one.
    let queued = 0
    try { queued = Math.max(0, Math.floor(Number(sources.cards?.waiting?.()) || 0)) } catch { queued = 0 }
    const queuedLines = queued ? [`${queued === 1 ? '1 Frage wartet' : `${queued} Fragen warten`} – sie kommen einzeln, die wichtigste zuerst.`] : []

    const title = `${kind === 'morgen' ? 'Morgenbericht' : 'Abendbericht'} ${formatZoned(now, sources.timeZone)}`
    const body = [
        ...section('Erledigt', done),
        ...section('Hintergrundprüfungen (Durchläufe)', background),
        ...section('Selbst repariert', repaired),
        ...section('Installiert', installed),
        ...section('Wartet auf dich', waiting),
        ...section('Ohne Antwort abgelaufen', expired),
        ...section('Fragen gesammelt (Knöpfe kommen einzeln)', bundled),
        ...section('Fragen in der Warteschlange', queuedLines),
        ...section('Selbst übernommen', trustLines),
        ...section('Ideen', ideas),
        ...section('Skills', skills),
        ...section('Zurückgehalten', held),
        ...section('Neu gemerkt (Entscheidungen)', remembered),
        ...(curve.length && sources.learning ? ['Erfolgsquote: Vorwoche → diese Woche (je 7 Tage); wechselnder Aufgaben-/Modellmix, kein Lernnachweis.'] : []),
        ...section('Lernkurve', curve),
    ]
    const sinceText = formatZoned(since, sources.timeZone)
    const text = body.length === 0
        ? `${title}\nNichts Neues seit ${sinceText}.`
        : `${title} (seit ${sinceText})${body.join('\n')}`
    const sections = ([
        ['Wartet auf dich', waiting], ['Fragen in der Warteschlange', queuedLines], ['Ohne Antwort abgelaufen', expired], ['Erledigt', done], ['Selbst repariert', repaired], ['Installiert', installed],
        ['Fragen gesammelt', bundled], ['Selbst übernommen', trustLines], ['Hintergrundprüfungen', background], ['Ideen', ideas], ['Skills', skills],
        ['Zurückgehalten', held], ['Neu gemerkt', remembered], ['Lernkurve', curve],
    ] as Array<[string, string[]]>).filter(([, items]) => items.length)
        .map(([titel, items]) => ({ titel, zeilen: items.map(item => ownerText(cleanText(item, 300)).replace(/\s+/g, ' ').trim()).filter(Boolean) }))
    const kritisch = thoughts.filter(t => isOpenThought(t) && t.importance === 'dringend').length
    return {
        title,
        text: cleanText(text, 3500),
        sections,
        kopf: ampelKopf({ kritisch, fragen: waiting.length + bundled.length + queued }),
        thoughtIds: heldThoughts.map(t => t.id),
        counts: { erledigt: done.length, repariert: repaired.length, installiert: installed.length, wartet: waiting.length, ideen: ideas.length, zurueckgehalten: held.length, skills: skills.length, gemerkt: remembered.length, gesammelt: bundled.length, vertrauen: trustLines.length, lernkurve: curve.length },
    }
}

/** Job handler for `briefing-morgen` / `briefing-abend`. The report covers
 * the time since the last delivered briefing (at most 36 h). */
export function createBriefingHandler(options: { kind: BriefingKind; sources: BriefingSources }): JobHandler {
    const stateFile = join(options.sources.dataDir, 'planner', 'briefing-state.json')
    const lastDelivered = (): number | null => {
        try {
            const value = Date.parse(JSON.parse(readFileSync(stateFile, 'utf8'))?.lastDeliveredAt)
            return Number.isFinite(value) ? value : null
        } catch { return null }
    }
    return {
        async run(_job, ctx) {
            const floor = ctx.now - 36 * 3_600_000
            const since = Math.max(lastDelivered() ?? ctx.now - 24 * 3_600_000, floor)
            // Lern-Puls (evening only): resolve the async counts first, then build synchronously.
            let sources = options.sources
            if (options.kind === 'abend' && sources.learning?.flowLines) {
                let flow: string[] = []
                try { flow = await sources.learning.flowLines(ctx.now) } catch { flow = [] }
                sources = { ...sources, learning: { ...sources.learning, flowLines: () => flow } }
            }
            const briefing = buildBriefing(options.kind, sources, since, ctx.now)
            const c = briefing.counts
            return {
                summary: `${briefing.title}: erledigt ${c.erledigt}, repariert ${c.repariert}, installiert ${c.installiert}, wartet ${c.wartet}, Ideen ${c.ideen}`,
                outgoing: { kind: 'briefing', title: briefing.title, text: briefing.text, urgency: 'normal', refs: briefing.thoughtIds, sections: briefing.sections, kopf: briefing.kopf },
            }
        },
        afterDelivery(_job, outgoing, ctx) {
            for (const id of outgoing.refs || []) options.sources.thoughts.markNotice(id, 'im-bericht')
            // P8: the report listed the bundled cards — now their buttons go out.
            try { options.sources.cards?.release() } catch { /* the card loop retries with the next report */ }
            mkdirSync(join(options.sources.dataDir, 'planner'), { recursive: true, mode: 0o700 })
            atomicWriteJsonSync(stateFile, { lastDeliveredAt: new Date(ctx.now).toISOString() })
        },
    }
}
