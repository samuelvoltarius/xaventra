import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calculatePluginIntegrity, evaluatePluginTrust, pluginTrustDigest, type PluginPermission } from './plugin-security.js'

describe('plugin trust', () => {
    it('rejects unsigned external code by default', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-plugin-'))
        const dir = join(root, 'demo'); mkdirSync(dir); writeFileSync(join(dir, 'index.js'), 'export const activate=()=>{}')
        const decision = evaluatePluginTrust(dir, { name: 'demo', version: '1.0.0', main: 'index.js' })
        expect(decision.trusted).toBe(false)
        expect(decision.reason).toMatch(/integrity|signature/)
        rmSync(root, { recursive: true, force: true })
    })
})

describe('plugin trust binding (R2 MA-5)', () => {
    const setup = () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-plugin-trust-'))
        const dir = join(root, 'demo'); mkdirSync(dir)
        writeFileSync(join(dir, 'index.js'), "import './helper.js'\nexport const activate=()=>{}")
        writeFileSync(join(dir, 'helper.js'), 'export const x = 1')
        return { root, dir }
    }

    it('does not treat an unpinned directory under the plugin root as built-in', () => {
        const { root, dir } = setup()
        try {
            const decision = evaluatePluginTrust(dir, { name: 'demo', version: '1.0.0', main: 'index.js' }, { builtinRoot: root, builtinDigests: {} })
            expect(decision.trusted).toBe(false)
            expect(decision.source).toBe('rejected')
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('does not trust code just because it was written under <cwd>/plugins', () => {
        // vitest.setup.ts chdirs into a temporary runtime root.
        const dir = join(process.cwd(), 'plugins', 'dropped')
        mkdirSync(dir, { recursive: true })
        try {
            writeFileSync(join(dir, 'index.js'), 'export const activate=()=>{}')
            const decision = evaluatePluginTrust(dir, { name: 'dropped', version: '1.0.0', main: 'index.js' })
            expect(decision.trusted).toBe(false)
            expect(decision.source).toBe('rejected')
        } finally { rmSync(join(process.cwd(), 'plugins'), { recursive: true, force: true }) }
    })

    it('rejects a pinned built-in plugin once any module file changes', () => {
        const { root, dir } = setup()
        try {
            const manifest = { name: 'demo', version: '1.0.0', main: 'index.js' }
            const builtinDigests = { demo: pluginTrustDigest(dir, manifest) }
            expect(evaluatePluginTrust(dir, manifest, { builtinRoot: root, builtinDigests }).source).toBe('builtin')
            writeFileSync(join(dir, 'helper.js'), 'export const x = 2')
            expect(evaluatePluginTrust(dir, manifest, { builtinRoot: root, builtinDigests }).trusted).toBe(false)
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('signature covers imported helper files and the permission list', () => {
        const { root, dir } = setup()
        const previous = process.env.NOVA_PLUGIN_TRUSTED_KEYS
        try {
            const { publicKey, privateKey } = generateKeyPairSync('ed25519')
            process.env.NOVA_PLUGIN_TRUSTED_KEYS = JSON.stringify({ k1: publicKey.export({ type: 'spki', format: 'pem' }) })
            const base = { name: 'demo', version: '1.0.0', main: 'index.js', permissions: ['tool.register'] as PluginPermission[] }
            const integrity = calculatePluginIntegrity(dir, base)
            const payload = `demo\n1.0.0\nindex.js\ntool.register\n${integrity}`
            const signature = sign(null, Buffer.from(payload), privateKey).toString('base64')
            const manifest = { ...base, integrity, signature, signingKeyId: 'k1' }
            const options = { builtinRoot: root, builtinDigests: {} }
            expect(evaluatePluginTrust(dir, manifest, options).source).toBe('signed')

            expect(evaluatePluginTrust(dir, { ...manifest, permissions: ['tool.register', 'process.spawn'] as PluginPermission[] }, options).trusted).toBe(false)

            writeFileSync(join(dir, 'helper.js'), 'export const x = "evil"')
            expect(evaluatePluginTrust(dir, manifest, options).trusted).toBe(false)
        } finally {
            if (previous === undefined) delete process.env.NOVA_PLUGIN_TRUSTED_KEYS
            else process.env.NOVA_PLUGIN_TRUSTED_KEYS = previous
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('rejects plugins that contain symlinks, even in development mode', () => {
        const { root, dir } = setup()
        const outside = mkdtempSync(join(tmpdir(), 'nova-plugin-outside-'))
        const previous = process.env.NOVA_ALLOW_UNSIGNED_PLUGINS
        try {
            symlinkSync(outside, join(dir, 'linked'), 'junction')
            process.env.NOVA_ALLOW_UNSIGNED_PLUGINS = '1'
            const decision = evaluatePluginTrust(dir, { name: 'demo', version: '1.0.0', main: 'index.js' }, { builtinRoot: root, builtinDigests: {} })
            expect(decision.trusted).toBe(false)
            expect(decision.reason).toMatch(/symlink/)
        } finally {
            if (previous === undefined) delete process.env.NOVA_ALLOW_UNSIGNED_PLUGINS
            else process.env.NOVA_ALLOW_UNSIGNED_PLUGINS = previous
            rmSync(root, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })

    it('keeps the shipped brain-hook plugin trusted as built-in', () => {
        const pluginDir = fileURLToPath(new URL('../../plugins/brain-hook', import.meta.url))
        const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'))
        expect(evaluatePluginTrust(pluginDir, manifest).source).toBe('builtin')
    })
})
