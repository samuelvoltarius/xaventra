/** Compatibility facade for the former second plugin loader.
 * All state, trust, permissions, hooks and tools now belong to PluginManager. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPluginManager, type PluginManifest } from './plugin-sdk.js'

export type { PluginManifest }

export function validateManifest(raw: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    if (!raw || typeof raw !== 'object') return { valid: false, errors: ['Manifest must be an object'] }
    const manifest = raw as Record<string, unknown>
    if (!manifest.name || typeof manifest.name !== 'string') errors.push('Missing or invalid "name"')
    if (!manifest.version || typeof manifest.version !== 'string') errors.push('Missing or invalid "version"')
    if (!manifest.main || typeof manifest.main !== 'string') errors.push('Missing or invalid "main"')
    if (manifest.permissions && !Array.isArray(manifest.permissions)) errors.push('"permissions" must be an array')
    return { valid: errors.length === 0, errors }
}

function manifestAt(dir: string): string | null {
    for (const name of ['manifest.json', 'plugin.json']) {
        const path = join(dir, name)
        if (existsSync(path)) return path
    }
    return null
}

export function discoverPlugins(searchDirs: string[]): Array<{ dir: string; manifest: PluginManifest }> {
    const found: Array<{ dir: string; manifest: PluginManifest }> = []
    for (const root of searchDirs) {
        if (!existsSync(root)) continue
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const dir = join(root, entry.name)
            const path = manifestAt(dir)
            if (!path) continue
            try {
                const manifest = JSON.parse(readFileSync(path, 'utf8'))
                if (validateManifest(manifest).valid) found.push({ dir, manifest })
            } catch { /* invalid plugin stays undiscovered */ }
        }
    }
    return found
}

export async function loadPlugin(pluginDir: string) {
    const path = manifestAt(pluginDir)
    if (!path) throw new Error(`No manifest.json or plugin.json found in ${pluginDir}`)
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as PluginManifest
    const validation = validateManifest(manifest)
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`)
    await getPluginManager().loadPlugin(manifest, pluginDir)
    return getPluginManager().listPlugins().find(plugin => plugin.name === manifest.name)
}

export function listPlugins() { return getPluginManager().listPlugins() }
export function getEnabledPlugins() { return listPlugins().filter(plugin => plugin.active) }
export async function unloadPlugin(name: string) { return getPluginManager().unloadPlugin(name) }
export async function reloadPlugin(name: string) {
    const plugin = listPlugins().find(item => item.name === name)
    if (!plugin) return null
    throw new Error('Reload requires the original plugin directory; unload and load it explicitly')
}

/** Legacy observation hook facade. New tool hooks run through LifecyclePolicy. */
export async function runHook(name: string, ...args: unknown[]): Promise<void> {
    const mapping: Record<string, any> = {
        onBeforeAgent: 'beforeMessage', onAfterTool: 'afterToolCall', onMessage: 'afterMessage', onError: 'onError',
    }
    const hook = mapping[name]
    if (hook) await getPluginManager().executeHook(hook, args[0] as any)
}

export function getPluginsWithHook(_hook: string) { return [] }
