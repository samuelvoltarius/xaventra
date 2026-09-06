/**
 * Nova Integration Layer
 * 
 * Bridges nova modules into Nova's 17-layer architecture:
 * - Browser (nova) → L10 Vision + Tools
 * - Media (nova) → L10 Vision (Audio/Image/Video)
 * - Agents (nova) → L8 Sub-Agents
 * - Gateway (nova) → Nova Daemon API
 * - Memory (nova) → L6 Memory (hybrid)
 */

// ============================================
// Browser Integration → L10 + Tools
// ============================================

export async function initBrowserLayer(): Promise<void> {
    console.log('[Integration] 🖥️ Initializing Browser Layer...')

    try {
        // Import and initialize browser tools
        const { getBrowser } = await import('../tools/browser.js')
        const browser = getBrowser()

        // Browser is lazy-initialized on first use
        console.log('[Integration] ✅ Browser Layer ready (Playwright)')
    } catch (err) {
        console.log(`[Integration] ⚠️ Browser Layer failed: ${err}`)
    }
}

// ============================================
// Media Integration → L10 Vision
// ============================================

export async function initMediaLayer(): Promise<void> {
    console.log('[Integration] 🎬 Initializing Media Layer...')

    try {
        // Import and initialize media analyzer
        const { getMediaAnalyzer } = await import('../tools/media.js')
        const analyzer = getMediaAnalyzer()

        console.log('[Integration] ✅ Media Layer ready (Image/Audio/Video)')
    } catch (err) {
        console.log(`[Integration] ⚠️ Media Layer failed: ${err}`)
    }
}

// ============================================
// Multi-Agent Integration → L8 Sub-Agent
// ============================================

export async function initMultiAgentLayer(): Promise<void> {
    console.log('[Integration] 🤖 Initializing Multi-Agent Layer...')

    try {
        // Agent types that will be available
        const agentTypes = [
            { name: 'browser', description: 'Web automation agent' },
            { name: 'research', description: 'Research and search agent' },
            { name: 'coder', description: 'Code writing agent' },
            { name: 'analyst', description: 'Data analysis agent' },
        ]

        console.log(`[Integration] ✅ Multi-Agent Layer ready (${agentTypes.length} agent types)`)
    } catch (err) {
        console.log(`[Integration] ⚠️ Multi-Agent Layer failed: ${err}`)
    }
}

// ============================================
// Gateway API Integration → Daemon HTTP
// ============================================

/** @deprecated Configure server.enabled and NOVA_API_TOKEN instead.
 * Never revive the old unauthenticated direct-model/direct-tool API. */
export async function initGatewayLayer(_port = 3001): Promise<void> {
    throw new Error('Legacy integration gateway is disabled. Use the authenticated daemon REST API (server.enabled, NOVA_API_TOKEN).')
}

// ============================================
// Plugin System (Hot-Reload)
// ============================================

interface Plugin {
    name: string
    version: string
    init: () => Promise<void>
    destroy?: () => Promise<void>
}

const loadedPlugins: Map<string, Plugin> = new Map()

export async function loadPlugin(pluginPath: string): Promise<boolean> {
    console.log(`[Plugins] Loading: ${pluginPath}`)

    try {
        const module = await import(`${pluginPath}?t=${Date.now()}`)
        const plugin: Plugin = module.default || module

        if (!plugin.name || !plugin.init) {
            throw new Error('Invalid plugin: missing name or init')
        }

        if (loadedPlugins.has(plugin.name)) {
            const old = loadedPlugins.get(plugin.name)!
            if (old.destroy) await old.destroy()
        }

        await plugin.init()
        loadedPlugins.set(plugin.name, plugin)

        console.log(`[Plugins] ✅ Loaded: ${plugin.name} v${plugin.version}`)
        return true
    } catch (err) {
        console.error(`[Plugins] ❌ Failed to load ${pluginPath}: ${err}`)
        return false
    }
}

export function getLoadedPlugins(): string[] {
    return Array.from(loadedPlugins.keys())
}

// ============================================
// Master Init
// ============================================

export async function initAllnovaModules(): Promise<void> {
    console.log('════════════════════════════════════════════════════')
    console.log('[Nova] 🔄 Integrating nova Modules...')
    console.log('════════════════════════════════════════════════════')

    await initBrowserLayer()
    await initMediaLayer()
    await initMultiAgentLayer()
    // The same governed ingress is authoritative on Main AND workers. The old
    // side server bypassed authentication, pipeline, policy and Outcome Ledger.
    console.log('[Integration] HTTP ingress uses the authenticated daemon REST API; no parallel legacy listener')

    console.log('════════════════════════════════════════════════════')
    console.log('[Nova] ✅ All nova modules integrated!')
    console.log('════════════════════════════════════════════════════')
}

export default {
    initBrowserLayer,
    initMediaLayer,
    initMultiAgentLayer,
    initGatewayLayer,
    loadPlugin,
    getLoadedPlugins,
    initAllnovaModules,
}
