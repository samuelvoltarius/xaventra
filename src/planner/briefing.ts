/**
 * Morgen- und Abendbericht (Phase 1, Autonomie-Plan A): erledigt / selbst
 * repariert (Self-Heal-Journal) / installiert (Install-Journal) / wartet auf
 * dich (offene Gedanken mit Stufe "fragen") / Ideen. Short, German, built
 * only from journals on disk (no model), every line redacted.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { readHealJournal } from '../doctor/self-heal.js'
import { cleanText } from './delivery-port.js'
import type { JobHandler } from './planner.js'
import { isOpenThought, type Thought, type ThoughtStore } from './thoughts.js'
import { formatZoned } from './time.js'

export type BriefingKind = 'morgen' | 'abend'

export interface BriefingSources {
    dataDir: string
    thoughts: ThoughtStore
    /** planner/runs.jsonl */
    runsFile: string
    /** default <dataDir>/install-journal.jsonl */
    installJournalFile?: string
    timeZone: string
}

export interface Briefing {
    title: string
    text: string
    /** Held-back thoughts this briefing reports (marked `im-bericht` after delivery). */
    thoughtIds: string[]
    counts: Record<'erledigt' | 'repariert' | 'installiert' | 'wartet' | 'ideen' | 'zurueckgehalten' | 'skills', number>
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

export function buildBriefing(kind: BriefingKind, sources: BriefingSources, since: number, now: number): Briefing {
    const thoughts = sources.thoughts.list({ limit: 500 })

    // Erledigt: planner runs (not the briefings themselves) + thoughts closed as done.
    const runCounts = new Map<string, number>()
    for (const entry of readJsonl(sources.runsFile)) {
        if (entry?.ergebnis !== 'ok' || !inWindow(entry.at, since, now)) continue
        if (String(entry.kind).startsWith('briefing')) continue
        runCounts.set(entry.kind, (runCounts.get(entry.kind) || 0) + 1)
    }
    const done = [
        ...[...runCounts].map(([jobKind, count]) => `${KIND_LABELS[jobKind] || jobKind}: ${count}`),
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
    const waiting = thoughts.filter(t => isOpenThought(t) && t.permission === 'fragen' && t.kind !== 'idee').map(describe)
    const ideas = thoughts.filter(t => isOpenThought(t) && t.kind === 'idee').slice(0, 3)
        .map(t => t.evidence ? `${t.title} (${t.evidence})` : t.title)
    // P8 Routine-Skills: selbst angelegte und deaktivierte Skills, eigene Zeilen.
    const skills = thoughts.filter(t => t.source === 'skills' && inWindow(t.createdAt, since, now))
        .map(t => t.title.includes('deaktiviert') && t.evidence ? `${t.title} (${t.evidence})` : t.title)
    const heldThoughts = thoughts.filter(t => isOpenThought(t) && t.notice === 'zurueckgehalten')
    const held = heldThoughts.map(t => `${t.title} (${t.noticeReason === 'tageslimit' ? 'Tageslimit' : 'Ruhezeit'})`)

    const title = `${kind === 'morgen' ? 'Morgenbericht' : 'Abendbericht'} ${formatZoned(now, sources.timeZone)}`
    const body = [
        ...section('Erledigt', done),
        ...section('Selbst repariert', repaired),
        ...section('Installiert', installed),
        ...section('Wartet auf dich', waiting),
        ...section('Ideen', ideas),
        ...section('Skills', skills),
        ...section('Zurückgehalten', held),
    ]
    const sinceText = formatZoned(since, sources.timeZone)
    const text = body.length === 0
        ? `${title}\nNichts Neues seit ${sinceText}.`
        : `${title} (seit ${sinceText})${body.join('\n')}`
    return {
        title,
        text: cleanText(text, 3500),
        thoughtIds: heldThoughts.map(t => t.id),
        counts: { erledigt: done.length, repariert: repaired.length, installiert: installed.length, wartet: waiting.length, ideen: ideas.length, zurueckgehalten: held.length, skills: skills.length },
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
            const briefing = buildBriefing(options.kind, options.sources, since, ctx.now)
            const c = briefing.counts
            return {
                summary: `${briefing.title}: erledigt ${c.erledigt}, repariert ${c.repariert}, installiert ${c.installiert}, wartet ${c.wartet}, Ideen ${c.ideen}`,
                outgoing: { kind: 'briefing', title: briefing.title, text: briefing.text, urgency: 'normal', refs: briefing.thoughtIds },
            }
        },
        afterDelivery(_job, outgoing, ctx) {
            for (const id of outgoing.refs || []) options.sources.thoughts.markNotice(id, 'im-bericht')
            mkdirSync(join(options.sources.dataDir, 'planner'), { recursive: true, mode: 0o700 })
            atomicWriteJsonSync(stateFile, { lastDeliveredAt: new Date(ctx.now).toISOString() })
        },
    }
}
