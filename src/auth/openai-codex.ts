import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OpenAICodexCredentialImport {
    access: string
    refresh: string
    expires: number
    email?: string
    accountId?: string
}

interface OfficialCodexAuthFile {
    auth_mode?: string
    OPENAI_API_KEY?: string | null
    tokens?: {
        access_token?: string
        refresh_token?: string
        account_id?: string
    }
}

export function getOfficialCodexAuthPath(): string {
    return join(homedir(), '.codex', 'auth.json')
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
        const json = Buffer.from(normalized + padding, 'base64').toString('utf-8')
        const payload = JSON.parse(json)
        return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    } catch {
        return null
    }
}

function parseTokenMetadata(accessToken: string): { expires: number; email?: string } {
    const payload = decodeJwtPayload(accessToken)
    const exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : 0
    const profile = payload?.['https://api.openai.com/profile']
    const email = typeof profile === 'object' && profile && typeof (profile as Record<string, unknown>).email === 'string'
        ? String((profile as Record<string, unknown>).email)
        : undefined

    return {
        expires: exp,
        email,
    }
}

export function loadOfficialCodexCredentials(authPath = getOfficialCodexAuthPath()): OpenAICodexCredentialImport | null {
    if (!existsSync(authPath)) return null

    try {
        const raw = JSON.parse(readFileSync(authPath, 'utf-8')) as OfficialCodexAuthFile
        if (raw.auth_mode !== 'chatgpt') return null

        const access = raw.tokens?.access_token?.trim()
        const refresh = raw.tokens?.refresh_token?.trim()
        if (!access || !refresh) return null

        const metadata = parseTokenMetadata(access)
        if (!metadata.expires) return null

        return {
            access,
            refresh,
            expires: metadata.expires,
            email: metadata.email,
            accountId: raw.tokens?.account_id?.trim() || undefined,
        }
    } catch {
        return null
    }
}
