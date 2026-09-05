import { redactSecrets } from '../security/secret-redaction.js'
import { getMemoryGovernanceCoordinator, type GovernedMemory } from './memory-governance.js'

export interface CorrectionMemoryInput {
    scope: string
    message: string
    priorAssistantResponse?: string
    channel?: string
    sessionId?: string
}

export interface ParsedCorrectionMemory {
    content: string
    replacesContent?: string
}

export function parseCorrectionMemory(message: string): ParsedCorrectionMemory | null {
    const content = redactSecrets(message).replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!content || content.includes('[REDACTED')) return null
    if (/^(?:nein|falsch|stimmt nicht|das ist falsch)[.!]?$/i.test(content)) return null

    const replacement = content.match(
        /(?:nicht|falsch\s+ist)\s+(.{2,120}?)\s*[,;—–-]\s*(?:sondern|richtig\s+ist)\s+(.{2,160})/i,
    )
    if (replacement) {
        return {
            content: `Korrektur des Benutzers: ${replacement[2].trim()}`,
            replacesContent: replacement[1].trim(),
        }
    }

    const explicit = content.match(
        /(?:korrektur|richtig\s+ist|eigentlich\s+(?:ist|war)|ich\s+meinte|correct(?:ion)?):?\s*(.{5,240})/i,
    )
    if (explicit?.[1]) return { content: `Korrektur des Benutzers: ${explicit[1].trim()}` }
    return null
}

export async function recordUserCorrectionMemory(input: CorrectionMemoryInput): Promise<GovernedMemory | null> {
    const parsed = parseCorrectionMemory(input.message)
    if (!parsed) return null
    return getMemoryGovernanceCoordinator().record({
        content: parsed.content,
        kind: 'context',
        scope: input.scope,
        source: 'user-correction',
        evidence: 'correction',
        confidence: 1,
        channel: input.channel,
        sessionId: input.sessionId,
        verified: true,
        replacesContent: parsed.replacesContent || input.priorAssistantResponse?.slice(0, 300),
    })
}
