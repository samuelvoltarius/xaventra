/**
 * Nova — Gateway Auth Token Manager
 *
 * Mirrors OpenClaw v2026.2.19 gateway.auth.token pattern.
 * Auto-generates a secure Bearer token on first run and persists it
 * in .nova-gateway-token (gitignored).
 *
 * Nova's HTTP server (port 18789) uses this token for auth.
 * Passes token in Authorization: Bearer <token> header.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ============================================
// Token File
// ============================================

const TOKEN_FILE = '.nova-gateway-token'

export interface GatewayAuthConfig {
    mode: 'token' | 'none'
    token?: string
}

const generateToken = (): string => randomBytes(32).toString('hex')

// ============================================
// Load or Create Token
// ============================================

export const loadOrCreateGatewayToken = (cwd = process.cwd()): GatewayAuthConfig => {
    const tokenPath = join(cwd, TOKEN_FILE)

    if (existsSync(tokenPath)) {
        try {
            const raw = readFileSync(tokenPath, 'utf-8').trim()
            if (raw && raw.length >= 32) {
                return { mode: 'token', token: raw }
            }
        } catch { /* regenerate */ }
    }

    // Auto-generate
    const token = generateToken()
    try {
        writeFileSync(tokenPath, token, { mode: 0o600 /* owner read-only */ })
        console.log(`[GatewayAuth] 🔑 Generated new gateway token → ${TOKEN_FILE}`)
        console.log(`[GatewayAuth] ℹ️  Include in requests: Authorization: Bearer ${token.substring(0, 8)}...`)
    } catch (err) {
        console.warn('[GatewayAuth] ⚠️ Could not persist token:', err)
    }

    return { mode: 'token', token }
}

// ============================================
// Auth Check
// ============================================

let _authConfig: GatewayAuthConfig | null = null

export const initGatewayAuth = (): GatewayAuthConfig => {
    if (_authConfig) return _authConfig
    _authConfig = loadOrCreateGatewayToken()
    return _authConfig
}

export const getGatewayAuth = (): GatewayAuthConfig => {
    return _authConfig || initGatewayAuth()
}

/**
 * Validate an incoming HTTP request's Bearer token.
 * Returns true if auth passes (or if mode is 'none').
 */
export const validateGatewayRequest = (req: IncomingMessage): boolean => {
    const auth = getGatewayAuth()

    if (auth.mode === 'none') return true
    if (!auth.token) return false

    const authHeader = req.headers['authorization'] || ''
    const [scheme, token] = authHeader.split(' ')

    if (scheme !== 'Bearer' || !token) return false

    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(auth.token)
    const provided = Buffer.from(token)

    if (expected.length !== provided.length) return false

    const { timingSafeEqual: tse } = { timingSafeEqual }
    return tse(expected, provided)
}

/**
 * Express/Node.js middleware for gateway auth.
 * 401 on invalid token, passes through on localhost by default if mode='none'.
 */
export const gatewayAuthMiddleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
): void => {
    const auth = getGatewayAuth()

    if (auth.mode === 'none') {
        // Warn if not localhost
        const remoteAddr = req.socket?.remoteAddress || ''
        const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1'
        if (!isLocal) {
            console.warn(`[GatewayAuth] ⚠️ WARNING: No-auth mode active and remote connection from ${remoteAddr}`)
        }
        return next()
    }

    if (!validateGatewayRequest(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
        res.end(JSON.stringify({ error: 'Unauthorized', message: 'Valid Bearer token required' }))
        return
    }

    next()
}

/**
 * Print the current token to console (for setup/debug).
 */
export const printGatewayToken = (): void => {
    const auth = getGatewayAuth()
    if (auth.mode === 'none') {
        console.log('[GatewayAuth] Mode: none (no auth required)')
    } else {
        console.log(`[GatewayAuth] Token: ${auth.token}`)
    }
}
