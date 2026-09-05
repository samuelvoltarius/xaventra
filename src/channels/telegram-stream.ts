/**
 * Telegram Draft Streaming
 *
 * Instead of waiting for the full response and sending it at once,
 * this sends a "thinking" message and progressively edits it
 * as the LLM generates tokens. Adapted from OpenClaw's draft-stream.ts.
 *
 * Flow:
 * 1. Send initial "⏳" message
 * 2. Collect tokens into paragraphs
 * 3. Edit message every ~500ms with accumulated text
 * 4. Final edit with complete response
 * 5. Respect Telegram rate limits (30 edits/sec per bot)
 */

// ============================================
// Types
// ============================================

export interface StreamConfig {
    /** Min interval between edits (ms). Default: 800 */
    editIntervalMs: number
    /** Min chars before first edit. Default: 50 */
    minCharsBeforeEdit: number
    /** Max edits per message. Default: 30 */
    maxEdits: number
    /** Show typing indicator message. Default: '⏳' */
    thinkingMessage: string
}

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
    editIntervalMs: 800,
    minCharsBeforeEdit: 50,
    maxEdits: 30,
    thinkingMessage: '⏳',
}

// ============================================
// Draft Stream Manager
// ============================================

export class DraftStream {
    private config: StreamConfig
    private buffer = ''
    private lastEditTime = 0
    private editCount = 0
    private messageId: number | null = null
    private chatId: number | string | null = null
    private editFn: ((chatId: number | string, messageId: number, text: string) => Promise<void>) | null = null
    private isCompleted = false

    constructor(config: Partial<StreamConfig> = {}) {
        this.config = { ...DEFAULT_STREAM_CONFIG, ...config }
    }

    /**
     * Start streaming — sends initial thinking message.
     * Returns the message ID for tracking.
     */
    async start(
        chatId: number | string,
        sendFn: (chatId: number | string, text: string) => Promise<number>,
        editFn: (chatId: number | string, messageId: number, text: string) => Promise<void>
    ): Promise<number> {
        this.chatId = chatId
        this.editFn = editFn
        this.buffer = ''
        this.editCount = 0
        this.isCompleted = false

        // Send initial thinking message
        this.messageId = await sendFn(chatId, this.config.thinkingMessage)
        this.lastEditTime = Date.now()

        return this.messageId
    }

    /**
     * Push new tokens/text into the buffer.
     * Will auto-edit the message if enough time has passed.
     */
    async push(text: string): Promise<void> {
        if (this.isCompleted) return

        this.buffer += text

        // Check if we should edit
        const now = Date.now()
        const timeSinceLastEdit = now - this.lastEditTime
        const hasEnoughContent = this.buffer.length >= this.config.minCharsBeforeEdit

        if (
            hasEnoughContent &&
            timeSinceLastEdit >= this.config.editIntervalMs &&
            this.editCount < this.config.maxEdits &&
            this.messageId &&
            this.chatId &&
            this.editFn
        ) {
            try {
                await this.editFn(this.chatId, this.messageId, this.buffer)
                this.editCount++
                this.lastEditTime = now
            } catch (err) {
                // Telegram edit can fail if content unchanged or rate limited
                console.warn(`[TelegramStream] Edit failed: ${err}`)
            }
        }
    }

    /**
     * Complete the stream — sends final edit with full text.
     */
    async complete(finalText?: string): Promise<void> {
        if (this.isCompleted) return
        this.isCompleted = true

        const text = finalText || this.buffer

        if (text && this.messageId && this.chatId && this.editFn) {
            try {
                await this.editFn(this.chatId, this.messageId, text)
            } catch (err) {
                console.warn(`[TelegramStream] Final edit failed: ${err}`)
            }
        }
    }

    /**
     * Abort the stream — edit message with error.
     */
    async abort(_errorMessage: string = '❌ Streaming abgebrochen'): Promise<void> {
        this.isCompleted = true

        if (this.messageId && this.chatId && this.editFn) {
            try {
                await this.editFn(this.chatId, this.messageId, '❌ Streaming abgebrochen')
            } catch { /* ignore */ }
        }
    }

    /**
     * Get current buffer content.
     */
    getBuffer(): string {
        return this.buffer
    }

    /**
     * Get stats.
     */
    getStats(): { editCount: number; bufferLength: number; isCompleted: boolean } {
        return {
            editCount: this.editCount,
            bufferLength: this.buffer.length,
            isCompleted: this.isCompleted,
        }
    }
}

// ============================================
// Factory
// ============================================

export function createDraftStream(config?: Partial<StreamConfig>): DraftStream {
    return new DraftStream(config)
}

export default { DraftStream, createDraftStream, DEFAULT_STREAM_CONFIG }
