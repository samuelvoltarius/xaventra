/**
 * Nova Plugin SDK — Manifest, Hooks, Loader
 *
 * Allows extending Nova with community plugins.
 * Plugins can register custom tools, lifecycle hooks, and commands.
 *
 * Plugin structure:
 * ~/.nova/plugins/<name>/
 *   manifest.json — plugin metadata
 *   index.js — plugin entry point (exports activate/deactivate)
 */

import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { getNovaConfig } from '../core/config.js'
import { getLifecyclePolicy } from '../core/lifecycle-policy.js'
import { evaluatePluginTrust, requirePluginPermission, type PluginPermission } from './plugin-security.js'
import { EffectScope, type EffectDisposer } from '../runtime/effect-scope.js'
import { getProviderManifestCatalog, type ProviderManifest } from '../llm/provider-manifest.js'

// ============================================
// Types
// ============================================

export interface PluginManifest {
    name: string
    version: string
    description: string
    author?: string
    main: string  // entry point relative to plugin dir
    hooks?: string[]  // lifecycle hooks this plugin uses
    tools?: PluginToolDefinition[]
    commands?: PluginCommandDefinition[]
    permissions?: PluginPermission[]
    integrity?: string
    signature?: string
    signingKeyId?: string
    providers?: ProviderManifest[]
}

export interface PluginToolDefinition {
    name: string
    description: string
    parameters: Array<{
        name: string
        type: 'string' | 'number' | 'boolean'
        description: string
        required?: boolean
    }>
}

export interface PluginCommandDefinition {
    name: string
    description: string
    usage?: string
}

export interface PluginContext {
    readonly signal: AbortSignal
    /** Nova config access */
    getConfig: () => Record<string, unknown>
    /** Log function */
    log: (message: string) => void
    /** Register a custom tool */
    registerTool: (tool: PluginToolDefinition, handler: (params: Record<string, unknown>) => Promise<unknown>) => () => void
    /** Register a command */
    registerCommand: (command: PluginCommandDefinition, handler: (args: string) => Promise<string>) => () => void
    /** Register a lifecycle hook handler */
    registerHook: (hookName: HookName, handler: (...args: unknown[]) => Promise<unknown>) => () => void
    effect: (disposer: EffectDisposer, label?: string) => () => void
    childScope: (label: string) => Pick<PluginContext, 'signal' | 'effect' | 'childScope'>
}

export interface NovaPlugin {
    manifest: PluginManifest
    dir: string
    active: boolean
    trust?: 'builtin' | 'signed' | 'development' | 'rejected'
    permissions?: PluginPermission[]
    instance?: {
        activate: (ctx: PluginContext) => Promise<void>
        deactivate?: () => Promise<void>
    }
}

// ============================================
// Lifecycle Hooks
// ============================================

export type HookName =
    | 'beforeMessage'
    | 'afterMessage'
    | 'beforeToolCall'
    | 'afterToolCall'
    | 'beforeLLMCall'
    | 'afterLLMCall'
    | 'onSessionStart'
    | 'onSessionEnd'
    | 'onError'

export interface LLMMessageForHook {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface HookPayload {
    beforeMessage: { userId: string; channel: string; content: string; image?: unknown }
    afterMessage: { userId: string; channel: string; content: string; response: string }
    beforeToolCall: { tool: string; args: Record<string, unknown>; userId?: string }
    afterToolCall: { tool: string; args: Record<string, unknown>; result: unknown; userId?: string }
    /** beforeLLMCall: plugin may return { messages } to inject context before LLM sees it */
    beforeLLMCall: { messages: LLMMessageForHook[]; userId: string; channel: string }
    /** afterLLMCall: read-only, for logging/learning */
    afterLLMCall: { messages: LLMMessageForHook[]; response: string; userId: string; channel: string }
    onSessionStart: { userId: string; channel: string }
    onSessionEnd: { userId: string; channel: string }
    onError: { error: Error; context?: string }
}

// ============================================
// Plugin Manager
// ============================================

export class PluginManager extends EventEmitter {
    private plugins: Map<string, NovaPlugin> = new Map()
    private hooks: Map<HookName, Array<{ pluginName: string; handler: (...args: unknown[]) => Promise<unknown> }>> = new Map()
    private customTools: Map<string, { plugin: string; handler: (params: Record<string, unknown>) => Promise<unknown> }> = new Map()
    private customCommands: Map<string, { plugin: string; handler: (args: string) => Promise<string> }> = new Map()
    private lifecycleUnregisters: Map<string, Array<() => void>> = new Map()
    private scopes = new Map<string, EffectScope>()
    private watchers = new Map<string, FSWatcher>()
    private reloadTimers = new Map<string, NodeJS.Timeout>()

    /**
     * Discover and load plugins from default directories.
     */
    async discover(): Promise<number> {
        const dirs = [
            join(process.env.HOME || process.env.USERPROFILE || '.', '.nova', 'plugins'),
            join(process.cwd(), 'plugins'),
        ]

        let loaded = 0
        for (const dir of dirs) {
            if (!existsSync(dir)) continue

            const entries = readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
                if (!entry.isDirectory()) continue

                const pluginDir = join(dir, entry.name)
                const manifestPath = join(pluginDir, 'manifest.json')

                if (!existsSync(manifestPath)) continue

                try {
                    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
                    await this.loadPlugin(manifest, pluginDir)
                    loaded++
                } catch (err) {
                    console.error(`[Plugins] Failed to load ${entry.name}: ${err}`)
                }
            }
        }

        console.log(`[Plugins] Discovered ${loaded} plugins`)
        return loaded
    }

    /**
     * Load and activate a single plugin.
     */
    async loadPlugin(manifest: PluginManifest, dir: string): Promise<void> {
        if (this.plugins.has(manifest.name)) {
            console.warn(`[Plugins] ${manifest.name} already loaded, skipping`)
            return
        }

        const trust = evaluatePluginTrust(dir, manifest)
        if (!trust.trusted) throw new Error(`Plugin ${manifest.name} rejected: ${trust.reason}`)
        const plugin: NovaPlugin = {
            manifest,
            dir,
            active: false,
            trust: trust.source,
            permissions: trust.permissions,
        }
        const scope = new EffectScope(`plugin:${manifest.name}`)

        try {
            const mainPath = join(dir, manifest.main)
            const mainUrl = `${pathToFileURL(mainPath).href}?nova_reload=${Date.now()}`
            const mod = await import(mainUrl)

            if (typeof mod.activate !== 'function') {
                throw new Error('Plugin must export an activate function')
            }

            plugin.instance = {
                activate: mod.activate,
                deactivate: mod.deactivate,
            }

            // Create plugin context
            const ctx: PluginContext = {
                signal: scope.signal,
                getConfig: () => {
                    requirePluginPermission(trust.permissions, 'config.read', manifest.name)
                    return getNovaConfig() as unknown as Record<string, unknown>
                },
                log: (msg: string) => console.log(`[Plugin:${manifest.name}] ${msg}`),
                registerTool: (tool, handler) => {
                    requirePluginPermission(trust.permissions, 'tool.register', manifest.name)
                    if (this.customTools.has(tool.name)) throw new Error(`Plugin tool already registered: ${tool.name}`)
                    this.customTools.set(tool.name, { plugin: manifest.name, handler })
                    this.emit('toolRegistered', { plugin: manifest.name, tool, handler })
                    console.log(`[Plugins] Tool registered: ${tool.name} (by ${manifest.name})`)
                    const dispose = () => {
                        const current = this.customTools.get(tool.name)
                        if (current?.plugin === manifest.name) {
                            this.customTools.delete(tool.name)
                            this.emit('toolUnregistered', { plugin: manifest.name, name: tool.name })
                        }
                    }
                    scope.effect(dispose, `tool:${tool.name}`)
                    return dispose
                },
                registerCommand: (cmd, handler) => {
                    requirePluginPermission(trust.permissions, 'command.register', manifest.name)
                    this.customCommands.set(cmd.name, { plugin: manifest.name, handler })
                    console.log(`[Plugins] Command registered: ${cmd.name} (by ${manifest.name})`)
                    const dispose = () => {
                        const current = this.customCommands.get(cmd.name)
                        if (current?.plugin === manifest.name) this.customCommands.delete(cmd.name)
                    }
                    scope.effect(dispose, `command:${cmd.name}`)
                    return dispose
                },
                registerHook: (hookName, handler) => {
                    requirePluginPermission(trust.permissions, 'hook.register', manifest.name)
                    const dispose = this.registerHook(hookName, manifest.name, handler)
                    scope.effect(dispose, `hook:${hookName}`)
                    console.log(`[Plugins] Hook registered: ${hookName} (by ${manifest.name})`)
                    return dispose
                },
                effect: (disposer, label) => scope.effect(disposer, label),
                childScope: label => this.contextForScope(scope.child(label)),
            }

            if (manifest.providers?.length) {
                requirePluginPermission(trust.permissions, 'network', manifest.name)
                const owner = `plugin:${manifest.name}`
                getProviderManifestCatalog().register(owner, manifest.providers)
                scope.effect(() => getProviderManifestCatalog().unregister(owner), 'provider-manifests')
            }
            await mod.activate(ctx)
            plugin.active = true

            this.plugins.set(manifest.name, plugin)
            this.scopes.set(manifest.name, scope)
            console.log(`[Plugins] ✅ ${manifest.name} v${manifest.version} loaded`)
        } catch (err) {
            await scope.dispose().catch(() => undefined)
            console.error(`[Plugins] ❌ Failed to activate ${manifest.name}: ${err}`)
        }
    }

    private contextForScope(scope: EffectScope): Pick<PluginContext, 'signal' | 'effect' | 'childScope'> {
        return {
            signal: scope.signal,
            effect: (disposer, label) => scope.effect(disposer, label),
            childScope: label => this.contextForScope(scope.child(label)),
        }
    }

    /**
     * Register a hook handler.
     */
    registerHook(hookName: HookName, pluginName: string, handler: (...args: unknown[]) => Promise<unknown>): () => void {
        let lifecycleUnregister: (() => void) | undefined
        if (!this.hooks.has(hookName)) {
            this.hooks.set(hookName, [])
        }
        this.hooks.get(hookName)!.push({ pluginName, handler })
        if (hookName === 'beforeToolCall' || hookName === 'afterToolCall') {
            const event = hookName === 'beforeToolCall' ? 'tool.before' as const : 'tool.after' as const
            lifecycleUnregister = getLifecyclePolicy().register({
                id: `plugin:${pluginName}:${hookName}:${this.hooks.get(hookName)!.length}`,
                event,
                priority: 500,
                failClosed: hookName === 'beforeToolCall',
                handler: async payload => {
                    const result = await handler({ tool: payload.toolName, args: payload.input || {}, result: payload.output, userId: payload.context.userId }) as any
                    if (hookName === 'beforeToolCall' && result?.args) return { updatedInput: result.args }
                    if (hookName === 'beforeToolCall' && result?.decision) return result
                    if (hookName === 'afterToolCall' && Object.prototype.hasOwnProperty.call(result || {}, 'result')) return { updatedOutput: result.result }
                },
            })
            const list = this.lifecycleUnregisters.get(pluginName) || []
            list.push(lifecycleUnregister)
            this.lifecycleUnregisters.set(pluginName, list)
        }
        return () => {
            this.hooks.set(hookName, (this.hooks.get(hookName) || []).filter(item => item.pluginName !== pluginName || item.handler !== handler))
            lifecycleUnregister?.()
            if (lifecycleUnregister) {
                const unregisters = this.lifecycleUnregisters.get(pluginName) || []
                this.lifecycleUnregisters.set(pluginName, unregisters.filter(item => item !== lifecycleUnregister))
            }
        }
    }

    /**
     * Execute all handlers for a hook.
     * For 'beforeLLMCall': handlers may return { messages } to inject context.
     * The returned messages array is passed to the next handler and finally returned.
     */
    async executeHook<K extends HookName>(hookName: K, payload: HookPayload[K]): Promise<HookPayload[K]> {
        const handlers = this.hooks.get(hookName) || []
        let current = payload

        for (const { pluginName, handler } of handlers) {
            try {
                const result = await handler(current) as Partial<HookPayload[K]> | undefined
                // Merge returned fields back into current payload (allows message injection)
                if (result && typeof result === 'object') {
                    current = { ...current, ...result }
                }
            } catch (err) {
                console.error(`[Plugins] Hook ${hookName} failed in ${pluginName}: ${err}`)
            }
        }

        return current
    }

    /**
     * Get a custom tool handler.
     */
    getCustomTool(name: string): ((params: Record<string, unknown>) => Promise<unknown>) | null {
        return this.customTools.get(name)?.handler || null
    }

    /**
     * Get all custom tool names.
     */
    getCustomToolNames(): string[] {
        return Array.from(this.customTools.keys())
    }

    /**
     * Get a custom command handler.
     */
    getCustomCommand(name: string): ((args: string) => Promise<string>) | null {
        return this.customCommands.get(name)?.handler || null
    }

    async unloadPlugin(name: string): Promise<boolean> {
        const plugin = this.plugins.get(name)
        if (!plugin) return false
        if (plugin.active && plugin.instance?.deactivate) await plugin.instance.deactivate()
        await this.scopes.get(name)?.dispose()
        this.scopes.delete(name)
        for (const unregister of this.lifecycleUnregisters.get(name) || []) unregister()
        this.lifecycleUnregisters.delete(name)
        for (const [hook, handlers] of this.hooks) this.hooks.set(hook, handlers.filter(item => item.pluginName !== name))
        for (const [tool, entry] of this.customTools) if (entry.plugin === name) this.customTools.delete(tool)
        for (const [command, entry] of this.customCommands) if (entry.plugin === name) this.customCommands.delete(command)
        this.plugins.delete(name)
        return true
    }

    async reloadPlugin(name: string): Promise<boolean> {
        const current = this.plugins.get(name)
        if (!current) return false
        const { manifest, dir } = current
        await this.unloadPlugin(name)
        await this.loadPlugin(manifest, dir)
        this.emit('reloaded', name)
        return this.plugins.get(name)?.active === true
    }

    /** Development-only HMR. Signed production plugins remain immutable. */
    startHotReload(): number {
        if (process.env.NOVA_PLUGIN_HOT_RELOAD !== '1') return 0
        for (const [name, plugin] of this.plugins) {
            if (plugin.trust !== 'development' || this.watchers.has(name)) continue
            const watcher = watch(plugin.dir, { recursive: process.platform === 'win32' || process.platform === 'darwin' }, () => {
                const prior = this.reloadTimers.get(name)
                if (prior) clearTimeout(prior)
                const timer = setTimeout(() => {
                    this.reloadTimers.delete(name)
                    void this.reloadPlugin(name).catch(error => console.error(`[Plugins] Hot reload failed for ${name}: ${error}`))
                }, 150)
                timer.unref?.()
                this.reloadTimers.set(name, timer)
            })
            this.watchers.set(name, watcher)
        }
        return this.watchers.size
    }

    /**
     * Deactivate all plugins.
     */
    async shutdown(): Promise<void> {
        for (const watcher of this.watchers.values()) watcher.close()
        this.watchers.clear()
        for (const timer of this.reloadTimers.values()) clearTimeout(timer)
        this.reloadTimers.clear()
        for (const name of [...this.plugins.keys()]) {
            try { await this.unloadPlugin(name); console.log(`[Plugins] ${name} deactivated`) }
            catch (err) { console.error(`[Plugins] ${name} deactivate error: ${err}`) }
        }
        this.hooks.clear()
        this.customTools.clear()
        this.customCommands.clear()
        for (const unregisters of this.lifecycleUnregisters.values()) for (const unregister of unregisters) unregister()
        this.lifecycleUnregisters.clear()
    }

    /**
     * Get plugin stats.
     */
    getStats(): { loaded: number; active: number; tools: number; commands: number; hooks: number } {
        return {
            loaded: this.plugins.size,
            active: Array.from(this.plugins.values()).filter(p => p.active).length,
            tools: this.customTools.size,
            commands: this.customCommands.size,
            hooks: Array.from(this.hooks.values()).reduce((sum, h) => sum + h.length, 0),
        }
    }

    /**
     * List all loaded plugins.
     */
    listPlugins(): Array<{ name: string; version: string; active: boolean; description: string; trust?: string; permissions?: PluginPermission[] }> {
        return Array.from(this.plugins.values()).map(p => ({
            name: p.manifest.name,
            version: p.manifest.version,
            active: p.active,
            description: p.manifest.description,
            trust: p.trust,
            permissions: p.permissions,
        }))
    }
}

// ============================================
// Singleton
// ============================================

let pluginManager: PluginManager | null = null

export function getPluginManager(): PluginManager {
    if (!pluginManager) {
        pluginManager = new PluginManager()
    }
    return pluginManager
}

export default { PluginManager, getPluginManager }
