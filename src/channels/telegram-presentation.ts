import type { OutgoingMessage } from '../core/types.js'
import { isToolProgressLabel } from '../core/tool-progress-label.js'
import { LiveStatusCard } from './telegram-status-card.js'
import { L12_UNVERIFIED_NOTE } from '../core/tool-evidence-response.js'
import { UNVERIFIED_NOTE } from '../core/unverified-claims.js'

export interface TelegramPresentationAdapter {
    send(msg: OutgoingMessage): Promise<void>
    sendProgress(chatId: string, text: string): Promise<number | null>
    editMessage(chatId: string, messageId: number, text: string): Promise<void>
    deleteMessage(chatId: string, messageId: number): Promise<void>
    sendStreaming?(chatId: string): Promise<{ push(text: string): void; complete(): Promise<void> } | null>
}

function splitTableRow(line: string): string[] {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function isSeparator(line: string): boolean {
    const cells = splitTableRow(line)
    return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

/** Convert Markdown tables into compact vertical cards that stay readable on phones. */
export function normalizeTelegramTables(input: string): string {
    const lines = input.split('\n')
    const output: string[] = []
    let inCodeFence = false
    for (let index = 0; index < lines.length;) {
        if (/^\s*```/.test(lines[index])) {
            inCodeFence = !inCodeFence
            output.push(lines[index++])
            continue
        }
        if (inCodeFence) {
            output.push(lines[index++])
            continue
        }
        if (index + 2 >= lines.length || !lines[index].includes('|') || !isSeparator(lines[index + 1])) {
            output.push(lines[index++])
            continue
        }
        const headers = splitTableRow(lines[index])
        const rows: string[][] = []
        index += 2
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
            const row = splitTableRow(lines[index])
            if (row.length !== headers.length) break
            rows.push(row)
            index++
        }
        if (!rows.length) {
            output.push(headers.join(' | '))
            continue
        }
        for (const row of rows) {
            const title = row[0] || 'Eintrag'
            output.push(`*${headers[0]}: ${title}*`)
            for (let cell = 1; cell < headers.length; cell++) {
                if (row[cell]) output.push(`  • ${headers[cell]}: ${row[cell]}`)
            }
            output.push('')
        }
        if (output.at(-1) === '') output.pop()
    }
    return output.join('\n')
}

/** Mobile-first formatting shared by regular, progress and streaming messages. */
export function formatTelegramMessage(input: string): string {
    return normalizeTelegramTables(String(input || ''))
        // Preserve code verbatim; Telegram's legacy Markdown uses single *.
        .split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^\)\n]*\)|https?:\/\/\S+)/g)
        .map((part, index) => index % 2 ? part : part.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
            .replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, '\\_'))
        .join('')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/^\s*[-*]\s+\[x\]\s+/gim, '✅ ')
        .replace(/^\s*[-*]\s+\[ \]\s+/gim, '⬜ ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

/**
 * 2.89.4 (live): `/mesh scan` answered `🔍 *Mesh AI Scan* …` and that line was
 * swallowed as progress — the card then closed as „❌ Abgebrochen" with no
 * reason. A titled or multi-line report is an answer. Progress is a short plain
 * lifecycle status (the long-run ⏳ notices, `⚙️ Schritt n/m`, tool labels).
 */
export function isTelegramProgress(text: string): boolean {
    const value = String(text || '').trim()
    if (!value) return false
    if (value.includes('\n') || /[*`]/.test(value)) return false
    // 2.91.0: only what the run itself emits counts as progress — a ⏳ status line (progress-notice.ts),
    // a ⚙️ step line, an exact tool label. A plain answer that merely starts alike („Ich arbeite noch nicht
    // mit Docker …“) went into the card and never reached the owner.
    return /^(?:⏳|⚙️\s*Schritt\s+\d+\s*\/)/u.test(value)
        || isToolProgressLabel(value)
}

export interface TelegramPresentationOptions {
    /** Live-Statuskarte: keep the progress message and finish it with ✅/❌ instead of deleting it. */
    statusCard?: boolean
    /** Throttle for status-card edits (default 2 s). */
    minEditIntervalMs?: number
}

/** A final reply that reports a failure turns the status card into ❌. */
export function isTelegramFailureReply(text: string): boolean {
    const value = String(text || '').trim()
    // 2.89.14: a verification note in front of a real answer is no failure (live: the L12 note closed the card as ❌ and the answer came twice).
    if (value.startsWith(L12_UNVERIFIED_NOTE) || value.startsWith(UNVERIFIED_NOTE)) return false
    return /^(?:❌|⚠️|🚫)/u.test(value) || /^(?:Die Anfrage wurde abgebrochen|Fehler\b|Abgebrochen\b)/i.test(value)
        || FAILURE_REPLY_START.test(value)
}

/** 2.90.1 (Codekarte D3): openings of the runner's/pipeline's own failure and limit texts (escalation,
 * honestNoToolResponse, userFacingVerdictMessage, unfinishedRunNotice, limitStopNotice, run timeout).
 * Only the opening counts: an answer that mentions a failure later in a sentence stays a success. */
const FAILURE_REPLY_START = new RegExp('^(?:' + [
    'Die Aktion ist nicht gelungen',
    'Das habe ich gerade nicht hinbekommen',
    'Ich konnte die Aufgabe nicht als abgeschlossen bestätigen',
    'Ich bin mit dieser Aufgabe noch nicht ganz fertig geworden',
    'Das war viel auf einmal: Ich habe nach \\d+ Arbeitsschritten angehalten',
    'Das Werkzeug \\S+ hat länger als \\d+ s gebraucht',
    'Die Zeitgrenze für diese Aufgabe ist abgelaufen',
    'Die erlaubte Anzahl an Werkzeugaufrufen',
    'Das hat zu lange gedauert',
].join('|') + ')', 'u')

/** One inbound request owns one visible lifecycle: progress is edited in place,
 * then removed before the final/clarification/error response is delivered
 * (status-card mode 2.89.4: the card is deleted after the answer arrived; a
 * failure keeps one ❌ line with the reason). */
export class TelegramPresentationSession {
    private progressMessageId: number | null = null
    private lastProgress = ''
    private card: LiveStatusCard | null = null
    private readonly startedAt = Date.now()
    private answerDelivered = false

    constructor(
        private readonly adapter: TelegramPresentationAdapter,
        private readonly chatId: string,
        private readonly options: TelegramPresentationOptions = {},
    ) {}

    async deliver(raw: string): Promise<'progress' | 'message' | 'empty'> {
        const text = formatTelegramMessage(raw)
        if (!text) return 'empty'
        if (this.options.statusCard) {
            if (isTelegramProgress(text)) {
                this.card ||= new LiveStatusCard({
                    send: body => this.adapter.sendProgress(this.chatId, body),
                    edit: (messageId, body) => this.adapter.editMessage(this.chatId, messageId, body),
                    delete: messageId => this.adapter.deleteMessage(this.chatId, messageId),
                }, { minIntervalMs: this.options.minEditIntervalMs ?? 2_000, chatId: this.chatId, startedAt: this.startedAt })
                await this.card.update(text)
                return 'progress'
            }
            try {
                await this.adapter.send({ channel: 'telegram', to: this.chatId, content: text })
                this.answerDelivered = !isTelegramFailureReply(text)
                // 2.89.4: remove the progress card after the answer — "✅ Fertig" before the
                // answer read like an empty reply. A failure keeps one ❌ line with the reason.
                if (this.answerDelivered) await this.dismissProgress()
                else await this.finishProgress(false, text)
            } catch (error) {
                await this.finishProgress(false, String((error as Error)?.message || error))
                throw error
            }
            return 'message'
        }
        if (isTelegramProgress(text)) {
            if (text === this.lastProgress) return 'progress'
            this.lastProgress = text
            if (this.progressMessageId === null) {
                this.progressMessageId = await this.adapter.sendProgress(this.chatId, text)
            } else {
                await this.adapter.editMessage(this.chatId, this.progressMessageId, text)
            }
            return 'progress'
        }

        await this.clearProgress()
        await this.adapter.send({ channel: 'telegram', to: this.chatId, content: text })
        return 'message'
    }

    /** End of the request: status-card mode finishes the card (✅/❌), otherwise the bubble is removed. */
    async finishProgress(ok: boolean, detail?: string): Promise<void> {
        if (!this.options.statusCard) return this.clearProgress()
        const card = this.card
        if (!card || card.isFinished) return
        // 2.89.4: an abort always says why — a bare „Abgebrochen · N s" told the owner nothing.
        await card.finish(ok, detail || (ok ? undefined : 'Keine fertige Antwort angekommen.'))
    }

    /** 2.89.4: delete the card after the answer; if delete fails it stays briefly. */
    async dismissProgress(): Promise<void> {
        const card = this.card
        if (!card) return
        await card.dismiss()
    }

    async clearProgress(): Promise<void> {
        if (this.options.statusCard) {
            if (this.answerDelivered) return this.dismissProgress()
            return this.finishProgress(this.answerDelivered)
        }
        if (this.progressMessageId === null) return
        const messageId = this.progressMessageId
        this.progressMessageId = null
        this.lastProgress = ''
        await this.adapter.deleteMessage(this.chatId, messageId)
    }
}
