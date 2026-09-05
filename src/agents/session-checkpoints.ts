import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../security/secret-redaction.js'

export interface SessionScope { conversationId?: string; botId?: string }
export interface SessionIdentity { userId: string; conversationId: string; botId: string }
export interface SessionTurn { role: 'user' | 'assistant' | 'system'; content: string; timestamp?: number }

export function sessionIdentity(userId: string, scope: SessionScope = {}): SessionIdentity {
    return { userId, conversationId: scope.conversationId || 'default', botId: scope.botId || 'nova' }
}

export function sessionKey(identity: SessionIdentity): string {
    return createHash('sha256').update(JSON.stringify([identity.userId, identity.conversationId, identity.botId])).digest('hex')
}

/** Durable bounded cache for the existing agent session, not a second fact store.
 * No legacy unscoped transcript is silently imported into a scoped room. */
export class SessionCheckpoints {
    constructor(private readonly directory = join(process.cwd(), '.nova-data', 'sessions', 'agent-checkpoints')) {}

    load(identity: SessionIdentity): SessionTurn[] {
        const path = join(this.directory, `${sessionKey(identity)}.json`)
        if (!existsSync(path)) return []
        try {
            if (statSync(path).size > 3_000_000) return []
            const checkpoint = JSON.parse(readFileSync(path, 'utf8'))
            if (checkpoint.version !== 1 || !checkpoint.identity || sessionKey(checkpoint.identity) !== sessionKey(identity)) return []
            if (!Array.isArray(checkpoint.history)) return []
            return this.sanitize(checkpoint.history)
        } catch { return [] }
    }

    save(identity: SessionIdentity, history: SessionTurn[]): void {
        mkdirSync(this.directory, { recursive: true })
        const path = join(this.directory, `${sessionKey(identity)}.json`)
        const temporary = `${path}.${randomUUID()}.tmp`
        writeFileSync(temporary, JSON.stringify({ version: 1, identity, history: this.sanitize(history) }), { mode: 0o600 })
        renameSync(temporary, path)
    }

    private sanitize(history: SessionTurn[]): SessionTurn[] {
        return history.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
            .slice(-100).map(item => ({ role: item.role, content: redactSecrets(item.content).slice(0, 6000), timestamp: item.timestamp }))
    }
}
