import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadOfficialCodexCredentials } from './openai-codex.js'

const testRoot = join(process.cwd(), '.nova-tmp', 'tests', 'openai-codex')

function createJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.signature`
}

afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
})

describe('loadOfficialCodexCredentials', () => {
    it('loads official Codex credentials from auth.json', () => {
        mkdirSync(testRoot, { recursive: true })
        const authPath = join(testRoot, 'auth.json')
        const accessToken = createJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            'https://api.openai.com/profile': {
                email: 'nova@example.com',
            },
        })

        writeFileSync(authPath, JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: accessToken,
                refresh_token: 'rt_example',
                account_id: 'acct_123',
            },
        }))

        expect(loadOfficialCodexCredentials(authPath)).toEqual({
            access: accessToken,
            refresh: 'rt_example',
            expires: expect.any(Number),
            email: 'nova@example.com',
            accountId: 'acct_123',
        })
    })

    it('returns null when auth.json is not a ChatGPT login', () => {
        mkdirSync(testRoot, { recursive: true })
        const authPath = join(testRoot, 'auth.json')

        writeFileSync(authPath, JSON.stringify({
            auth_mode: 'apikey',
            tokens: {},
        }))

        expect(loadOfficialCodexCredentials(authPath)).toBeNull()
    })
})
