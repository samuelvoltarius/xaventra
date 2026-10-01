import { redactSecrets } from '../security/secret-redaction.js'
import { getMemoryGovernanceCoordinator, type GovernedMemory, type MemoryGovernanceCoordinator } from './memory-governance.js'

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

/**
 * The one store for a user correction: a governed, user-scoped memory.
 * (The former L7 corrections.json and L20 self-rules.json are migrated into
 * governance at start; owner rules with rule character additionally land in
 * decisions.ts via observeOwnerMessage.)
 */
export async function recordUserCorrectionMemory(input: CorrectionMemoryInput, governance: MemoryGovernanceCoordinator = getMemoryGovernanceCoordinator()): Promise<GovernedMemory | null> {
    const parsed = parseCorrectionMemory(input.message)
    if (!parsed) return null
    return governance.record({
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

/** Active (verified/canonical) correction memories, optionally for some scopes — for /status and /gelernt. */
export function countCorrectionMemories(scopes?: readonly string[], governance: MemoryGovernanceCoordinator = getMemoryGovernanceCoordinator()): number {
    return governance.list()
        .filter(record => (record.status === 'verified' || record.status === 'canonical')
            && (!scopes || scopes.includes(record.scope))
            && record.provenance.some(item => item.source === 'user-correction'))
        .length
}
