/**
 * 2.89.1: in-memory progress status of running Desktop room requests.
 *
 * The pipeline reports progress through a side sink (progress-notice.ts), never
 * through the answer. For Desktop rooms that sink writes here; GET
 * /api/desktop/fortschritt reads the latest state per room (and the most recent
 * one overall). Entries are cleared when the run ends.
 */

export interface DesktopProgressEntry { step: string; at: string }

const MAX_STEP_CHARS = 160
const byRoom = new Map<string, DesktopProgressEntry>()
let latest: (DesktopProgressEntry & { roomId: string }) | null = null

export function recordDesktopProgress(roomId: string, status: string): void {
    const step = String(status || '').replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_CHARS)
    if (!roomId || !step) return
    const entry = { step, at: new Date().toISOString() }
    byRoom.set(roomId, entry)
    latest = { ...entry, roomId }
}

export function clearDesktopProgress(roomId: string): void {
    byRoom.delete(roomId)
    if (latest?.roomId === roomId) latest = null
}

export function readDesktopProgress(roomId?: string): (DesktopProgressEntry & { roomId?: string }) | null {
    if (roomId) {
        const entry = byRoom.get(roomId)
        return entry ? { ...entry, roomId } : null
    }
    return latest ? { ...latest } : null
}

export function resetDesktopProgressForTests(): void {
    byRoom.clear()
    latest = null
}
