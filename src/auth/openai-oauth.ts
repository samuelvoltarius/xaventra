/**
 * OpenAI OAuth Authentication (PKCE Flow)
 * 
 * Implements the OpenAI Codex OAuth flow similar to OpenClaw:
 * 1. Generate PKCE verifier/challenge + random state
 * 2. Open auth.openai.com/oauth/authorize in browser
 * 3. Capture callback on localhost (or manual paste)
 * 4. Exchange code for tokens at auth.openai.com/oauth/token
 * 5. Store tokens (access, refresh, expires, accountId)
 * 
 * Scopes: openid profile email offline_access api.connectors.read api.connectors.invoke
 * 
 * After code exchange, performs token exchange to obtain an API key
 * (urn:ietf:params:oauth:grant-type:token-exchange → openai-api-key)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ============================================
// Constants
// ============================================

const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CALLBACK_PORT = 1455  // Official OpenAI Codex CLI callback port
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`

// OpenAI Codex OAuth scopes — exact scopes from codex-rs/login/src/server.rs
const SCOPES = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'api.connectors.read',
    'api.connectors.invoke',
].join(' ')

// Client registration — OpenAI Codex uses public client (no secret needed for PKCE)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'  // Official OpenAI Codex CLI public client

// ============================================
// Types
// ============================================

export interface OpenAITokens {
    access: string
    refresh: string
    expires: number
    accountId?: string
    email?: string
    apiKey?: string   // API key obtained via token exchange (works with api.openai.com/v1/)
    idToken?: string  // id_token for token exchange
}

export interface OAuthCallbacks {
    onUrl: (url: string) => void
    onSuccess: (tokens: OpenAITokens) => void
    onError: (error: string) => void
    onStatus: (message: string) => void
}

// ============================================
// PKCE Helpers
// ============================================

function generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
    return randomBytes(16).toString('hex')
}

/**
 * Decode JWT payload (without verification — just to extract accountId)
 */
function decodeJwtPayload(token: string): Record<string, any> | null {
    try {
        const parts = token.split('.')
        if (parts.length !== 3) return null
        const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
        return JSON.parse(payload)
    } catch {
        return null
    }
}

// ============================================
// Token Storage
// ============================================

const TOKEN_FILE = '.nova-data/openai-auth.json'

function getTokenPath(): string {
    return join(process.cwd(), TOKEN_FILE)
}

export function loadOpenAITokens(): OpenAITokens | null {
    const path = getTokenPath()
    if (!existsSync(path)) return null
    try {
        return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
        return null
    }
}

export function saveOpenAITokens(tokens: OpenAITokens): void {
    const path = getTokenPath()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(tokens, null, 2))
}

export function hasOpenAIAuth(): boolean {
    const tokens = loadOpenAITokens()
    if (!tokens) return false
    // Check if token is still valid (with 5 min buffer)
    return Date.now() < tokens.expires - 5 * 60 * 1000
}

// ============================================
// OAuth Login Flow
// ============================================

/**
 * Start the OpenAI OAuth PKCE login flow.
 * 
 * Flow:
 * 1. Generate PKCE code_verifier + code_challenge
 * 2. Build authorization URL
 * 3. Start local HTTP server on CALLBACK_PORT
 * 4. Open browser / show URL to user
 * 5. Wait for callback with authorization code
 * 6. Exchange code for tokens
 * 7. Store tokens
 */
export async function loginOpenAI(callbacks: OAuthCallbacks): Promise<void> {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    // Build authorization URL
    const authUrl = new URL(AUTH_URL)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('scope', SCOPES)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    // Extra params from Codex CLI (codex-rs/login/src/server.rs)
    authUrl.searchParams.set('id_token_add_organizations', 'true')
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true')

    callbacks.onStatus('🔐 OpenAI OAuth (PKCE) Login gestartet...')
    callbacks.onUrl(authUrl.toString())

    // Start local callback server
    return new Promise<void>((resolve, reject) => {
        const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url || '/', `http://127.0.0.1:${CALLBACK_PORT}`)

            if (url.pathname === '/auth/callback') {
                const code = url.searchParams.get('code')
                const returnedState = url.searchParams.get('state')
                const error = url.searchParams.get('error')

                if (error) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end('<html><body><h1>❌ Login fehlgeschlagen</h1><p>Du kannst dieses Fenster schließen.</p></body></html>')
                    server.close()
                    callbacks.onError(`OAuth error: ${error}`)
                    reject(new Error(error))
                    return
                }

                if (!code || returnedState !== state) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end('<html><body><h1>❌ Ungültige Antwort</h1></body></html>')
                    server.close()
                    callbacks.onError('Invalid state or missing code')
                    reject(new Error('Invalid OAuth callback'))
                    return
                }

                callbacks.onStatus('📡 Code erhalten, tausche gegen Token...')

                try {
                    // Exchange code for tokens
                    const tokens = await exchangeCodeForTokens(code, codeVerifier)

                    // Token Exchange: id_token → API key (from Codex CLI obtain_api_key)
                    if (tokens.idToken) {
                        callbacks.onStatus('🔑 Tausche Token gegen API-Key...')
                        const apiKey = await obtainApiKey(tokens.idToken)
                        if (apiKey) {
                            tokens.apiKey = apiKey
                            console.log('[OpenAI OAuth] ✅ API key obtained via token exchange')
                        } else {
                            console.log('[OpenAI OAuth] ⚠️ Token exchange for API key failed — using access_token as fallback')
                        }
                    }

                    saveOpenAITokens(tokens)

                    // Also bridge to auth.json for TokenManager
                    bridgeToAuthJson(tokens)

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end(`<html><body>
                        <h1>✅ Nova erfolgreich mit OpenAI verbunden!</h1>
                        <p>Account: ${tokens.accountId || 'N/A'}</p>
                        <p>API Key: ${tokens.apiKey ? '✅ erhalten' : '⚠️ nur access_token'}</p>
                        <p>Du kannst dieses Fenster schließen.</p>
                    </body></html>`)

                    server.close()
                    callbacks.onSuccess(tokens)
                    resolve()
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end(`<html><body><h1>❌ Token-Austausch fehlgeschlagen</h1><p>${err}</p></body></html>`)
                    server.close()
                    callbacks.onError(`Token exchange failed: ${err}`)
                    reject(err)
                }
            } else {
                res.writeHead(404)
                res.end('Not Found')
            }
        })

        server.listen(CALLBACK_PORT, '127.0.0.1', () => {
            callbacks.onStatus(`🌐 Callback-Server auf Port ${CALLBACK_PORT} gestartet`)
        })

        // Timeout after 5 minutes
        setTimeout(() => {
            server.close()
            callbacks.onError('Login timeout (5 Minuten)')
            reject(new Error('OAuth login timeout'))
        }, 5 * 60 * 1000)
    })
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OpenAITokens> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier,
        }),
    })

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Token exchange failed (${response.status}): ${error}`)
    }

    const data = await response.json() as {
        access_token: string
        refresh_token?: string
        id_token?: string
        expires_in: number
        token_type: string
    }

    // Extract accountId from JWT (try id_token first, then access_token)
    const idPayload = data.id_token ? decodeJwtPayload(data.id_token) : null
    const accessPayload = decodeJwtPayload(data.access_token)
    // Check nested auth claims (OpenAI puts them under https://api.openai.com/auth)
    const authClaims = idPayload?.['https://api.openai.com/auth'] || accessPayload?.['https://api.openai.com/auth'] || {}
    const accountId = authClaims?.chatgpt_account_id || idPayload?.sub || accessPayload?.sub || accessPayload?.account_id
    const email = authClaims?.email || idPayload?.email || accessPayload?.email

    return {
        access: data.access_token,
        refresh: data.refresh_token || '',
        expires: Date.now() + data.expires_in * 1000,
        accountId,
        email,
        idToken: data.id_token,
    }
}

// ============================================
// Token Refresh
// ============================================

/**
 * Refresh an expired OpenAI OAuth token
 */
export async function refreshOpenAIToken(refreshToken: string): Promise<OpenAITokens | null> {
    try {
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
        })

        if (!response.ok) {
            console.log(`[OpenAI OAuth] ❌ Token refresh failed: ${response.status}`)
            return null
        }

        const data = await response.json() as {
            access_token: string
            refresh_token?: string
            expires_in: number
        }

        const payload = decodeJwtPayload(data.access_token)
        const accountId = payload?.sub || payload?.account_id

        const tokens: OpenAITokens = {
            access: data.access_token,
            refresh: data.refresh_token || refreshToken,
            expires: Date.now() + data.expires_in * 1000,
            accountId,
        }

        saveOpenAITokens(tokens)
        console.log(`[OpenAI OAuth] ✓ Token refreshed (expires: ${new Date(tokens.expires).toLocaleString('de')})`)
        return tokens
    } catch (err) {
        console.log(`[OpenAI OAuth] ❌ Token refresh error: ${err}`)
        return null
    }
}

// ============================================
// Manual Login Flow (for headless/remote)
// ============================================

/**
 * For headless environments where a local callback server can't run.
 * Shows the auth URL and asks the user to paste the redirect URL.
 */
export function getManualLoginUrl(): { url: string; state: string; codeVerifier: string } {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    const authUrl = new URL(AUTH_URL)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('scope', SCOPES)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    // Extra params from Codex CLI
    authUrl.searchParams.set('id_token_add_organizations', 'true')
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true')

    return { url: authUrl.toString(), state, codeVerifier }
}

/**
 * Complete manual login by exchanging the code from the redirect URL
 */
export async function completeManualLogin(redirectUrl: string, codeVerifier: string): Promise<OpenAITokens> {
    const url = new URL(redirectUrl)
    const code = url.searchParams.get('code')
    if (!code) throw new Error('No authorization code found in redirect URL')

    const tokens = await exchangeCodeForTokens(code, codeVerifier)

    // Token Exchange: id_token → API key
    if (tokens.idToken) {
        const apiKey = await obtainApiKey(tokens.idToken)
        if (apiKey) {
            tokens.apiKey = apiKey
            console.log('[OpenAI OAuth] ✅ API key obtained via token exchange')
        }
    }

    // Bridge to auth.json for TokenManager
    bridgeToAuthJson(tokens)

    return tokens
}

// ============================================
// Convenience
// ============================================

/**
 * Get a valid access token, refreshing if needed
 */
export async function getOpenAIAccessToken(): Promise<string | null> {
    const tokens = loadOpenAITokens()
    if (!tokens) return null

    // Check if expired (5 min buffer)
    if (Date.now() > tokens.expires - 5 * 60 * 1000) {
        if (tokens.refresh) {
            console.log('[OpenAI OAuth] Token expired, refreshing...')
            const refreshed = await refreshOpenAIToken(tokens.refresh)
            return refreshed?.access || null
        }
        console.log('[OpenAI OAuth] Token expired, no refresh token — re-login required')
        return null
    }

    return tokens.access
}

// ============================================
// Token Exchange: id_token → API key
// (from Codex CLI: codex-rs/login/src/server.rs → obtain_api_key)
// ============================================

/**
 * Exchange the id_token for an API key using OAuth token exchange.
 * This is how the Codex CLI converts subscription tokens into API keys
 * that work with api.openai.com/v1/chat/completions.
 */
async function obtainApiKey(idToken: string): Promise<string | null> {
    try {
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                client_id: CLIENT_ID,
                requested_token: 'openai-api-key',
                subject_token: idToken,
                subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
            }),
        })

        if (!response.ok) {
            const body = await response.text()
            console.log(`[OpenAI OAuth] ⚠️ API key exchange failed (${response.status}): ${body.slice(0, 200)}`)
            return null
        }

        const data = await response.json() as { access_token: string }
        return data.access_token || null
    } catch (err) {
        console.log(`[OpenAI OAuth] ⚠️ API key exchange error: ${err}`)
        return null
    }
}

// ============================================
// Bridge tokens to auth.json for TokenManager
// ============================================

function bridgeToAuthJson(tokens: OpenAITokens): void {
    try {
        const authPath = join(process.cwd(), '.nova-data', 'auth.json')
        const dir = dirname(authPath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

        let auth: Record<string, any> = {}
        if (existsSync(authPath)) {
            try { auth = JSON.parse(readFileSync(authPath, 'utf-8')) } catch { /* ok */ }
        }

        // OAuthManager expects profiles with { type, provider, access, refresh, expires }
        // Save under 'openai-codex' so llm-factory.ts getApiKey('openai-codex') finds it
        if (!auth.profiles) auth.profiles = {}
        auth.profiles['openai-codex'] = {
            type: 'oauth',
            provider: 'openai-codex',
            access: tokens.access,     // access_token for chatgpt.com/backend-api
            refresh: tokens.refresh,
            expires: tokens.expires,
            email: tokens.email,
        }
        // Also save flat 'openai' for legacy lookups
        auth.openai = {
            access: tokens.apiKey || tokens.access,
            refresh: tokens.refresh,
            expires: tokens.expires,
            provider: 'openai',
            type: tokens.apiKey ? 'api-key' : 'oauth',
            updatedAt: new Date().toISOString(),
            accountId: tokens.accountId,
        }

        writeFileSync(authPath, JSON.stringify(auth, null, 2))
        console.log(`[OpenAI OAuth] ✅ Bridged ${tokens.apiKey ? 'API key' : 'access token'} to auth.json`)
    } catch (err) {
        console.log(`[OpenAI OAuth] ⚠️ Bridge to auth.json failed: ${err}`)
    }
}

export function syncOpenAITokensToRuntimeAuth(tokens?: OpenAITokens | null): boolean {
    const resolved = tokens ?? loadOpenAITokens()
    if (!resolved) return false
    bridgeToAuthJson(resolved)
    try {
        import('./oauth.js').then(({ getOAuthManager }) => {
            getOAuthManager().setOAuthCredential('openai-codex', {
                type: 'oauth',
                provider: 'openai-codex',
                access: resolved.access,
                refresh: resolved.refresh,
                expires: resolved.expires,
                email: resolved.email,
            })
        }).catch(() => { /* runtime sync best-effort */ })
    } catch { /* runtime sync best-effort */ }
    return true
}

export default {
    loginOpenAI,
    refreshOpenAIToken,
    getManualLoginUrl,
    completeManualLogin,
    loadOpenAITokens,
    saveOpenAITokens,
    hasOpenAIAuth,
    getOpenAIAccessToken,
    syncOpenAITokensToRuntimeAuth,
    obtainApiKey,
}
