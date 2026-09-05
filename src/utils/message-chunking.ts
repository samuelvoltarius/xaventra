/**
 * Nova - Message Chunking
 * 
 * Inspired by OpenClaw's auto-reply/chunk.ts + inbound-debounce.ts
 * Splits long messages for Telegram (4096 char limit),
 * debounces rapid-fire inbound messages.
 */

// ============================================
// Types
// ============================================

export interface ChunkOptions {
    maxLength: number
    splitOn: 'newline' | 'sentence' | 'word'
    preserveCodeBlocks: boolean
    addContinuation: boolean
}

export interface DebouncedMessage {
    chatId: string
    content: string
    timestamp: number
}

// ============================================
// Message Chunking
// ============================================

const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
    maxLength: 4000, // Telegram limit is 4096, leave margin
    splitOn: 'newline',
    preserveCodeBlocks: true,
    addContinuation: true,
}

/**
 * Split a long message into chunks that fit within platform limits.
 * Tries to split at natural boundaries (newlines, sentences, words).
 * Preserves code blocks (won't split mid-block).
 */
export function chunkMessage(
    text: string,
    options: Partial<ChunkOptions> = {},
): string[] {
    const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options }

    if (text.length <= opts.maxLength) {
        return [text]
    }

    // If preserving code blocks, handle them specially
    if (opts.preserveCodeBlocks) {
        return chunkWithCodeBlocks(text, opts)
    }

    return chunkText(text, opts)
}

/**
 * Chunk text while keeping code blocks intact.
 */
function chunkWithCodeBlocks(text: string, opts: ChunkOptions): string[] {
    const chunks: string[] = []
    // Split into code and non-code segments
    const segments = text.split(/(```[\s\S]*?```)/g)

    let currentChunk = ''

    for (const segment of segments) {
        const isCodeBlock = segment.startsWith('```')

        if (isCodeBlock) {
            // If code block + current content exceeds limit, flush current
            if (currentChunk.length + segment.length > opts.maxLength) {
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim())
                }
                // If code block itself exceeds limit, split it
                if (segment.length > opts.maxLength) {
                    const codeParts = splitCodeBlock(segment, opts.maxLength)
                    chunks.push(...codeParts)
                    currentChunk = ''
                } else {
                    currentChunk = segment
                }
            } else {
                currentChunk += segment
            }
        } else {
            // Regular text
            if (currentChunk.length + segment.length > opts.maxLength) {
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim())
                }
                // Split the text segment if needed
                const subChunks = chunkText(segment, opts)
                if (subChunks.length > 0) {
                    // Add all but last to chunks, keep last as current
                    for (let i = 0; i < subChunks.length - 1; i++) {
                        chunks.push(subChunks[i])
                    }
                    currentChunk = subChunks[subChunks.length - 1]
                } else {
                    currentChunk = ''
                }
            } else {
                currentChunk += segment
            }
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim())
    }

    // Add continuation markers
    if (opts.addContinuation && chunks.length > 1) {
        return chunks.map((chunk, i) => {
            if (i < chunks.length - 1) {
                return `${chunk}\n\n_... (${i + 1}/${chunks.length})_`
            }
            return chunk
        })
    }

    return chunks
}

/**
 * Split a code block that exceeds the max length.
 */
function splitCodeBlock(block: string, maxLength: number): string[] {
    const lines = block.split('\n')
    const lang = lines[0] // e.g., "```typescript"
    const closingTag = '```'
    const chunks: string[] = []

    let currentLines: string[] = [lang]
    let currentLength = lang.length + 1

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]
        if (line === '```') continue // Skip closing tag, we'll add it

        if (currentLength + line.length + 1 + closingTag.length + 1 > maxLength) {
            // Flush current chunk
            currentLines.push(closingTag)
            chunks.push(currentLines.join('\n'))
            currentLines = [lang] // Start new code block
            currentLength = lang.length + 1
        }

        currentLines.push(line)
        currentLength += line.length + 1
    }

    if (currentLines.length > 1) {
        currentLines.push(closingTag)
        chunks.push(currentLines.join('\n'))
    }

    return chunks
}

/**
 * Chunk plain text at natural boundaries.
 */
function chunkText(text: string, opts: ChunkOptions): string[] {
    const chunks: string[] = []
    let remaining = text

    while (remaining.length > opts.maxLength) {
        let splitIdx = -1

        const searchRange = remaining.slice(0, opts.maxLength)

        switch (opts.splitOn) {
            case 'newline': {
                // Find last double-newline within limit
                splitIdx = searchRange.lastIndexOf('\n\n')
                if (splitIdx === -1) splitIdx = searchRange.lastIndexOf('\n')
                break
            }
            case 'sentence': {
                // Find last sentence boundary
                const sentenceEnd = searchRange.match(/.*[.!?]\s/s)
                if (sentenceEnd) splitIdx = sentenceEnd[0].length
                break
            }
            case 'word': {
                splitIdx = searchRange.lastIndexOf(' ')
                break
            }
        }

        // Fallback: split at max length
        if (splitIdx <= 0) splitIdx = opts.maxLength

        chunks.push(remaining.slice(0, splitIdx).trim())
        remaining = remaining.slice(splitIdx).trim()
    }

    if (remaining.trim()) {
        chunks.push(remaining.trim())
    }

    return chunks
}

// ============================================
// Inbound Debounce
// ============================================

type DebounceCallback = (combinedMessage: string, chatId: string) => void

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingMessages = new Map<string, DebouncedMessage[]>()

/**
 * Debounce rapid-fire inbound messages from the same chat.
 * Combines messages received within the wait window into a single message.
 * 
 * Inspired by OpenClaw's inbound-debounce.ts:
 * When users send multiple messages quickly, this combines them
 * before passing to the LLM for a single unified response.
 */
export function debounceInbound(
    chatId: string,
    content: string,
    callback: DebounceCallback,
    waitMs = 1500,
): void {
    // Add to pending
    const pending = pendingMessages.get(chatId) || []
    pending.push({ chatId, content, timestamp: Date.now() })
    pendingMessages.set(chatId, pending)

    // Clear existing timer
    const existingTimer = debounceTimers.get(chatId)
    if (existingTimer) {
        clearTimeout(existingTimer)
    }

    // Set new timer
    const timer = setTimeout(() => {
        const messages = pendingMessages.get(chatId) || []
        pendingMessages.delete(chatId)
        debounceTimers.delete(chatId)

        if (messages.length === 0) return

        // Combine all pending messages
        const combined = messages.map(m => m.content).join('\n')
        callback(combined, chatId)
    }, waitMs)

    debounceTimers.set(chatId, timer)
}

/**
 * Cancel any pending debounced messages for a chat.
 */
export function cancelDebounce(chatId: string): void {
    const timer = debounceTimers.get(chatId)
    if (timer) {
        clearTimeout(timer)
        debounceTimers.delete(chatId)
    }
    pendingMessages.delete(chatId)
}

/**
 * Get the count of pending debounced messages for a chat.
 */
export function getPendingCount(chatId: string): number {
    return pendingMessages.get(chatId)?.length || 0
}

/**
 * Clear all debounce state (useful for shutdown).
 */
export function clearAllDebounce(): void {
    for (const timer of debounceTimers.values()) {
        clearTimeout(timer)
    }
    debounceTimers.clear()
    pendingMessages.clear()
}
