import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginManager, type PluginManifest } from './plugin-sdk.js'
import { getProviderManifestCatalog } from '../llm/provider-manifest.js'

describe('PluginManager scoped lifecycle', () => {
    it.each([false, true])('only retains provider metadata for active, permitted plugins (network=%s)', async (network) => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-provider-plugin-'))
        const manager = new PluginManager()
        vi.stubEnv('NOVA_ALLOW_UNSIGNED_PLUGINS', '1')
        try {
            writeFileSync(join(root, 'index.mjs'), 'export async function activate() {}')
            await manager.loadPlugin({
                name: 'catalog-demo', version: '1.0.0', description: 'fixture', main: 'index.mjs',
                permissions: network ? ['network'] : ['tool.register'],
                providers: [{ id: 'catalog-demo', name: 'Catalog Demo', protocol: 'openai-chat', discovery: 'static', models: [{ id: 'example-model' }] }],
            }, root)
            expect(getProviderManifestCatalog().list().some(item => item.id === 'catalog-demo')).toBe(network)
            await manager.unloadPlugin('catalog-demo')
            expect(getProviderManifestCatalog().list().some(item => item.id === 'catalog-demo')).toBe(false)
        } finally {
            await manager.shutdown()
            vi.unstubAllEnvs()
            rmSync(root, { recursive: true, force: true })
        }
    })
    it('unwinds registered effects and capabilities on unload', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-plugin-scope-'))
        const dir = join(root, 'demo'); mkdirSync(dir)
        writeFileSync(join(dir, 'index.mjs'), `export async function activate(ctx) { ctx.effect(() => { globalThis.__novaPluginDisposed = (globalThis.__novaPluginDisposed || 0) + 1 }, 'probe'); ctx.registerTool({ name: 'demo_tool', description: 'demo', parameters: [] }, async () => ({ ok: true })) }`)
        const manifest: PluginManifest = { name: 'demo', version: '1.0.0', description: 'demo', main: 'index.mjs', permissions: ['tool.register'] }
        const prior = process.env.NOVA_ALLOW_UNSIGNED_PLUGINS
        process.env.NOVA_ALLOW_UNSIGNED_PLUGINS = '1'
        const manager = new PluginManager()
        await manager.loadPlugin(manifest, dir)
        expect(manager.getCustomTool('demo_tool')).toBeTypeOf('function')
        await manager.unloadPlugin('demo')
        expect(manager.getCustomTool('demo_tool')).toBeNull()
        expect((globalThis as any).__novaPluginDisposed).toBe(1)
        await manager.shutdown()
        if (prior === undefined) delete process.env.NOVA_ALLOW_UNSIGNED_PLUGINS
        else process.env.NOVA_ALLOW_UNSIGNED_PLUGINS = prior
        delete (globalThis as any).__novaPluginDisposed
        rmSync(root, { recursive: true, force: true })
    })
})
