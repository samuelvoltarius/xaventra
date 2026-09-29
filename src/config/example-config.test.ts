import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NovaConfigSchema } from '../core/config.js'
import { configDeclaresSingleNode } from '../mesh/leader-election.js'
import { peersWithoutKeys } from '../mesh/mesh-policy.js'
import { telegramAllowlistMatches } from '../channels/telegram.js'

// INT-7 regression: xaventra.config.example.json must follow the hardened
// rules (K3, M-Mesh-Config, L-TG-Allowlist) so a copied example is safe.

const example = JSON.parse(readFileSync(fileURLToPath(new URL('../../xaventra.config.example.json', import.meta.url)), 'utf8'))

describe('xaventra.config.example.json follows the current rules (INT-7)', () => {
    it('is a valid config', () => {
        expect(NovaConfigSchema.safeParse(example).success).toBe(true)
    })

    it('declares a single node explicitly', () => {
        expect(example.mesh.mode).toBe('standalone')
        expect(configDeclaresSingleNode(example)).toBe(true)
    })

    it('shows direct peers with publicKey and non-owner roles', () => {
        const peers = example.mesh.direct.peers
        expect(peers.length).toBeGreaterThan(0)
        expect(peersWithoutKeys(peers)).toEqual([])
        for (const peer of peers) {
            expect(peer.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n$/)
            expect(peer.roles).toEqual(['system', 'worker'])
            expect(peer.roles).not.toContain('owner')
            expect(peer.roles).not.toContain('admin')
        }
        expect(example.mesh.security.allowTofu).toBe(false)
    })

    it('uses numeric Telegram user ids in allowFrom', () => {
        const allowFrom: string[] = example.channels.telegram.allowFrom
        expect(allowFrom.length).toBeGreaterThan(0)
        for (const entry of allowFrom) {
            expect(entry).toMatch(/^[1-9][0-9]*$/)
            expect(telegramAllowlistMatches(entry, entry, '')).toBe(true)
        }
    })
})
