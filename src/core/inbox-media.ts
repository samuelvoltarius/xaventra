/**
 * Incoming pictures of the owner (Telegram, Desktop, ...) used to live only in memory for the one
 * model call. A follow-up ("Was sagst du zu dem Foto ?") and any tool that needs a file path
 * (e.g. plate solving) could not reach them. The owner's pictures are now kept as files in the
 * runtime data folder, bounded by age and total size, and the conversation history notes the path.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

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

/**
 * A model may garble a long path it was told (live 08.10.2026: ".../inbox-media/2026-10-08/18-37-08_8e5046.jpg"
 * instead of ".../inbox-media/2026-10-08-9b96758e5046.jpg"). A path that does not exist is mapped to the
 * stored picture it clearly means: same file name, same trailing hash, or - for any path inside an
 * inbox-media folder - the newest picture of the last hour. Anything else stays unresolved (null).
 */
export function resolveInboxImagePath(requested: string, now = Date.now(), dir = inboxMediaDir()): string | null {
    const wanted = String(requested || '').trim()
    if (!wanted) return null
    if (existsSync(wanted)) return wanted
    const slashed = wanted.split(String.fromCharCode(92)).join('/')
    if (!/inbox-media/i.test(slashed) || !existsSync(dir)) return null
    const files = readdirSync(dir).map(name => {
        const path = join(dir, name)
        try { const stat = statSync(path); return stat.isFile() ? { name, path, mtime: stat.mtimeMs } : null } catch { return null }
    }).filter((file): file is { name: string; path: string; mtime: number } => file !== null).sort((a, b) => b.mtime - a.mtime)
    if (files.length === 0) return null
    const name = basename(slashed)
    const exact = files.find(file => file.name === name)
    if (exact) return exact.path
    const tail = /([0-9a-f]{6,12})\.[a-z0-9]+$/i.exec(name)?.[1]?.toLowerCase()
    if (tail) {
        const byHash = files.find(file => file.name.toLowerCase().replace(/\.[a-z0-9]+$/, '').endsWith(tail))
        if (byHash) return byHash.path
    }
    const recent = files.find(file => now - file.mtime <= 3600_000)
    return recent ? recent.path : null
}

/**
 * Prompt block for a stored incoming picture: the file path serves tools that need a path, e.g.
 * `astro_plate_solve` (skill pack "astro", not routed for a bare "Was ist das?").
 * `seesImage`: the active model already receives the picture in this call - no tool is needed to look at it.
 */
export function inboxImagePromptBlock(path: string, seesImage = false): string {
    const direct = seesImage
        ? '\nDas Bild liegt dir bereits vor - antworte direkt darauf. analyze_image ist für dieses Bild nicht nötig.'
        : ''
    return `

## Eingehendes Bild
Das Bild dieser Nachricht liegt als Datei unter ${path}. Werkzeuge, die einen Dateipfad brauchen, nutzen genau diesen Pfad.${direct}
Bei Astrofotos (Nebel, Galaxie, Sternfeld): Skill-Pack "astro" mit load_skill_pack laden und astro_plate_solve mit image_path=${path} aufrufen, bevor ein Objekt als Tatsache genannt wird.`
}
