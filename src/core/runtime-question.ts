/** The fast path must cover the WHOLE request, never swallow a second task. */
export function runtimeQuestion(content: string, previous: Array<{ role: string; content: string }> = []) {
    const result = { model: false, version: false, identity: false, mesh: false }
    const clauses = content.trim().replace(/[.!?]+$/g, '').split(/\s*[?!;]\s*|\s+und\s+/i).filter(Boolean)
    if (!clauses.length) return null
    for (const raw of clauses) {
        const clause = raw.trim().replace(/^und\s+/i, '')
        if (/^(?:(?:welches|welche|was für ein)\s+(?:modell|model|llm)\s+(?:nutzt|verwendest)\s+du(?:\s+(?:gerade|aktuell))?|(?:welches|welche)\s+(?:modell|model|llm)\s+(?:ist\s+aktiv|läuft(?:\s+gerade)?))$/i.test(clause)) result.model = true
        else if (/^(?:wer|was)\s+bist\s+du$/i.test(clause)) result.identity = true
        else if (/^(?:welche\s+version\s+(?:von\s+(?:nova|xaventra)\s+)?läuft(?:\s+(?:hier|gerade))?|welche\s+(?:nova|xaventra)[ -]version\s+nutzt\s+du)$/i.test(clause)) result.version = true
        else if (/^(?:(?:mesh|nodes?|knoten)(?:[ -](?:status|versionen))?|(?:status|versionen)\s+(?:der\s+)?(?:nodes?|knoten|mesh))$/i.test(clause)) result.mesh = true
        else if (/^(?:(?:kannst du|bitte)\s+)?(?:den\s+)?(?:genauen|genehmen|vollständigen|echten)\s+(?:modellnamen|namen)(?:\s+(?:rausfinden|herausfinden|nennen))?$/i.test(clause)
            && previous.at(-1)?.role === 'assistant'
            && /^(?:Aktives Runtime-Modell|Konfiguriertes Runtime-Modell):/m.test(previous.at(-1)!.content)) result.model = true
        else return null
    }
    return result
}
