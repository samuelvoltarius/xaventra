/**
 * 2.89 Paket E: progress is a side channel, never part of the answer.
 *
 * Before: every runner step ("⚙️ Schritt 2/3 …"), every routing notice and a
 * heartbeat every 25 s went through the reply function. Telegram got a flood,
 * and collecting channels (Desktop room, Dashboard, REST, voice, mesh) mixed
 * the status lines into the stored answer.
 *
 * Now (one rule for every channel):
 *   - Chat channels (Telegram, WhatsApp, Discord, …) get at most ONE short
 *     message, and only when the run takes longer than ~20 s.
 *   - Every other channel never receives progress through the reply function;
 *     an optional side sink (MessageContext.onProgress) gets the raw status.
 *   - Routing notices (not plain step labels) are kept for the run outcome.
 */

const CHAT_PROGRESS_CHANNELS = new Set(['telegram', 'whatsapp', 'discord', 'slack', 'matrix', 'signal', 'teams', 'cli'])

export const PROGRESS_FIRST_AFTER_MS = 20_000
let firstAfterOverride: number | null = null

/** Test hook: shorter first-progress delay for live-path tests (null = default). */
export function setProgressFirstAfterForTests(ms: number | null): void {
    firstAfterOverride = ms
}

/** True when progress may appear as a chat message on this channel. */
export function progressGoesToChat(channel: string): boolean {
    return CHAT_PROGRESS_CHANNELS.has(String(channel || '').trim().toLowerCase())
}

/** Runner step labels (tool sequence) are not notices worth keeping. */
function isStepLabel(status: string): boolean {
    return /^\s*(?:⚙️|🔄|🔍|📥|🛠️)/u.test(status)
}

export interface ProgressNoticeOptions {
    channel: string
    /** False for system messages, mesh contracts and internal actors: no progress at all. */
    enabled: boolean
    reply: (message: string) => Promise<void>
    /** Side sink for non-chat channels (never the answer). */
    onProgress?: (status: string) => void
    firstAfterMs?: number
    now?: () => number
}

export interface ProgressNotice {
    update(status: string): void
    close(): void
    readonly closed: boolean
    /** Number of progress messages sent through the reply function (0 or 1). */
    readonly sent: number
    /** Routing notices of this run (e.g. "Codex ist gerade nicht erreichbar – ich arbeite lokal weiter."). */
    readonly notices: string[]
}

export function createProgressNotice(options: ProgressNoticeOptions): ProgressNotice {
    const now = options.now || Date.now
    const startedAt = now()
    const chat = options.enabled && progressGoesToChat(options.channel)
    const notices: string[] = []
    let latestNotice = ''
    let closed = false
    let sent = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const fire = async (): Promise<void> => {
        timer = null
        if (closed || sent > 0) return
        sent = 1
        const seconds = Math.max(1, Math.round((now() - startedAt) / 1000))
        const text = latestNotice
            ? `⏳ Ich arbeite noch (${seconds} s) — ${latestNotice}`
            : `⏳ Ich arbeite noch daran (${seconds} s) …`
        try {
            await options.reply(text)
        } catch (error) {
            console.warn(`[Fortschritt] Hinweis nicht zugestellt (${options.channel}): ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    if (chat) {
        timer = setTimeout(() => { void fire() }, options.firstAfterMs ?? firstAfterOverride ?? PROGRESS_FIRST_AFTER_MS)
        timer.unref?.()
    }

    return {
        update(status: string): void {
            if (closed || !options.enabled) return
            const value = String(status || '').replace(/\s+/g, ' ').trim().slice(0, 200)
            if (!value) return
            if (!isStepLabel(value)) {
                latestNotice = value
                if (!notices.includes(value)) notices.push(value)
            }
            if (!chat && options.onProgress) {
                try { options.onProgress(value) } catch (error) {
                    console.warn(`[Fortschritt] Seitenkanal fehlgeschlagen (${options.channel}): ${error instanceof Error ? error.message : String(error)}`)
                }
            }
        },
        close(): void {
            closed = true
            if (timer) clearTimeout(timer)
            timer = null
        },
        get closed() { return closed },
        get sent() { return sent },
        get notices() { return [...notices] },
    }
}
