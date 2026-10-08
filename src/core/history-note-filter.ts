/**
 * 2.89.2: internal context lines ("[Verlaufsnotiz …]", "(Kontext: …)") exist for the model only.
 * A model may copy the pattern into its answer (live 08.10.2026); nothing of it may reach a user.
 * This is the one cleaning step applied before every delivery.
 */
export const HISTORY_NOTE_MARKERS = /\[Verlaufsnotiz|^\s*\(Kontext:|\(Kontext: zuvor/i

export function stripInternalHistoryNotes(text: string): string {
    const source = String(text ?? '')
    if (!HISTORY_NOTE_MARKERS.test(source) && !/\n\s*\(Kontext:/i.test(source)) return source
    const kept: string[] = []
    for (const line of source.split('\n')) {
        const note = line.search(/\[Verlaufsnotiz|\(Kontext:/i)
        if (note < 0) { kept.push(line); continue }
        const before = line.slice(0, note).replace(/[ \t]+$/, '')
        if (before.trim()) kept.push(before)
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
}

/** The pipeline's delivery function, with internal notes removed from every message. */
export function withoutInternalNotes(send: (text: string) => Promise<void>): (text: string) => Promise<void> {
    return async text => {
        const cleaned = typeof text === 'string' ? stripInternalHistoryNotes(text) : text
        if (typeof text === 'string' && text.trim() && !String(cleaned).trim()) return send('Ich habe dazu keine eigene Antwort formuliert.')
        return send(cleaned)
    }
}

/** The "(Kontext: zuvor ausgeführt — …)" block of a user history entry: context for the next answer, not something the user said. */
export function withoutContextNote(content: string): string {
    const text = String(content ?? '')
    const at = text.search(/\n\(Kontext: zuvor ausgeführt/)
    return at < 0 ? text : text.slice(0, at)
}
