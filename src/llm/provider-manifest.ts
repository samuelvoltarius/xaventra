import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


export type ProviderDiscoveryMode = 'static' | 'refreshable' | 'runtime'
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai' | 'ollama'

export interface ProviderManifestModel {
    id: string
    name?: string
    capabilities?: string[]
    contextWindow?: number
    maxOutputTokens?: number
}

export interface ProviderManifest {
    id: string
    name: string
    protocol: ProviderProtocol
    discovery: ProviderDiscoveryMode
    baseUrl?: string
    modelsEndpoint?: string
    auth?: { env?: string[]; oauthProfile?: string; optional?: boolean }
    models?: ProviderManifestModel[]
}

export interface ProviderCatalogEntry {
    id: string
    name: string
    owner: string
    protocol: ProviderProtocol
    discovery: ProviderDiscoveryMode
    installed: boolean
    configured: boolean
    authenticated: boolean
    authSource: 'env' | 'oauth-profile' | 'none' | 'not-required'
    status: 'installed' | 'needs-auth' | 'configured' | 'verified'
    models: ProviderManifestModel[]
    baseUrl?: string
    verifiedAt?: string
}

const BUILTIN_PROVIDER_MANIFESTS: ProviderManifest[] = [
    { id: 'openai', name: 'OpenAI', protocol: 'openai-responses', discovery: 'refreshable', baseUrl: 'https://api.openai.com/v1', modelsEndpoint: '/models', auth: { env: ['OPENAI_API_KEY'] } },
    { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic-messages', discovery: 'refreshable', baseUrl: 'https://api.anthropic.com/v1', modelsEndpoint: '/models', auth: { env: ['ANTHROPIC_API_KEY'] } },
    { id: 'minimax', name: 'MiniMax', protocol: 'openai-chat', discovery: 'refreshable', baseUrl: 'https://api.minimax.io/v1', modelsEndpoint: '/models', auth: { env: ['MINIMAX_API_KEY'] } },
    { id: 'groq', name: 'Groq', protocol: 'openai-chat', discovery: 'refreshable', baseUrl: 'https://api.groq.com/openai/v1', modelsEndpoint: '/models', auth: { env: ['GROQ_API_KEY'] } },
    { id: 'openrouter', name: 'OpenRouter', protocol: 'openai-chat', discovery: 'refreshable', baseUrl: 'https://openrouter.ai/api/v1', modelsEndpoint: '/models', auth: { env: ['OPENROUTER_API_KEY'] } },
    { id: 'ollama', name: 'Ollama', protocol: 'ollama', discovery: 'runtime', auth: { optional: true } },
    { id: 'vllm', name: 'vLLM', protocol: 'openai-chat', discovery: 'runtime', auth: { optional: true } },
    { id: 'llama-cpp', name: 'llama.cpp', protocol: 'openai-chat', discovery: 'runtime', auth: { optional: true } },
]

export function validateProviderManifest(input: ProviderManifest): string[] {
    const errors: string[] = []
    if (!input || typeof input !== 'object') return ['provider manifest must be an object']
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(String(input?.id || ''))) errors.push('provider id is invalid')
    if (!String(input?.name || '').trim()) errors.push('provider name is required')
    if (!['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'ollama'].includes(input?.protocol)) errors.push('provider protocol is unsupported')
    if (!['static', 'refreshable', 'runtime'].includes(input?.discovery)) errors.push('provider discovery mode is invalid')
    if (input.baseUrl) {
        try {
            const url = new URL(input.baseUrl)
            if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) errors.push('provider baseUrl must use HTTPS or loopback HTTP')
            if (url.username || url.password) errors.push('provider baseUrl cannot contain credentials')
            if (url.search || url.hash) errors.push('provider baseUrl cannot contain query or fragment')
        } catch { errors.push('provider baseUrl is invalid') }
    }
    if (input.discovery === 'refreshable' && (!input.baseUrl || !input.modelsEndpoint)) errors.push('refreshable provider requires baseUrl and modelsEndpoint')
    if (input.modelsEndpoint && !/^\/?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(input.modelsEndpoint)) errors.push('modelsEndpoint must be a relative API path')
    if (input.auth?.env !== undefined && !Array.isArray(input.auth.env)) return [...errors, 'auth env must be an array']
    if (input.models !== undefined && !Array.isArray(input.models)) return [...errors, 'models must be an array']
    for (const name of input.auth?.env || []) if (!/^[A-Z][A-Z0-9_]{2,100}$/.test(name)) errors.push(`invalid auth env reference: ${name}`)
    for (const model of input.models || []) if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 200) errors.push('provider model id is invalid')
    return errors
}

function loadConfig(): Record<string, any> {
    try { const file = resolveConfigPath(); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {} }
    catch { return {} }
}

function configuredSecret(env: string[] = []): string | undefined {
    return env.find(name => {
        const value = process.env[name]?.trim()
        return value && !/^(?:replace-me|your[-_].*|example|placeholder)$/i.test(value)
    })
}

export class ProviderManifestCatalog {
    private readonly sources = new Map<string, ProviderManifest[]>()
    private readonly liveModels = new Map<string, { models: ProviderManifestModel[]; verifiedAt: string }>()

    constructor() { this.register('nova-core', BUILTIN_PROVIDER_MANIFESTS) }

    register(owner: string, manifests: ProviderManifest[]): void {
        if (!Array.isArray(manifests)) throw new Error('provider manifests must be an array')
        const accepted = manifests.map(item => {
            const errors = validateProviderManifest(item)
            if (errors.length) throw new Error(`Invalid provider manifest: ${errors.join('; ')}`)
            return structuredClone(item)
        })
        this.unregister(owner)
        if (accepted.length) this.sources.set(owner, accepted)
    }
    unregister(owner: string): void {
        for (const manifest of this.sources.get(owner) || []) this.liveModels.delete(manifest.id)
        this.sources.delete(owner)
    }

    list(): ProviderCatalogEntry[] {
        const config = loadConfig()
        const result = new Map<string, ProviderCatalogEntry>()
        for (const [owner, manifests] of this.sources) for (const manifest of manifests) {
            if (result.has(manifest.id)) continue
            const providerConfig = config.providers?.[manifest.id]
            const envName = configuredSecret(manifest.auth?.env)
            const noAuth = manifest.auth?.optional === true
            // OAuth availability belongs to the principal-scoped Codex runtime;
            // a legacy credential filename cannot authenticate an API provider.
            const authenticated = noAuth || Boolean(envName)
            const configured = providerConfig?.enabled !== false && (Boolean(providerConfig) || authenticated || manifest.discovery === 'runtime')
            const cached = this.liveModels.get(manifest.id)
            const live = configured && authenticated && cached && Date.now() - Date.parse(cached.verifiedAt) < 5 * 60_000 ? cached : undefined
            result.set(manifest.id, {
                id: manifest.id, name: manifest.name, owner, protocol: manifest.protocol, discovery: manifest.discovery,
                installed: true, configured, authenticated,
                authSource: noAuth ? 'not-required' : envName ? 'env' : 'none',
                status: !configured ? 'installed' : live ? 'verified' : authenticated ? 'configured' : 'needs-auth',
                models: live?.models || structuredClone(manifest.models || []), baseUrl: manifest.baseUrl, verifiedAt: live?.verifiedAt,
            })
        }
        return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
    }

    async refresh(providerId: string): Promise<ProviderCatalogEntry | null> {
        const manifest = [...this.sources.values()].flat().find(item => item.id === providerId)
        if (!manifest || manifest.discovery !== 'refreshable' || !manifest.baseUrl || !manifest.modelsEndpoint) return this.list().find(item => item.id === providerId) || null
        if (loadConfig().providers?.[providerId]?.enabled === false) return this.list().find(item => item.id === providerId) || null
        const envName = configuredSecret(manifest.auth?.env)
        const secret = envName ? process.env[envName] : undefined
        if (!secret && !manifest.auth?.optional) return this.list().find(item => item.id === providerId) || null
        const headers: Record<string, string> = !secret ? {} : manifest.protocol === 'anthropic-messages'
            ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${secret}` }
        this.liveModels.delete(providerId)
        const endpoint = new URL(manifest.modelsEndpoint.replace(/^\//, ''), `${manifest.baseUrl.replace(/\/+$/, '')}/`)
        const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(8_000) })
        if (!response.ok) throw new Error(`Provider catalog probe failed: HTTP ${response.status}`)
        const payload = await response.json() as any
        const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null
        if (!rows) throw new Error('Provider returned an invalid model catalog')
        const models = rows.filter(Boolean).slice(0, 500).map((row: any) => ({ id: String(typeof row === 'string' ? row : row.id || row.model || ''), name: typeof row?.name === 'string' ? row.name : undefined }))
            .filter((row: ProviderManifestModel) => row.id && row.id.length <= 200).slice(0, 500)
        this.liveModels.set(providerId, { models, verifiedAt: new Date().toISOString() })
        return this.list().find(item => item.id === providerId) || null
    }
}

let catalog: ProviderManifestCatalog | undefined
export function getProviderManifestCatalog(): ProviderManifestCatalog { return catalog ||= new ProviderManifestCatalog() }
