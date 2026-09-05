import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export interface ExternalAgentConnection {
    id: string
    ownerId: string
    name: string
    kind: 'hermes' | 'openclaw'
    baseUrl: string
    model: string
    credentialEnv: string
    enabled: boolean
    createdAt: string
    updatedAt: string
    lastVerifiedAt?: string
    lastStatus?: 'healthy' | 'degraded' | 'offline'
}

function validateEndpoint(raw: string): string {
    const value = new URL(raw)
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(value.hostname)
    const configured = (process.env.NOVA_EXTERNAL_AGENT_HOSTS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
    if (value.protocol !== 'https:' && !(value.protocol === 'http:' && (loopback || configured.includes(value.hostname.toLowerCase())))) {
        throw new Error('External agent endpoints require HTTPS; HTTP is allowed only for loopback or explicitly configured hosts')
    }
    if (['169.254.169.254', 'metadata.google.internal'].includes(value.hostname.toLowerCase())) throw new Error('Metadata endpoints are forbidden')
    value.pathname = value.pathname.replace(/\/+$/, '')
    return value.toString().replace(/\/$/, '')
}

function validateCredentialEnv(value: string): string {
    const result = String(value || '').trim()
    if (!/^NOVA_EXTERNAL_AGENT_[A-Z0-9_]{1,64}_TOKEN$/.test(result)) throw new Error('credentialEnv must be a NOVA_EXTERNAL_AGENT_*_TOKEN reference')
    return result
}

export class ExternalAgentRegistry {
    private entries = new Map<string, ExternalAgentConnection>()
    constructor(private readonly file = join(process.cwd(), '.nova-data', 'desktop', 'external-agents.json')) { this.load() }

    list(ownerId: string): ExternalAgentConnection[] { return [...this.entries.values()].filter(item => item.ownerId === ownerId).map(item => structuredClone(item)) }
    get(id: string, ownerId: string): ExternalAgentConnection | undefined { const item = this.entries.get(id); return item?.ownerId === ownerId ? structuredClone(item) : undefined }

    create(ownerId: string, input: Pick<ExternalAgentConnection, 'name' | 'kind' | 'baseUrl' | 'model' | 'credentialEnv'>): ExternalAgentConnection {
        const now = new Date().toISOString()
        if (!['hermes', 'openclaw'].includes(input.kind)) throw new Error('External agent kind must be hermes or openclaw')
        const name = String(input.name || '').trim().slice(0, 80)
        if (!name) throw new Error('Connection name is required')
        const entry: ExternalAgentConnection = {
            id: `external-${randomUUID()}`, ownerId, name, kind: input.kind,
            baseUrl: validateEndpoint(input.baseUrl), model: String(input.model || (input.kind === 'hermes' ? 'hermes-agent' : 'openclaw/default')).trim().slice(0, 200),
            credentialEnv: validateCredentialEnv(input.credentialEnv), enabled: true, createdAt: now, updatedAt: now,
        }
        this.entries.set(entry.id, entry); this.save(); return structuredClone(entry)
    }

    async health(id: string, ownerId: string): Promise<ExternalAgentConnection> {
        const entry = this.entries.get(id)
        if (!entry || entry.ownerId !== ownerId) throw new Error('Connection not found')
        const token = process.env[entry.credentialEnv]
        if (!token) throw new Error(`Credential reference is not provisioned on this node: ${entry.credentialEnv}`)
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8_000)
        try {
            const response = await fetch(`${entry.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
            entry.lastStatus = response.ok ? 'healthy' : 'degraded'; entry.lastVerifiedAt = new Date().toISOString(); entry.updatedAt = entry.lastVerifiedAt
        } catch { entry.lastStatus = 'offline'; entry.lastVerifiedAt = new Date().toISOString(); entry.updatedAt = entry.lastVerifiedAt }
        finally { clearTimeout(timeout); this.save() }
        return structuredClone(entry)
    }

    async complete(id: string, ownerId: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<{ content: string; model: string; source: string }> {
        const entry = this.entries.get(id)
        if (!entry || entry.ownerId !== ownerId || !entry.enabled) throw new Error('External agent connection is unavailable')
        const token = process.env[entry.credentialEnv]
        if (!token) throw new Error(`Credential reference is not provisioned on this node: ${entry.credentialEnv}`)
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 180_000)
        try {
            const response = await fetch(`${entry.baseUrl}/v1/chat/completions`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ model: entry.model, messages, stream: false }),
            })
            if (!response.ok) throw new Error(`${entry.kind} returned HTTP ${response.status}`)
            const body = await response.json() as any
            const content = String(body?.choices?.[0]?.message?.content || '')
            if (!content) throw new Error(`${entry.kind} returned no assistant content`)
            return { content, model: String(body?.model || entry.model), source: entry.kind }
        } finally { clearTimeout(timeout) }
    }

    private load(): void { if (!existsSync(this.file)) return; try { for (const value of JSON.parse(readFileSync(this.file, 'utf8')) as ExternalAgentConnection[]) this.entries.set(value.id, value) } catch { /* fail empty */ } }
    private save(): void { mkdirSync(dirname(this.file), { recursive: true }); atomicWriteJsonSync(this.file, [...this.entries.values()]) }
}

let singleton: ExternalAgentRegistry | null = null
export function getExternalAgentRegistry(): ExternalAgentRegistry { return singleton ||= new ExternalAgentRegistry() }
