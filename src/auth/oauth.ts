/**
 * Nova - OAuth Manager
 * 
 * Manages OAuth credentials with automatic token refresh.
 * Supports API keys, OAuth tokens, and provider-specific refresh.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ============================================
// Types
// ============================================

export type OAuthProvider =
    | 'anthropic'
    | 'openai-codex'
    | 'local'
    | 'openai-cli'
    | 'qwen-portal'
    | 'chutes'

export interface OAuthCredential {
    type: 'oauth'
    provider: OAuthProvider
    access: string
    refresh: string
    expires: number  // Unix timestamp (ms)
    email?: string
    projectId?: string
}

export interface ApiKeyCredential {
    type: 'api_key'
    provider: string
    key: string
    email?: string
}

export interface TokenCredential {
    type: 'token'
    provider: string
    token: string
    expires?: number
    email?: string
}

export type AuthCredential = OAuthCredential | ApiKeyCredential | TokenCredential

export interface AuthStore {
    version: number
    profiles: Record<string, AuthCredential>
}

export interface OAuthManagerConfig {
    storePath?: string
    refreshBuffer?: number  // Refresh this many ms before expiry
}

// ============================================
// OAuth Manager
// ============================================

export class OAuthManager {
    private config: Required<OAuthManagerConfig>
    private store: AuthStore | null = null

    constructor(config: OAuthManagerConfig = {}) {
        const dataDir = join(process.cwd(), '.nova-data')
        this.config = {
            storePath: config.storePath ?? join(dataDir, 'auth.json'),
            refreshBuffer: config.refreshBuffer ?? 5 * 60 * 1000, // 5 minutes before expiry
        }
    }

    // ============================================
    // Store Management
    // ============================================

    private loadStore(): AuthStore {
        if (this.store) return this.store

        if (existsSync(this.config.storePath)) {
            try {
                const data = readFileSync(this.config.storePath, 'utf-8')
                const parsed = JSON.parse(data)

                // Support both formats:
                // 1. Wrapped: { version: 1, profiles: { ... } }
                // 2. Flat (pi-agent): { "local": { ... } }
                if (parsed.profiles) {
                    this.store = parsed as AuthStore
                } else {
                    // Flat format - wrap it
                    this.store = { version: 1, profiles: parsed }
                }

                // Auto-infer missing 'type' field for legacy credentials
                for (const [id, cred] of Object.entries(this.store.profiles)) {
                    const c = cred as unknown as Record<string, unknown>
                    if (!c.type) {
                        if (c.access && c.expires) {
                            // Has access token + expiry → OAuth credential
                            c.type = 'oauth'
                            if (!c.provider) c.provider = id
                            if (!c.refresh) c.refresh = ''
                        } else if (c.key) {
                            c.type = 'api_key'
                            if (!c.provider) c.provider = id
                        } else if (c.token) {
                            c.type = 'token'
                            if (!c.provider) c.provider = id
                        }
                    }
                }
            } catch {
                this.store = { version: 1, profiles: {} }
            }
        } else {
            this.store = { version: 1, profiles: {} }
        }

        return this.store
    }

    private saveStore(): void {
        if (!this.store) return

        const dir = dirname(this.config.storePath)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        writeFileSync(this.config.storePath, JSON.stringify(this.store, null, 2))
    }

    // ============================================
    // Credential Management
    // ============================================

    /**
     * Get API key for a profile (auto-refreshes if OAuth and expired)
     */
    async getApiKey(profileId: string): Promise<string | null> {
        const store = this.loadStore()
        const cred = store.profiles[profileId]
        if (!cred) return null

        // API Key - return directly
        if (cred.type === 'api_key') {
            return cred.key
        }

        // Token - check expiry if set
        if (cred.type === 'token') {
            if (cred.expires && Date.now() >= cred.expires) {
                return null  // Expired, no refresh available
            }
            return cred.token
        }

        // OAuth - check if needs refresh
        if (cred.type === 'oauth') {
            const needsRefresh = Date.now() >= (cred.expires - this.config.refreshBuffer)

            if (needsRefresh) {
                const refreshed = await this.refreshToken(profileId, cred)
                if (refreshed) {
                    return this.buildOAuthApiKey(refreshed)
                }
                return null
            }

            return this.buildOAuthApiKey(cred)
        }

        return null
    }

    /**
     * Build API key string from OAuth credential
     */
    private buildOAuthApiKey(cred: OAuthCredential): string {
        // Return the access token directly for all providers
        return cred.access
    }

    /**
     * Refresh an OAuth token
     */
    private async refreshToken(profileId: string, cred: OAuthCredential): Promise<OAuthCredential | null> {
        try {
            // OpenAI API keys don't expire — only OAuth tokens need refresh
            if (cred.provider === 'openai-codex' || cred.provider === 'openai-cli') {
                // Codex credentials are opaque to Nova. The app-server owns
                // refresh inside its user x node CODEX_HOME.
                console.warn(`[OAuth] Legacy ${cred.provider} profile disabled; use /codex login`)
                return null
                // OpenAI Codex tokens use single-use refresh tokens managed by the official Codex CLI.
                // Do NOT try to refresh via REST — it consumes the refresh token without saving the result.
                // Instead: read fresh credentials from the official Codex CLI auth file (~/.codex/auth.json).
                try {
                    const { loadOfficialCodexCredentials } = await import('./openai-codex.js')
                    const fresh = loadOfficialCodexCredentials()
                    if (fresh && fresh.expires > Date.now()) {
                        const newCred: OAuthCredential = {
                            ...cred,
                            access: fresh.access,
                            refresh: fresh.refresh,
                            expires: fresh.expires,
                            email: fresh.email ?? cred.email,
                        }
                        const store = this.loadStore()
                        store.profiles[profileId] = newCred
                        this.saveStore()
                        console.log(`[OAuth] ✅ Synced fresh token from Codex CLI for ${cred.provider} (${fresh.email ?? profileId})`)
                        return newCred
                    }
                    console.warn(`[OAuth] Codex CLI token also expired — run: npx @openai/codex login`)
                } catch (err) {
                    console.error(`[OAuth] Failed to read Codex CLI auth:`, err)
                }
            }

            // For other providers, log warning
            console.warn(`[OAuth] No refresh implementation for provider: ${cred.provider}`)
        } catch (err) {
            console.error(`[OAuth] Failed to refresh token for ${cred.provider}:`, err)
        }

        return null
    }

    /**
     * Check time until token expires
     */
    getExpiresIn(profileId: string): number | null {
        const store = this.loadStore()
        const cred = store.profiles[profileId]

        if (!cred) return null

        if (cred.type === 'oauth') {
            return Math.max(0, cred.expires - Date.now())
        }

        if (cred.type === 'token' && cred.expires) {
            return Math.max(0, cred.expires - Date.now())
        }

        return null  // API key doesn't expire
    }

    /**
     * Check if a profile needs refresh soon
     */
    needsRefreshSoon(profileId: string): boolean {
        const expiresIn = this.getExpiresIn(profileId)
        if (expiresIn === null) return false
        return expiresIn <= this.config.refreshBuffer
    }

    // ============================================
    // Profile Management
    // ============================================

    /**
     * Add or update an API key profile
     */
    setApiKey(profileId: string, provider: string, key: string, email?: string): void {
        const store = this.loadStore()
        store.profiles[profileId] = {
            type: 'api_key',
            provider,
            key,
            email,
        }
        this.saveStore()
    }

    /**
     * Add or update an OAuth profile
     */
    setOAuthCredential(profileId: string, cred: OAuthCredential): void {
        const store = this.loadStore()
        store.profiles[profileId] = cred
        this.saveStore()
    }

    /**
     * Get all profile IDs
     */
    listProfiles(): string[] {
        const store = this.loadStore()
        return Object.keys(store.profiles)
    }

    /**
     * Get profile info
     */
    getProfile(profileId: string): AuthCredential | null {
        const store = this.loadStore()
        return store.profiles[profileId] ?? null
    }

    /**
     * Delete a profile
     */
    deleteProfile(profileId: string): boolean {
        const store = this.loadStore()
        if (store.profiles[profileId]) {
            delete store.profiles[profileId]
            this.saveStore()
            return true
        }
        return false
    }

    /**
     * Get profiles by provider
     */
    getProfilesByProvider(provider: string): string[] {
        const store = this.loadStore()
        return Object.entries(store.profiles)
            .filter(([, cred]) => cred.provider === provider)
            .map(([id]) => id)
    }
}

// ============================================
// Singleton
// ============================================

let oauthInstance: OAuthManager | null = null

export function getOAuthManager(): OAuthManager {
    if (!oauthInstance) {
        oauthInstance = new OAuthManager()
    }
    return oauthInstance
}

export default { OAuthManager, getOAuthManager }
