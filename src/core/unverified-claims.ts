/**
 * 2.88.2 (live 07.10.2026): an answer claimed "habe … getestet / curl funktioniert /
 * Verbindung steht" although no tool had run in that turn. Such a claim is only allowed
 * with evidence from the same run; otherwise the owner sees plainly that it is unchecked.
 */
const CLAIM = /(?:^|[^\p{L}])(?:ich\s+)?(?:habe|hab)\s+(?:(?!nicht|noch\s+nicht|kein)[\p{L}\p{N}`:/.\-_]+\s+){0,8}?(?:getestet|geprüft|überprüft|nachgesehen|nachgeschaut|ausprobiert|verifiziert)(?![\p{L}])|curl\W*funktioniert|verbindung\s+steht/iu
const NEGATED = /(?:nicht|noch\s+nicht|kein\w*)\s+(?:\S+\s+){0,3}?(?:getestet|geprüft|überprüft|nachgesehen|nachgeschaut|ausprobiert|verifiziert)/iu

export const UNVERIFIED_NOTE = '⚠️ Ungeprüft: Dafür habe ich in diesem Durchgang kein Werkzeug benutzt — das Folgende ist nicht nachgeprüft.'

export function guardUnverifiedClaims(reply: string, toolRuns: number): string {
    if (toolRuns > 0 || !reply) return reply
    const match = CLAIM.exec(reply)
    if (!match) return reply
    const around = reply.slice(Math.max(0, match.index - 30), match.index + match[0].length)
    if (NEGATED.test(around) && !/curl|verbindung\s+steht/i.test(match[0])) return reply
    return `${UNVERIFIED_NOTE}\n\n${reply}`
}
