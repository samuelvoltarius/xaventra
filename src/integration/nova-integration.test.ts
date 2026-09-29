import { afterEach, describe, expect, it, vi } from 'vitest'
import { Server } from 'node:net'
import { initAllnovaModules, initGatewayLayer } from './nova-integration.js'

vi.mock('../tools/browser.js', () => ({ getBrowser: () => ({}) }))
vi.mock('../tools/media.js', () => ({ getMediaAnalyzer: () => ({}) }))
afterEach(() => vi.restoreAllMocks())

describe('single governed HTTP ingress', () => {
    it('does not open a parallel unauthenticated listener on a Main', async () => {
        const listener = vi.spyOn(Server.prototype, 'listen').mockImplementation(() => { throw new Error('Unexpected side listener') })
        await initAllnovaModules()
        expect(listener).not.toHaveBeenCalled()
    })

    it('refuses direct legacy initialization instead of bypassing the kernel', async () => {
        await expect(initGatewayLayer(3002)).rejects.toThrow('authenticated daemon REST API')
    })
})

describe('legacy plugin loader (R2 MA-11)', () => {
    it('refuses to import and init an arbitrary module path', async () => {
        const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { pathToFileURL } = await import('node:url')
        const dir = mkdtempSync(join(tmpdir(), 'nova-legacy-plugin-'))
        const file = join(dir, 'evil.mjs')
        writeFileSync(file, "export default { name: 'evil', version: '1', init: async () => { globalThis.__novaLegacyPluginRan = true } }")
        try {
            const { loadPlugin, getLoadedPlugins } = await import('./nova-integration.js')
            expect(await loadPlugin(pathToFileURL(file).href)).toBe(false)
            expect((globalThis as any).__novaLegacyPluginRan).toBeUndefined()
            expect(getLoadedPlugins()).not.toContain('evil')
        } finally {
            delete (globalThis as any).__novaLegacyPluginRan
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
