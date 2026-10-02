/**
 * 2.85 Paket A, Punkt 4 — Anmeldung für Verbindungen.
 *
 * Two flows, both "Browser auf, anmelden, automatisch zurück":
 *
 * 1. OAuth (Google, GitHub, community remotes): `ConnectorOAuthProvider`
 *    implements the SDK's `OAuthClientProvider`. The SDK does discovery
 *    (RFC 9728/8414), PKCE (S256), dynamic client registration where the
 *    server offers it, code exchange and refresh. The provider keeps
 *    everything in the connection's secrets file (0600). Where a service
 *    offers no client registration (Google, GitHub), the owner's OAuth client
 *    comes from the environment/config (`oauthClientFor`) — Xaventra never
 *    creates one herself.
 * 2. Home Assistant: its own login flow (IndieAuth: `client_id` is our own
 *    base URL, no registration) — `/auth/authorize` → `/auth/token`, PKCE
 *    sent along, refresh token kept; `haBearerFetch` puts a fresh bearer on
 *    every MCP request and refreshes shortly before expiry. HA's OAuth
 *    discovery metadata is not used (known to return relative URLs).
 *
 * Return path: the browser comes back to `<redirectBase>/verbindungen/rueckkehr`
 * on the Main with `state` + `code`. A pending login is single use, bound to
 * one connection and expires after 15 minutes.
 *
 * Expiry: a refresh that fails or a 401 marks the connection `abgelaufen`
 * and raises exactly ONE request to log in again (`loginAskedAt`); a new
 * successful login clears it.
 *
 * Tokens never leave this module and the secrets file: not in results,
 * errors, logs, cards, thoughts or chat.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { findConnector } from './connector-catalog.js'
import {
    getConnection, readConnectionSecrets, updateConnection, updateConnectionSecrets, type ConnectionRecord, type StoreOptions,
} from './connection-store.js'

export const LOGIN_TTL_MS = 15 * 60_000
export const RETURN_PATH = '/verbindungen/rueckkehr'
const STATE = /^[a-f0-9]{48}$/

export interface LoginDeps extends StoreOptions {
    fetchFn?: FetchLike
    /** e.g. http://127.0.0.1:3011 (the Main's dashboard). */
    redirectBase: string
    env?: NodeJS.ProcessEnv
    config?: any
    /** Exactly-once request to log in again (thought with a button). */
    askLogin?: (record: ConnectionRecord) => void | Promise<void>
}

export function redirectUrlOf(base: string): string {
    const url = new URL(RETURN_PATH, base.endsWith('/') ? base : `${base}/`)
    return url.toString()
}

// ---------------------------------------------------------------------------
// Pending logins (single use, 15 min) — stored next to the secrets (0600 dir)
// ---------------------------------------------------------------------------

interface PendingLogin { state: string; connectionId: string; kind: 'oauth' | 'ha'; createdAt: number; verifier?: string }
const pendingFile = (opts: StoreOptions) => join(opts.dataDir || getNovaDataDir(), 'secrets', 'connections', 'pending-logins.json')
function readPending(opts: StoreOptions): PendingLogin[] {
    try { return existsSync(pendingFile(opts)) ? (JSON.parse(readFileSync(pendingFile(opts), 'utf8'))?.pending || []) : [] } catch { return [] }
}
function writePending(list: PendingLogin[], opts: StoreOptions): void {
    mkdirSync(join(opts.dataDir || getNovaDataDir(), 'secrets', 'connections'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(pendingFile(opts), { version: 1, pending: list.slice(-50) })
}
function addPending(entry: PendingLogin, opts: StoreOptions): void {
    const now = (opts.now || Date.now)()
    writePending([...readPending(opts).filter(item => now - item.createdAt < LOGIN_TTL_MS && item.connectionId !== entry.connectionId), entry], opts)
}
/** Takes (and removes) the pending login for `state`; null when unknown, used or expired. */
function takePending(state: string, opts: StoreOptions): PendingLogin | null {
    if (!STATE.test(String(state || ''))) return null
    const now = (opts.now || Date.now)()
    const list = readPending(opts)
    const hit = list.find(item => item.state === state)
    writePending(list.filter(item => item.state !== state && now - item.createdAt < LOGIN_TTL_MS), opts)
    return hit && now - hit.createdAt < LOGIN_TTL_MS ? hit : null
}

// ---------------------------------------------------------------------------
// OAuth client of the owner (no registration at Google/GitHub)
// ---------------------------------------------------------------------------

const CLIENT_GROUP: Record<string, string> = { 'google-calendar': 'google', gmail: 'google', github: 'github' }

/** The owner's OAuth client for a connector, from env `XAVENTRA_OAUTH_<GRUPPE>_CLIENT_ID/_SECRET` or config `connections.oauthClients`. */
export function oauthClientFor(connectorId: string, env: NodeJS.ProcessEnv = process.env, config: any = {}): { client_id: string; client_secret?: string } | null {
    const group = CLIENT_GROUP[connectorId]
    if (!group) return null
    const key = group.toUpperCase()
    const fromConfig = config?.connections?.oauthClients?.[group]
    const clientId = env[`XAVENTRA_OAUTH_${key}_CLIENT_ID`] || (typeof fromConfig?.clientId === 'string' ? fromConfig.clientId : '')
    const secretEnv = typeof fromConfig?.clientSecretEnv === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(fromConfig.clientSecretEnv) ? fromConfig.clientSecretEnv : `XAVENTRA_OAUTH_${key}_CLIENT_SECRET`
    if (!clientId || !/^[A-Za-z0-9._-]{4,200}$/.test(clientId)) return null
    const secret = env[secretEnv]
    return { client_id: clientId, ...(secret ? { client_secret: secret } : {}) }
}

/** True when a connector needs an owner-created OAuth client first. */
export function needsOwnerOAuthClient(connectorId: string): boolean { return Boolean(CLIENT_GROUP[connectorId]) }

// ---------------------------------------------------------------------------
// 1. OAuthClientProvider (SDK)
// ---------------------------------------------------------------------------

export class ConnectorOAuthProvider implements OAuthClientProvider {
    /** Set by `redirectToAuthorization`; the caller hands it to the owner's browser. */
    authorizationUrl?: URL
    constructor(
        private readonly connectionId: string,
        private readonly options: { opts: StoreOptions; redirectUrl: string; scopes?: string[]; ownerClient?: { client_id: string; client_secret?: string } | null; state?: string },
    ) {}

    get redirectUrl(): string { return this.options.redirectUrl }
    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: 'Xaventra', redirect_uris: [this.options.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'], token_endpoint_auth_method: this.options.ownerClient?.client_secret ? 'client_secret_post' : 'none',
            ...(this.options.scopes?.length ? { scope: this.options.scopes.join(' ') } : {}),
        }
    }
    state(): string { return this.options.state || '' }
    clientInformation(): OAuthClientInformationMixed | undefined {
        if (this.options.ownerClient) return { ...this.options.ownerClient }
        const stored = readConnectionSecrets(this.connectionId, this.options.opts).oauth?.client
        return stored && typeof stored.client_id === 'string' ? stored as unknown as OAuthClientInformationMixed : undefined
    }
    saveClientInformation(info: OAuthClientInformationMixed): void {
        updateConnectionSecrets(this.connectionId, current => ({ ...current, oauth: { ...current.oauth, client: { ...info } as Record<string, unknown> } }), this.options.opts)
    }
    tokens(): OAuthTokens | undefined {
        const tokens = readConnectionSecrets(this.connectionId, this.options.opts).oauth?.tokens
        return tokens && typeof tokens.access_token === 'string' ? tokens as unknown as OAuthTokens : undefined
    }
    saveTokens(tokens: OAuthTokens): void {
        const now = (this.options.opts.now || Date.now)()
        updateConnectionSecrets(this.connectionId, current => ({ ...current, oauth: { ...current.oauth, tokens: { ...tokens, obtained_at: now } as Record<string, unknown> } }), this.options.opts)
    }
    redirectToAuthorization(authorizationUrl: URL): void { this.authorizationUrl = authorizationUrl }
    saveCodeVerifier(codeVerifier: string): void {
        updateConnectionSecrets(this.connectionId, current => ({ ...current, oauth: { ...current.oauth, verifier: codeVerifier } }), this.options.opts)
    }
    codeVerifier(): string {
        const verifier = readConnectionSecrets(this.connectionId, this.options.opts).oauth?.verifier
        if (!verifier) throw new Error('Kein PKCE-Verifier gespeichert')
        return verifier
    }
    saveDiscoveryState(state: any): void {
        updateConnectionSecrets(this.connectionId, current => ({ ...current, oauth: { ...current.oauth, discovery: { ...state } } }), this.options.opts)
    }
    discoveryState(): any {
        return readConnectionSecrets(this.connectionId, this.options.opts).oauth?.discovery
    }
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        updateConnectionSecrets(this.connectionId, current => {
            const oauth = { ...current.oauth }
            if (scope === 'all' || scope === 'tokens') delete oauth.tokens
            if (scope === 'all' || scope === 'client') delete oauth.client
            if (scope === 'all' || scope === 'verifier') delete oauth.verifier
            if (scope === 'all' || scope === 'discovery') delete oauth.discovery
            return { ...current, oauth }
        }, this.options.opts)
    }
}

const safe = (error: unknown) => String(error instanceof Error ? error.message : error)
    .replace(/(access|refresh)_token["'=:\s]+[^\s,;"'}]+/gi, '$1_token=[redacted]')
    .replace(/(bearer|code|token|secret)\s*[=:]\s*[^\s,;&]+/gi, '$1=[redacted]')
    .slice(0, 200)

function providerFor(record: ConnectionRecord, deps: LoginDeps, state?: string): ConnectorOAuthProvider {
    const manifest = record.trust === 'geprueft' ? findConnector(record.connectorId) : undefined
    return new ConnectorOAuthProvider(record.id, {
        opts: deps, redirectUrl: redirectUrlOf(deps.redirectBase), scopes: manifest?.scopes,
        ownerClient: oauthClientFor(record.connectorId, deps.env, deps.config), state,
    })
}
/** The provider the MCP gateway uses for an OAuth connection (refresh happens inside the SDK). */
export function oauthProviderForConnection(record: ConnectionRecord, deps: LoginDeps): ConnectorOAuthProvider {
    return providerFor(record, deps)
}

// ---------------------------------------------------------------------------
// 2. Home Assistant login flow
// ---------------------------------------------------------------------------

const base64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** IndieAuth: the client id is our own base URL; the redirect shares its host. */
export function haClientId(redirectBase: string): string { return new URL('/', redirectBase).toString() }

async function haToken(basis: string, body: Record<string, string>, fetchFn: FetchLike): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
    const res = await fetchFn(`${basis}/auth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body).toString(), redirect: 'error',
    } as RequestInit)
    if (!res.ok) throw Object.assign(new Error(`Home Assistant Anmeldung abgelehnt (HTTP ${res.status})`), { status: res.status })
    const json = await res.json() as any
    if (typeof json?.access_token !== 'string' || !json.access_token) throw new Error('Home Assistant: keine Anmeldung erhalten')
    return { accessToken: json.access_token, refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined, expiresIn: Number(json.expires_in) || 1800 }
}

// ---------------------------------------------------------------------------
// Start / finish
// ---------------------------------------------------------------------------

export type StartLoginResult = { ok: true; url: string } | { ok: false; message: string }

/** Starts the browser login for one connection; returns the address the owner opens. */
export async function startLogin(connectionId: string, deps: LoginDeps): Promise<StartLoginResult> {
    const record = getConnection(connectionId, deps)
    if (!record) return { ok: false, message: 'Unbekannte Verbindung.' }
    if (record.status === 'getrennt') return { ok: false, message: 'Verbindung ist getrennt — bitte neu verbinden.' }
    const state = randomBytes(24).toString('hex')
    const now = (deps.now || Date.now)()
    if (record.auth === 'ha-login') {
        if (!record.basis) return { ok: false, message: 'Home-Assistant-Adresse fehlt.' }
        const verifier = base64url(randomBytes(32))
        const challenge = base64url(createHash('sha256').update(verifier).digest())
        const url = new URL(`${record.basis}/auth/authorize`)
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('client_id', haClientId(deps.redirectBase))
        url.searchParams.set('redirect_uri', redirectUrlOf(deps.redirectBase))
        url.searchParams.set('state', state)
        url.searchParams.set('code_challenge', challenge)
        url.searchParams.set('code_challenge_method', 'S256')
        addPending({ state, connectionId, kind: 'ha', createdAt: now, verifier }, deps)
        return { ok: true, url: url.toString() }
    }
    if (record.auth !== 'oauth' || record.transport.art !== 'http') return { ok: false, message: 'Für diese Verbindung gibt es keine Browser-Anmeldung.' }
    if (record.trust === 'geprueft' && needsOwnerOAuthClient(record.connectorId) && !oauthClientFor(record.connectorId, deps.env, deps.config)) {
        return { ok: false, message: `Für ${record.title} fehlt noch der OAuth-Zugang des Owners (einmalig beim Anbieter anzulegen, siehe Verbindungen → Hinweis). Bis dahin keine Anmeldung.` }
    }
    const provider = providerFor(record, deps, state)
    try {
        const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
        const outcome = await auth(provider, { serverUrl: record.transport.url, fetchFn: deps.fetchFn })
        if (outcome === 'AUTHORIZED') {
            // A stored refresh token was still valid: no browser needed.
            updateConnection(record.id, { status: 'verbunden', loginAskedAt: undefined }, deps)
            return { ok: true, url: '' }
        }
        if (!provider.authorizationUrl) return { ok: false, message: 'Anmeldung konnte nicht gestartet werden.' }
        addPending({ state, connectionId, kind: 'oauth', createdAt: now }, deps)
        return { ok: true, url: provider.authorizationUrl.toString() }
    } catch (error) {
        return { ok: false, message: `Anmeldung nicht möglich: ${safe(error)}` }
    }
}

export type FinishLoginResult = { ok: true; connectionId: string; title: string } | { ok: false; message: string }

/** Return path from the browser (`state`, `code`). Single use. */
export async function finishLogin(input: { state?: unknown; code?: unknown; error?: unknown }, deps: LoginDeps): Promise<FinishLoginResult> {
    const pending = takePending(String(input.state || ''), deps)
    if (!pending) return { ok: false, message: 'Diese Anmeldung ist unbekannt, schon benutzt oder abgelaufen. Bitte in „Verbindungen“ neu anmelden.' }
    const record = getConnection(pending.connectionId, deps)
    if (!record) return { ok: false, message: 'Die Verbindung gibt es nicht mehr.' }
    if (input.error) return { ok: false, message: 'Anmeldung beim Dienst abgebrochen.' }
    const code = String(input.code || '')
    if (!code || code.length > 2048 || /[\s<>"']/.test(code)) return { ok: false, message: 'Rückkehr ohne gültigen Code.' }
    const fetchFn = deps.fetchFn || fetch
    const now = (deps.now || Date.now)()
    try {
        if (pending.kind === 'ha') {
            const clientId = haClientId(deps.redirectBase)
            const token = await haToken(record.basis!, { grant_type: 'authorization_code', code, client_id: clientId, ...(pending.verifier ? { code_verifier: pending.verifier } : {}) }, fetchFn)
            updateConnectionSecrets(record.id, current => ({ ...current, ha: { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: now + token.expiresIn * 1000, clientId } }), deps)
        } else {
            if (record.transport.art !== 'http') return { ok: false, message: 'Falsche Verbindungsart.' }
            const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
            const outcome = await auth(providerFor(record, deps, pending.state), { serverUrl: record.transport.url, authorizationCode: code, fetchFn: deps.fetchFn })
            if (outcome !== 'AUTHORIZED') return { ok: false, message: 'Anmeldung nicht abgeschlossen.' }
        }
    } catch (error) {
        updateConnection(record.id, { status: 'fehler' }, deps)
        return { ok: false, message: `Anmeldung fehlgeschlagen: ${safe(error)}` }
    }
    updateConnection(record.id, { status: 'wartet-auf-anmeldung', loginAskedAt: undefined }, deps)
    return { ok: true, connectionId: record.id, title: record.title }
}

/** Paste fallback: the owner pastes the full return address (browser on another machine). */
export async function finishLoginFromAddress(address: unknown, deps: LoginDeps): Promise<FinishLoginResult> {
    let url: URL
    try { url = new URL(String(address || '').trim()) } catch { return { ok: false, message: 'Das ist keine Adresse.' } }
    if (url.pathname !== RETURN_PATH) return { ok: false, message: 'Das ist nicht die Rückkehr-Adresse der Anmeldung.' }
    return finishLogin({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error') }, deps)
}

// ---------------------------------------------------------------------------
// Running connections: fresh HA bearer, expiry → exactly one request
// ---------------------------------------------------------------------------

/** Marks the connection expired and asks the owner exactly once until the next successful login. */
export async function markLoginExpired(connectionId: string, deps: LoginDeps): Promise<boolean> {
    const record = getConnection(connectionId, deps)
    if (!record || record.status === 'getrennt') return false
    const first = !record.loginAskedAt
    const updated = updateConnection(record.id, { status: 'abgelaufen', ...(first ? { loginAskedAt: new Date((deps.now || Date.now)()).toISOString() } : {}) }, deps)
    if (first && updated && deps.askLogin) {
        try { await deps.askLogin(updated) } catch { /* the status is visible in the view either way */ }
    }
    return first
}

export function isAuthFailure(error: unknown): boolean {
    const text = String((error as any)?.name || '') + ' ' + String((error as any)?.message || error || '')
    return /UnauthorizedError|invalid_grant|\b401\b|unauthori[sz]ed|abgelaufen/i.test(text) || (error as any)?.status === 401
}

/** FetchLike for the HA MCP endpoint: fresh bearer per request, refresh before expiry, expiry → one ask. */
export function haBearerFetch(connectionId: string, deps: LoginDeps): FetchLike {
    const fetchFn = deps.fetchFn || fetch
    return async (url, init) => {
        const record = getConnection(connectionId, deps)
        const secrets = readConnectionSecrets(connectionId, deps).ha
        if (!record?.basis || !secrets?.accessToken) {
            await markLoginExpired(connectionId, deps)
            throw Object.assign(new Error('Home Assistant: Anmeldung fehlt'), { status: 401 })
        }
        let access = secrets.accessToken
        const now = (deps.now || Date.now)()
        if (secrets.expiresAt - now < 60_000) {
            if (!secrets.refreshToken) { await markLoginExpired(connectionId, deps); throw Object.assign(new Error('Home Assistant: Anmeldung abgelaufen'), { status: 401 }) }
            try {
                const token = await haToken(record.basis, { grant_type: 'refresh_token', refresh_token: secrets.refreshToken, client_id: secrets.clientId }, fetchFn)
                access = token.accessToken
                updateConnectionSecrets(connectionId, current => ({ ...current, ha: { ...secrets, accessToken: token.accessToken, expiresAt: now + token.expiresIn * 1000 } }), deps)
            } catch (error) {
                await markLoginExpired(connectionId, deps)
                throw Object.assign(new Error('Home Assistant: Anmeldung abgelaufen'), { status: 401, cause: safe(error) })
            }
        }
        const headers = new Headers((init as RequestInit | undefined)?.headers)
        headers.set('Authorization', `Bearer ${access}`)
        const res = await fetchFn(url, { ...(init as RequestInit), headers })
        if (res.status === 401) await markLoginExpired(connectionId, deps)
        return res
    }
}
