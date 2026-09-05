import { createHash } from 'node:crypto'

export interface ToolResultPruneOptions { maxBytes?: number; headBytes?: number; tailBytes?: number }
export interface ToolResultPruneReport { value: unknown; pruned: boolean; originalBytes: number; retainedBytes: number; sha256: string }

function bytes(value: unknown): number {
    try { return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) }
    catch { return Buffer.byteLength(String(value)) }
}

function compactString(value: string, maxBytes: number, headBytes: number, tailBytes: number, hash: string): string {
    if (Buffer.byteLength(value) <= maxBytes) return value
    const data = Buffer.from(value)
    const head = data.subarray(0, headBytes).toString('utf8')
    const tail = data.subarray(-tailBytes).toString('utf8')
    return `${head}\n\n[tool result pruned: sha256=${hash}, originalBytes=${data.length}]\n\n${tail}`
}

/** Model-facing deterministic pruning; the full Tool Evidence stays in the ledger. */
export function pruneToolResult(value: unknown, options: ToolResultPruneOptions = {}): ToolResultPruneReport {
    const maxBytes = Math.max(1_024, options.maxBytes || 24_000)
    const headBytes = Math.min(maxBytes - 256, Math.max(256, options.headBytes || Math.floor(maxBytes * 0.7)))
    const tailBytes = Math.min(maxBytes - headBytes, Math.max(128, options.tailBytes || Math.floor(maxBytes * 0.2)))
    const serialized = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) } catch { return String(value) } })()
    const originalBytes = Buffer.byteLength(serialized)
    const sha256 = createHash('sha256').update(serialized).digest('hex')
    if (originalBytes <= maxBytes) return { value, pruned: false, originalBytes, retainedBytes: originalBytes, sha256 }
    const pruned = typeof value === 'string'
        ? compactString(value, maxBytes, headBytes, tailBytes, sha256)
        : Object.freeze({ __novaPruned: true, sha256, originalBytes, preview: compactString(serialized, maxBytes, headBytes, tailBytes, sha256) })
    return { value: pruned, pruned: true, originalBytes, retainedBytes: bytes(pruned), sha256 }
}

export function pruneToolMessages<T extends { role: string; content: string }>(messages: T[], maxBytes = 24_000): T[] {
    return messages.map(message => message.role === 'tool'
        ? { ...message, content: String(pruneToolResult(message.content, { maxBytes }).value) }
        : message)
}
