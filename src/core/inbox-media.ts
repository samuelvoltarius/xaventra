/**
 * Incoming pictures of the owner (Telegram, Desktop, ...) used to live only in memory for the one
 * model call. A follow-up ("Was sagst du zu dem Foto ?") and any tool that needs a file path
 * (e.g. plate solving) could not reach them. The owner's pictures are now kept as files in the
 * runtime data folder, bounded by age and total size, and the conversation history notes the path.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INBOX_MEDIA_MAX_AGE_MS = 7 * 24 * 3600 * 1000
export const INBOX_MEDIA_MAX_TOTAL_BYTES = 200 * 1024 * 1024
export const INBOX_MEDIA_MAX_FILE_BYTES = 25 * 1024 * 1024

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

export function inboxMediaDir(): string {
    return join(process.cwd(), '.nova-data', 'inbox-media')
}

/** Removes files older than the retention window, then the oldest ones above the size cap. */
export function pruneInboxMedia(now = Date.now(), dir = inboxMediaDir()): number {
    if (!existsSync(dir)) return 0
    let removed = 0
    const files = readdirSync(dir).map(name => {
        const path = join(dir, name)
        try { const stat = statSync(path); return stat.isFile() ? { path, size: stat.size, mtime: stat.mtimeMs } : null } catch { return null }
    }).filter((file): file is { path: string; size: number; mtime: number } => file !== null).sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
        if (now - file.mtime > INBOX_MEDIA_MAX_AGE_MS || total > INBOX_MEDIA_MAX_TOTAL_BYTES) {
            try { unlinkSync(file.path); total -= file.size; removed++ } catch { /* in use: next run */ }
        }
    }
    return removed
}

/** Stores one incoming picture (content-addressed, so a resend is the same file). Returns its absolute path. */
export function storeInboxImage(image: { data: string; mimeType?: string }, now = Date.now()): string | null {
    try {
        const bytes = Buffer.from(String(image.data || ''), 'base64')
        if (bytes.length === 0 || bytes.length > INBOX_MEDIA_MAX_FILE_BYTES) return null
        const extension = EXTENSIONS[String(image.mimeType || '').toLowerCase()] || 'jpg'
        const dir = inboxMediaDir()
        mkdirSync(dir, { recursive: true })
        const day = new Date(now).toISOString().slice(0, 10)
        const path = join(dir, `${day}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${extension}`)
        if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 })
        pruneInboxMedia(now, dir)
        return path
    } catch { return null }
}
