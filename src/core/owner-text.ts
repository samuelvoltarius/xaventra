/**
 * Paket L (2.85.11), Punkt 4 — Owner-Texte: kurz, Ampel vorne, keine
 * technischen Kennungen. Pure helpers shared by Telegram, cards and reports.
 */

/** Richtwert für eine Telegram-Nachricht an den Owner. */
export const OWNER_PAGE_CHARS = 600

const TECHNICAL: ReadonlyArray<RegExp> = [
    /\b(?:dev|g)-[a-f0-9]{10}\b/gi,           // device ids
    /\bth-[a-f0-9]{12}\b/gi,                  // thought ids
    /\bk[a-f0-9]{12}\b/g,                     // card ids
    /\br-[a-f0-9]{16}\b/gi,                   // connect request ids
    /\b(?:out|run|iq|ar)-[a-f0-9]{8,}\b/gi,   // delivery/run/queue ids
    /\bsha256:[a-f0-9]{6,}\b/gi,
    /\buuid:[A-Za-z0-9-]+/g,
    /\b[a-f0-9]{16,}\b/gi,                    // hashes / fingerprints
    /\bL\d{1,2}(?:-[A-Za-z0-9-]+)?\b/g,       // layer numbers (L05, L22-federated-memory)
    /(?:[A-Za-z]:\\|\\\\)[^\s,;)]+/g,          // Windows paths
    /(?<![\w.:/])\/(?:[\w.@-]+\/)+[\w.@-]+/g, // POSIX paths (URLs stay intact)
    /\b(?:src|dist|\.nova-data)\/[\w./-]+/g,   // relative code/data paths
]

/** Removes ids, hashes, layer numbers and paths from text meant for the owner. */
export function ownerText(value: unknown): string {
    let text = String(value ?? '')
    for (const pattern of TECHNICAL) text = text.replace(pattern, '')
    return text
        .replace(/\(\s*(?:[,;:·-]\s*)*\)/g, '')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ ?· ?(?=·|$)/gm, '')
        .split('\n').map(line => line.trim()).join('\n')
        .trim()
}

/** Kopf jeder Owner-Antwort: Ampel + ein Satz. */
export function ampelKopf(input: { kritisch?: number; fragen?: number }): string {
    const kritisch = Math.max(0, Math.floor(Number(input.kritisch) || 0))
    const fragen = Math.max(0, Math.floor(Number(input.fragen) || 0))
    const frageText = fragen === 0 ? 'keine Frage offen' : fragen === 1 ? '1 Frage wartet' : `${fragen} Fragen warten`
    if (kritisch > 0) return `🔴 ${kritisch === 1 ? '1 Problem braucht' : `${kritisch} Probleme brauchen`} dich — ${frageText}`
    return `${fragen ? '🟡' : '🟢'} Alles läuft — ${frageText}`
}

/** 2.86 Paket N: a line starting with this marker starts a new page („Details“ behind „Mehr ▶“). */
export const DETAILS_TRENNER = '── Details ──'

/** Splits text into pages of at most `max` characters at paragraph/line boundaries; nothing is lost. */
export function paginate(value: unknown, max = OWNER_PAGE_CHARS): string[] {
    const text = String(value ?? '').replace(/\r\n/g, '\n').trim()
    const parts = text.split(`\n${DETAILS_TRENNER}`).map((part, i) => i === 0 ? part : `${DETAILS_TRENNER}${part}`)
    if (parts.length > 1) return parts.flatMap(part => paginate(part, max)).filter(Boolean)
    if (text.length <= max) return [text]
    const pages: string[] = []
    let current = ''
    const flush = () => { if (current.trim()) pages.push(current.trim()); current = '' }
    for (const line of text.split('\n')) {
        if (line.length > max) {
            // 2.86 Paket N: split long lines at spaces only — never inside a word or an address
            // (a single token longer than a page stays whole on its own page).
            flush()
            for (const word of line.split(' ')) {
                if (current && current.length + 1 + word.length > max) flush()
                if (word.length > max && !/^https?:\/\//.test(word)) {
                    // a word longer than a page (no space to split at) is still cut; an address never
                    for (let i = 0; i < word.length; i += max) pages.push(word.slice(i, i + max))
                    continue
                }
                current = current ? `${current} ${word}` : word
            }
            flush()
            continue
        }
        if (current && current.length + 1 + line.length > max) flush()
        current = current ? `${current}\n${line}` : line
    }
    flush()
    return pages
}
