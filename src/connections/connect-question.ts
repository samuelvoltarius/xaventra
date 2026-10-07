/**
 * 2.88.2 (live 07.10.2026): "Kannst du dich mit X verbinden?" is first answered from the
 * own connection list. Already connected → say so at once (no model, no URL question).
 * Not connected or unknown → null, the normal path (dienst_finden / dienst_verbinden).
 */
const PATTERNS = [
    /(?:kannst|könntest|koenntest)\s+du\s+dich\s+(?:mit|an|zu)\s+(?:dem|der|den|meinem|meiner|meinen)?\s*(.+?)\s+(?:verbin\p{L}*|koppeln|anbinden)/iu,
    /^\s*(.+?)\s+(?:kannst|könntest|koenntest)\s+du\s+dich\s+(?:mit|an|zu)\s+(?:dem|der|den|ihm|ihr)?\s*(?:verbin\p{L}*|koppeln|anbinden)/iu,
    /^\s*verbinde?\s+dich\s+(?:mit|an|zu)\s+(?:dem|der|den|meinem|meiner)?\s*(.+?)\s*[.!?]*\s*$/iu,
]

const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function connectQuestionTarget(text: string): string | null {
    const value = String(text || '').trim()
    if (!value || value.length > 200) return null
    for (const pattern of PATTERNS) {
        const match = pattern.exec(value)
        const target = match ? norm(match[1]).replace(/^(?:dem|der|den)\s+/, '') : ''
        if (target && target.length <= 60 && !/^(?:dem|der|den|ihm|ihr)$/.test(target)) return target
    }
    return null
}

export function answerConnectQuestion(text: string, entries: ReadonlyArray<{ title: string; verbunden?: boolean }>): string | null {
    const target = connectQuestionTarget(text)
    if (!target) return null
    const hit = entries.find(entry => entry.verbunden === true && norm(entry.title).includes(target))
    if (!hit) return null
    const nutzen = /searx|such/i.test(hit.title) ? ' Ich suche schon darüber.' : ' Ich nutze es schon.'
    return `Ja — ${hit.title} ist schon verbunden.${nutzen}`
}
