/**
 * Live-Statuskarte (Autonomie-Plan Phase 1 Teil A): one Telegram message per
 * task, edited in place — ⏳/⚙️ Schritt n/m … → ✅ / ❌ — instead of silence or
 * a flood of messages.
 *
 * - Throttled: at most one edit per `minIntervalMs` (default 2 s); the newest
 *   pending text is flushed when the window opens. The final ✅/❌ edit is
 *   sent at once (exactly one extra edit).
 * - Never breaks the task: a failing send disables the card for this task, a
 *   failing edit is logged and ignored.
 * - The card only edits the message it created itself.
 */

export interface StatusCardTransport {
    send(text: string): Promise<number | null>
    edit(messageId: number, text: string): Promise<void>
}

export interface StatusCardOptions {
    startedAt?: number
    minIntervalMs?: number
    now?: () => number
    chatId?: string
}

interface ActiveCard { id: number; chatId: string; text: string; startedAt: number; updatedAt: number }

const active = new Map<number, ActiveCard>()
let nextId = 1

/** Running status cards of this process (for /jetzt). */
export function listActiveStatusCards(): ActiveCard[] {
    return [...active.values()].map(card => ({ ...card }))
}

const STEP = /Schritt\s+(\d+)\s*\/\s*(\d+)/i

export class LiveStatusCard {
    private messageId: number | null = null
    private disabled = false
    private finished = false
    private lastEditAt = 0
    private lastSent = ''
    private pending: string | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private readonly startedAt: number
    private readonly id = nextId++
    private maxStep = 0
    private updates = 0
    private readonly minIntervalMs: number
    private readonly now: () => number

    constructor(private readonly transport: StatusCardTransport, private readonly options: StatusCardOptions = {}) {
        this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 2_000)
        this.now = options.now ?? Date.now
        this.startedAt = options.startedAt ?? this.now()
    }

    get message(): number | null { return this.messageId }
    get isFinished(): boolean { return this.finished }

    async update(raw: string): Promise<void> {
        const text = String(raw ?? '').trim().slice(0, 900)
        if (!text || this.finished || this.disabled) return
        this.updates++
        const step = STEP.exec(text)
        if (step) this.maxStep = Math.max(this.maxStep, Number(step[2]) || 0, Number(step[1]) || 0)
        this.track(text)
        if (this.messageId === null) {
            try {
                const id = await this.transport.send(text)
                if (typeof id !== 'number') { this.disable(); return }
                this.messageId = id
                this.lastEditAt = this.now()
                this.lastSent = text
            } catch (error) {
                console.warn(`[Statuskarte] Senden fehlgeschlagen, Karte für diese Aufgabe aus: ${String((error as Error)?.message || error).slice(0, 160)}`)
                this.disable()
            }
            return
        }
        if (text === this.lastSent && this.pending === null) return
        const wait = this.lastEditAt + this.minIntervalMs - this.now()
        if (wait <= 0 && !this.timer) {
            await this.edit(text)
            return
        }
        this.pending = text
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null
                const next = this.pending
                this.pending = null
                if (next !== null && !this.finished) void this.edit(next)
            }, Math.max(0, wait))
            ;(this.timer as any).unref?.()
        }
    }

    /** Final state. Returns without doing anything if the card was never shown. */
    async finish(ok: boolean, detail?: string): Promise<void> {
        if (this.finished) return
        this.finished = true
        if (this.timer) { clearTimeout(this.timer); this.timer = null }
        this.pending = null
        active.delete(this.id)
        if (this.messageId === null || this.disabled) return
        const seconds = Math.max(0, Math.round((this.now() - this.startedAt) / 1000))
        const steps = this.maxStep > 0 ? `${this.maxStep} Schritte` : `${this.updates} Statusmeldungen`
        const head = ok ? `✅ Antwort gesendet · ${steps} · ${seconds} s` : `❌ Abgebrochen · ${steps} · ${seconds} s`
        const tail = detail ? `\n${String(detail).trim().slice(0, 300)}` : ''
        await this.edit(`${head}${tail}`)
    }

    private async edit(text: string): Promise<void> {
        if (this.messageId === null) return
        this.lastEditAt = this.now()
        this.lastSent = text
        try {
            await this.transport.edit(this.messageId, text)
        } catch (error) {
            const message = String((error as Error)?.message || error)
            if (!/not modified/i.test(message)) console.warn(`[Statuskarte] Bearbeiten fehlgeschlagen (ignoriert): ${message.slice(0, 160)}`)
        }
    }

    private track(text: string): void {
        const existing = active.get(this.id)
        active.set(this.id, { id: this.id, chatId: this.options.chatId || '', text, startedAt: existing?.startedAt ?? this.startedAt, updatedAt: this.now() })
    }

    private disable(): void {
        this.disabled = true
        active.delete(this.id)
    }
}
