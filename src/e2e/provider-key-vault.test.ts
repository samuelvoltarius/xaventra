/**
 * 2.89.5 Zusatz: model provider keys live only in the encrypted node-local vault
 * (sealed 0600 auth store). Config and provider list carry `auth:llm-provider:<name>`
 * references only. Over the real entries: register_llm_provider and save_config
 * through the real pipeline (owner /freigabe first), plus the automatic startup
 * migration of still-plaintext keys (the live MiMo case) — after the migration the
 * fake key is nowhere in clear text under the runtime root and the provider still
 * resolves its key from the vault.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

// Simulated environment in the harness' spirit (network is closed anyway): the
// named example host resolves like the canonical example.com fixture the SSRF
// tests already use; every other SSRF check stays real.
vi.mock('../resilience/ssrf-guard.js', async importOriginal => {
    const real = await importOriginal<typeof import('../resilience/ssrf-guard.js')>()
    return {
        ...real,
        checkUrlResolved: (url: string) => real.checkUrlResolved(url, { lookup: async () => [{ address: '93.184.215.14', family: 4 }] } as any),
    }
})

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

const FAKE = 'x'.repeat(40)
const BASE_URL = 'https://api.mimo.example/v1'

/** The full proof from the contract: the value exists nowhere in clear text on disk. */
function expectNoPlaintextKey(root: string): void {
    const hits: string[] = []
    const scan = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry)
            if (statSync(path).isDirectory()) scan(path)
            else { try { if (readFileSync(path).includes(FAKE)) hits.push(path.slice(root.length)) } catch { /* unreadable: not text */ } }
        }
    }
    scan(root)
    expect(hits).toEqual([])
}

/** The live MiMo state: keys still in clear text in config AND provider list file. */
function seedPlaintextKeys(root: string): void {
    writeFileSync(join(root, '.nova-data', 'external-providers.json'), JSON.stringify([
        { name: 'mimo', apiKey: FAKE, apiKeyRef: '', baseUrl: BASE_URL, models: ['mimo-1'], enabled: true, addedAt: 1 },
    ], null, 2))
    const configPath = join(root, 'xaventra.config.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
    cfg.providers = { mimo: { apiKey: FAKE, baseUrl: BASE_URL, enabled: true } }
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))
}

describe('2.89.5 vault: plaintext provider keys migrate automatically (live MiMo case)', () => {
    it('first real reads move both files to references; the provider keeps working; restart is idempotent', async () => {
        const first = await createE2EHarness({ seed: seedPlaintextKeys, keepRoot: true })
        try {
            // The provider path itself — config read and provider registry read migrate.
            const { getNovaConfig } = await first.module('core/llm-factory.js')
            expect(getNovaConfig().providers?.mimo?.apiKey).toBe(FAKE)
            const resolver = await first.module('core/model-resolver.js')
            expect(resolver.listExternalProviders().find((p: any) => p.name === 'mimo')?.apiKey).toBe(FAKE)

            // Disk: references only — config, provider list, sealed vault, keyless backup.
            const migrated = JSON.parse(readFileSync(join(first.root, 'xaventra.config.json'), 'utf-8'))
            expect(migrated.providers.mimo).toMatchObject({ apiKey: '', apiKeyRef: 'auth:llm-provider:mimo' })
            expect(readFileSync(join(first.root, 'xaventra.config.json'), 'utf-8')).not.toContain(FAKE)
            const list = JSON.parse(readFileSync(join(first.root, '.nova-data', 'external-providers.json'), 'utf-8'))
            expect(list.find((entry: any) => entry.name === 'mimo')).toMatchObject({ apiKey: '', apiKeyRef: 'auth:llm-provider:mimo' })
            expect(readFileSync(join(first.root, '.nova-data', 'external-providers.json'), 'utf-8')).not.toContain(FAKE)
            const vault = readFileSync(join(first.root, '.nova-data', 'auth.json'), 'utf-8')
            expect(vault).toContain('nova-sealed:')
            expect(vault).not.toContain(FAKE)
            expect(readFileSync(join(first.root, 'xaventra.config.backup.json'), 'utf-8')).not.toContain(FAKE)
            expectNoPlaintextKey(first.root)
        } finally { await first.close() }

        // Restart: files stay clean, the migration finds nothing, the vault still serves the key.
        h = await createE2EHarness({ reuseRoot: first.root })
        const resolver2 = await h.module('core/model-resolver.js')
        const { migrateConfigProviderKeys } = await h.module('secrets/provider-keys.js')
        expect(resolver2.migratePlaintextExternalProviderKeys()).toEqual([])
        expect(migrateConfigProviderKeys()).toEqual([])
        expect(resolver2.listExternalProviders().find((p: any) => p.name === 'mimo')?.apiKey).toBe(FAKE)
        expectNoPlaintextKey(h.root)
    }, T)
})

describe('2.89.5 vault: register_llm_provider over the real entry', () => {
    it('registers via Telegram with the owner /freigabe and stores the key only sealed', async () => {
        h = await createE2EHarness()
        const approval = await h.telegram(`/freigabe register_llm_provider mimo@${BASE_URL}`)
        expect(approval.error).toBeUndefined()
        const code = approval.final.match(/nur für dich\):\s+(\S+)/)?.[1] || ''
        expect(code.length).toBeGreaterThan(4)

        const turn = await h.telegram('Registriere den externen LLM-Provider mimo mit seinen Angaben.', [{
            tool: 'register_llm_provider',
            args: { name: 'mimo', api_key: FAKE, base_url: BASE_URL, models: 'mimo-1', confirm: code },
        }], { fallback: 'Der Provider mimo ist registriert.' })
        expect(turn.error).toBeUndefined()
        expect(turn.executedTools).toContain('register_llm_provider')
        // The success branch ran (a refusal would log no registration).
        expect(turn.logs.join('\n')).toContain('Registered provider "mimo"')

        const cfg = JSON.parse(readFileSync(join(h.root, 'xaventra.config.json'), 'utf-8'))
        expect(cfg.providers.mimo).toMatchObject({ apiKeyRef: 'auth:llm-provider:mimo', baseUrl: BASE_URL })
        expect(JSON.stringify(cfg.providers)).not.toContain(FAKE)
        const list = JSON.parse(readFileSync(join(h.root, '.nova-data', 'external-providers.json'), 'utf-8'))
        expect(list.find((entry: any) => entry.name === 'mimo')).toMatchObject({ apiKey: '', apiKeyRef: 'auth:llm-provider:mimo' })
        expectNoPlaintextKey(h.root)
        // The provider works from the reference.
        const resolver = await h.module('core/model-resolver.js')
        expect(resolver.listExternalProviders().find((p: any) => p.name === 'mimo')?.apiKey).toBe(FAKE)
    }, T)
})

describe('2.89.5 vault: save_config over the real entry (the live MiMo write path)', () => {
    it('nested providers.<name>.apiKey goes to the vault; the config keeps only the reference', async () => {
        h = await createE2EHarness()
        const values = { mimo: { baseUrl: BASE_URL, apiKey: FAKE, enabled: true } }
        const { approvalDetailOf } = await h.module('tools/owner-approval.js')
        const approval = await h.telegram(`/freigabe save_config ${approvalDetailOf({ section: 'providers', values })}`)
        expect(approval.error).toBeUndefined()
        const code = approval.final.match(/nur für dich\):\s+(\S+)/)?.[1] || ''
        expect(code.length).toBeGreaterThan(4)

        const turn = await h.telegram('Trage den Provider mimo mit seinem Key in die Konfiguration ein.', [{
            tool: 'save_config',
            args: { section: 'providers', values, confirm: code },
        }], { fallback: 'Die Konfiguration ist aktualisiert.' })
        expect(turn.error).toBeUndefined()
        expect(turn.executedTools).toContain('save_config')

        const raw = readFileSync(join(h.root, 'xaventra.config.json'), 'utf-8')
        expect(raw).not.toContain(FAKE)
        expect(JSON.parse(raw).providers.mimo).toMatchObject({ apiKeyRef: 'auth:llm-provider:mimo', baseUrl: BASE_URL })
        expectNoPlaintextKey(h.root)
        const { resolveProviderKey } = await h.module('secrets/provider-keys.js')
        expect(resolveProviderKey(JSON.parse(raw).providers.mimo)).toBe(FAKE)
    }, T)
})
