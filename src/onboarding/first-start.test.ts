import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ensureFirstStartConfig, readOnboardingState } from './first-start.js'

const fresh = (label: string) => mkdtempSync(join(tmpdir(), `xaventra-firststart-${label}-`))

describe('Erster Start ohne Fragebogen (2.85 Paket B, Punkt 1)', () => {
    it('seeds a safe local-first configuration instead of stopping when none exists', async () => {
        const root = fresh('new')
        const env: Record<string, string | undefined> = {}
        const result = await ensureFirstStartConfig({ root, env })
        expect(result.seeded).toBe(true)
        expect(result.firstStart).toBe(true)
        const config = JSON.parse(readFileSync(result.configPath, 'utf8'))
        // No cloud provider without a key, no peers, no channels, no network listener.
        expect(config.provider).toBe('local')
        expect(config.model).toBe('auto')
        expect(config.fallbackModels).toEqual([])
        expect(config.mesh.update.nodes).toEqual([])
        expect(config.mcp.servers).toEqual([])
        expect(config.channels.telegram.enabled).toBe(false)
        expect(config.channels.telegram.allowFrom).toEqual([])
        expect(config.server.host).toBe('127.0.0.1')
        expect(readOnboardingState(root)?.state).toBe('pending')
        // The freshly created .env reaches this process (dotenv ran before seeding).
        expect(env.NOVA_DESKTOP_API_TOKEN).toMatch(/^[a-f0-9]{64}$/)
        expect(env.NOVA_NO_TELEGRAM).toBe('true')
    })

    it('leaves an existing installation completely unchanged (no onboarding, no files)', async () => {
        const root = fresh('existing')
        const legacy = join(root, 'nova.config.json')
        writeFileSync(legacy, '{"name":"existing","provider":"openai"}')
        const env: Record<string, string | undefined> = {}
        const result = await ensureFirstStartConfig({ root, env })
        expect(result).toEqual({ seeded: false, firstStart: false, configPath: legacy })
        expect(readFileSync(legacy, 'utf8')).toBe('{"name":"existing","provider":"openai"}')
        expect(existsSync(join(root, '.env'))).toBe(false)
        expect(existsSync(join(root, '.nova-data', 'onboarding.json'))).toBe(false)
        expect(env).toEqual({})
    })

    it('stays in first-start mode across restarts until onboarding is done', async () => {
        const root = fresh('restart')
        await ensureFirstStartConfig({ root, env: {} })
        const again = await ensureFirstStartConfig({ root, env: {} })
        expect(again.seeded).toBe(false)
        expect(again.firstStart).toBe(true)
        const path = join(root, '.nova-data', 'onboarding.json')
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), state: 'done' }))
        expect((await ensureFirstStartConfig({ root, env: {} })).firstStart).toBe(false)
    })

    it('never overrides variables the process already has', async () => {
        const root = fresh('env')
        const env: Record<string, string | undefined> = { NOVA_NO_TELEGRAM: 'false' }
        await ensureFirstStartConfig({ root, env })
        expect(env.NOVA_NO_TELEGRAM).toBe('false')
    })

    it('a corrupt onboarding marker is not treated as first start', async () => {
        const root = fresh('corrupt')
        writeFileSync(join(root, 'xaventra.config.json'), '{"provider":"local"}')
        mkdirSync(join(root, '.nova-data'))
        writeFileSync(join(root, '.nova-data', 'onboarding.json'), '{nope')
        expect((await ensureFirstStartConfig({ root, env: {} })).firstStart).toBe(false)
    })

    it('the daemon seeds before it validates, instead of exiting without configuration', () => {
        const source = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const seed = source.indexOf('ensureFirstStartConfig(')
        const validate = source.indexOf('validateConfig()')
        expect(seed).toBeGreaterThan(0)
        expect(seed).toBeLessThan(validate)
        expect(source).not.toContain("Keine Konfiguration gefunden. Führe npm run setup aus.')\n        process.exit(1)")
    })
})
