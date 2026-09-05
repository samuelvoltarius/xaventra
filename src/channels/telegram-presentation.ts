import type { OutgoingMessage } from '../core/types.js'

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
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/^\s*[-*]\s+\[x\]\s+/gim, '✅ ')
        .replace(/^\s*[-*]\s+\[ \]\s+/gim, '⬜ ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

export function isTelegramProgress(text: string): boolean {
    const value = String(text || '').trim()
    return /^(?:⏳|⚙️|🔄|🔍|📥|🛠️)\s*/u.test(value)
        || /^Ich arbeite noch\b/i.test(value)
}

/** One inbound request owns one visible lifecycle: progress is edited in place,
 * then removed before the final/clarification/error response is delivered. */
export class TelegramPresentationSession {
    private progressMessageId: number | null = null
    private lastProgress = ''

    constructor(
        private readonly adapter: TelegramPresentationAdapter,
        private readonly chatId: string,
    ) {}

    async deliver(raw: string): Promise<'progress' | 'message' | 'empty'> {
        const text = formatTelegramMessage(raw)
        if (!text) return 'empty'
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

    async clearProgress(): Promise<void> {
        if (this.progressMessageId === null) return
        const messageId = this.progressMessageId
        this.progressMessageId = null
        this.lastProgress = ''
        await this.adapter.deleteMessage(this.chatId, messageId)
    }
}
