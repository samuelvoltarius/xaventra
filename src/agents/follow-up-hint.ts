/**
 * 2.89.2: a short question right after an answer ("Was ist mit dem lab?", "Von welchem Knoten kam das Bild?")
 * almost always refers to that answer. The model gets that stated plainly, with the answer it refers to.
 */
const STARTS = /^(und|aber|dann|auch|noch|sonst|wieso|warum|weshalb|wie (?:ist|war|sieht)|was (?:ist|war|sagst du|meinst du)|wo (?:ist|war)|von welche[mnrs]?|welche[mnrs]?|wann|davon|dazu|damit|dort)\b/i
const REFERS = /\b(?:das|dem|den|der|dieses?|diesem|dieser) (?:bild|foto|screenshot|aufnahme|ergebnis|ding)\b|\b(?:dazu|davon|damit|dort|darauf|daran)\b|\bmit dem\b/i

export function isLikelyFollowUp(content: string): boolean {
    const text = String(content || '').trim()
    if (!text || text.startsWith('/') || text.length > 120) return false
    if (text.split(/\s+/).length > 12) return false
    return STARTS.test(text) || REFERS.test(text)
}

export interface HistoryEntryLike { role: string; content: unknown; timestamp?: number }

/** System hint for the model, or '' when the message is not a likely follow-up to a recent answer. */
export function followUpHint(content: string, history: HistoryEntryLike[], now: number = Date.now(), maxAgeMs = 45 * 60_000): string {
    if (!isLikelyFollowUp(content)) return ''
    let index = -1
    for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'assistant') { index = i; break }
    if (index < 0) return ''
    const answer = history[index]
    if (typeof answer.timestamp === 'number' && now - answer.timestamp > maxAgeMs) return ''
    const flat = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()
    const before = history[index - 1]
    const asked = before?.role === 'user' ? flat(before.content).slice(0, 220) : ''
    const given = flat(answer.content).slice(0, 700)
    if (!given) return ''
    return `Hinweis zum Gesprächszusammenhang: Die neue Nachricht ist kurz und bezieht sich sehr wahrscheinlich auf deine vorige Antwort.${asked ? ` Vorige Anfrage: "${asked}".` : ''} Deine vorige Antwort (und die Werkzeugergebnisse dazu im Verlauf): "${given}". Beantworte die neue Nachricht in diesem Zusammenhang und nutze diese Ergebnisse; frage nur nach, wenn der Bezug wirklich nicht erkennbar ist. Gib diesen Hinweis nie wieder.`
}
