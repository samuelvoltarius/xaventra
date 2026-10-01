/**
 * /jetzt and /gedanken (Autonomie-Plan Phase 1 Teil A): what Xaventra is
 * doing right now, what waits, what was decided — and the stream of
 * thoughts/proposals including the discarded ones.
 * Read-only views; owner-only via the central command role table.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listApprovalCards, readThoughts, type ApprovalCard, type CardStoreOptions } from './approval-cards.js'
import { getNovaDataDir } from './data-root.js'
import { readHealJournal, readHealProposals } from '../doctor/self-heal.js'

export interface NowTask { label: string; since: number; source: string }
export interface NowSnapshot {
    now: number
    tasks: NowTask[]
    queue: string[]
    openCards: ApprovalCard[]
    decisions: ApprovalCard[]
}

const ANSWER: Record<string, string> = { ja: 'Ja', nein: 'Nein', spaeter: 'Später', immer: 'Immer erlauben' }

function ago(now: number, at: number | string | undefined): string {
    const ms = typeof at === 'number' ? at : Date.parse(String(at || ''))
    if (!Number.isFinite(ms)) return '?'
    const seconds = Math.max(0, Math.round((now - ms) / 1000))
    if (seconds < 90) return `${seconds} s`
    const minutes = Math.round(seconds / 60)
    if (minutes < 90) return `${minutes} min`
    return `${Math.round(minutes / 60)} h`
}

const line = (value: unknown, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function formatJetzt(snapshot: NowSnapshot): string {
    const { now } = snapshot
    const out: string[] = ['🟢 Jetzt']
    out.push('', 'Aufgaben:')
    if (!snapshot.tasks.length) out.push('- keine laufende Aufgabe')
    for (const task of snapshot.tasks.slice(0, 8)) out.push(`- ${line(task.label)} (${task.source}, seit ${ago(now, task.since)})`)
    out.push('', 'Warteschlange:')
    if (!snapshot.queue.length) out.push('- leer')
    for (const item of snapshot.queue.slice(0, 8)) out.push(`- ${line(item, 200)}`)
    out.push('', `Offene Karten (${snapshot.openCards.length}):`)
    if (!snapshot.openCards.length) out.push('- keine')
    for (const card of snapshot.openCards.slice(-8)) out.push(`- [${card.art}] ${line(card.titel)} — offen seit ${ago(now, card.createdAt)}, gültig bis ${String(card.expiresAt).slice(11, 16)} UTC`)
    out.push('', 'Zuletzt entschieden:')
    if (!snapshot.decisions.length) out.push('- noch nichts')
    for (const card of snapshot.decisions.slice(-5).reverse()) {
        out.push(`- ${ANSWER[card.answer || ''] || card.status}: ${line(card.titel)} (vor ${ago(now, card.decidedAt)})${card.result ? ` → ${card.result.ok ? '✓' : '✗'} ${line(card.result.message, 120)}` : ''}`)
    }
    return out.join('\n')
}

export async function collectJetzt(opts: CardStoreOptions = {}): Promise<NowSnapshot> {
    const now = (opts.now || Date.now)()
    const tasks: NowTask[] = []
    try {
        const { listActiveStatusCards } = await import('../channels/telegram-status-card.js')
        for (const card of listActiveStatusCards()) tasks.push({ label: card.text, since: card.startedAt, source: 'Telegram' })
    } catch { /* optional */ }
    try {
        const { getTaskData } = await import('./task-tracker.js')
        const current = getTaskData().current
        if (current && (current.status === 'active' || current.status === 'planning')) {
            const step = current.steps[current.currentStep]
            tasks.push({ label: `${line(current.summary || current.userMessage, 100)}${step ? ` — Schritt ${current.currentStep + 1}/${current.steps.length}: ${line(step.description, 60)}` : ''}`, since: current.startedAt, source: current.channel || 'Aufgabe' })
        }
    } catch { /* optional */ }
    try {
        const { getMissionData } = await import('./autonomous-executor.js')
        const mission = getMissionData().active as any
        if (mission && ['planning', 'active'].includes(mission.status)) tasks.push({ label: `Mission: ${line(mission.title || mission.goal || mission.id, 120)} (${mission.status})`, since: Date.parse(mission.createdAt || mission.startedAt || '') || now, source: 'Mission' })
    } catch { /* optional */ }
    const queue: string[] = []
    try {
        const { defaultInstallDeps, loadInstallQueue, describeProposal } = await import('../install/install-queue.js')
        const deps = opts.dataDir ? { dataDir: join(opts.dataDir, 'install') } : defaultInstallDeps()
        for (const item of loadInstallQueue(deps).filter(entry => entry.status === 'queued' || entry.status === 'running')) queue.push(`[${item.status}] ${describeProposal(item)}`)
    } catch { /* optional */ }
    const cards = listApprovalCards(opts)
    return {
        now,
        tasks,
        queue,
        openCards: cards.filter(card => card.status === 'offen' || card.status === 'spaeter'),
        decisions: cards.filter(card => card.decidedAt && ['ja', 'nein', 'immer'].includes(card.status)).sort((a, b) => String(a.decidedAt).localeCompare(String(b.decidedAt))),
    }
}

// ---------------------------------------------------------------------------
// /gedanken
// ---------------------------------------------------------------------------

export interface GedankenItem { at: string; quelle: string; status: string; text: string }

export async function collectGedanken(opts: CardStoreOptions & { installDataDir?: string } = {}): Promise<GedankenItem[]> {
    const items: GedankenItem[] = []
    const dataDir = opts.dataDir || getNovaDataDir()
    for (const thought of readThoughts(opts, 60)) {
        items.push({ at: thought.at, quelle: thought.quelle, status: thought.status, text: `${thought.titel}${thought.text ? ` — ${thought.text}` : ''}` })
    }
    try {
        for (const entry of readHealJournal(dataDir, 15)) {
            items.push({ at: entry.at, quelle: `selbstheilung/${entry.node}`, status: entry.ergebnis, text: entry.message })
        }
    } catch { /* optional */ }
    try {
        for (const proposal of readHealProposals(dataDir).slice(-10)) {
            items.push({ at: proposal.decidedAt || proposal.at, quelle: `heil-vorschlag/${proposal.node}`, status: proposal.status, text: `${proposal.title}: ${proposal.message}` })
        }
    } catch { /* optional */ }
    try {
        const installDir = opts.installDataDir || (opts.dataDir ? join(opts.dataDir, 'install') : (await import('../install/install-queue.js')).defaultInstallDeps().dataDir)
        const journal = join(installDir, 'install-journal.jsonl')
        if (existsSync(journal)) {
            for (const raw of readFileSync(journal, 'utf8').split('\n').filter(Boolean).slice(-15)) {
                try {
                    const entry = JSON.parse(raw)
                    const what = [entry.catalogId, entry.nodeId, entry.route, entry.success === undefined ? '' : entry.success ? 'erfolgreich' : 'fehlgeschlagen', entry.error].filter(Boolean).join(' · ')
                    items.push({ at: String(entry.at), quelle: 'installation', status: String(entry.event), text: `${entry.id || ''} ${what}`.trim() })
                } catch { /* skip */ }
            }
        }
    } catch { /* optional */ }
    return items.filter(item => item.at).sort((a, b) => a.at.localeCompare(b.at))
}

const STATUS_ICON: Record<string, string> = {
    vorgeschlagen: '💡', angenommen: '✅', abgelehnt: '🚫', verworfen: '🗑️', abgelaufen: '⌛', 'später': '⏰',
    geheilt: '🩹', zurueckgerollt: '↩️', 'rueckweg-gescheitert': '🔥', vorschlag: '💡', 'gesperrt-fence': '🔒', offen: '💡',
}

export function formatGedanken(items: GedankenItem[], limit = 25): string {
    if (!items.length) return '💭 Gedanken: noch nichts aufgezeichnet.'
    const shown = items.slice(-limit).reverse()
    return [
        `💭 Gedanken (neueste zuerst, ${shown.length} von ${items.length}, inkl. verworfener):`,
        ...shown.map(item => `${STATUS_ICON[item.status] || '•'} ${item.at.slice(5, 16).replace('T', ' ')} [${line(item.quelle, 40)}] ${line(item.status, 24)}: ${line(item.text, 220)}`),
    ].join('\n')
}
