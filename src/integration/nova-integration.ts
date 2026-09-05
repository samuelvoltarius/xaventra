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

import type { ToolDefinition, ToolRegistry } from '../tools/registry.js'

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

export async function initGatewayLayer(port = 3001): Promise<void> {
    console.log('[Integration] 🌐 Initializing Gateway API Layer...')

    try {
        const express = (await import('express')).default
        const app = express()
        app.use(express.json())

        // Health endpoint
        app.get('/health', (_req, res) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                version: '2.0.0',
                layers: (() => { try { return require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'layers')).filter((f: string) => f.endsWith('.ts') || f.endsWith('.js')).length } catch { return 0 } })(),
            })
        })

        // Chat endpoint
        app.post('/api/chat', async (req, res) => {
            try {
                const { message, session = 'default' } = req.body

                // Use Nova's LLM
                const { getNovaLLM } = await import('../llm/nova-llm-sdk.js')
                const llm = getNovaLLM()
                llm.configure({ provider: 'openai', model: 'auto' })

                const response = await llm.complete([
                    { role: 'user', content: message }
                ])

                res.json({
                    success: true,
                    response: response.content,
                    session,
                })
            } catch (err) {
                res.status(500).json({ success: false, error: String(err) })
            }
        })

        // Tools list endpoint
        app.get('/api/tools', async (_req, res) => {
            try {
                const { ToolRegistry, registerBuiltinTools } = await import('../tools/registry.js')
                const registry = new ToolRegistry()
                registerBuiltinTools(registry)
                const tools = registry.getAll()
                res.json({
                    tools: tools.map((t: ToolDefinition) => ({
                        name: t.name,
                        description: t.description,
                        category: t.category
                    }))
                })
            } catch (err) {
                res.status(500).json({ success: false, error: String(err) })
            }
        })

        // Execute tool endpoint
        app.post('/api/tools/:name', async (req, res) => {
            try {
                const { name } = req.params
                const { ToolRegistry, registerBuiltinTools } = await import('../tools/registry.js')
                const registry = new ToolRegistry()
                registerBuiltinTools(registry)

                const result = await registry.execute({
                    id: `api-${Date.now()}`,
                    name,
                    arguments: req.body,
                }, true)

                res.json(result)
            } catch (err) {
                res.status(500).json({ success: false, error: String(err) })
            }
        })

        app.listen(port, () => {
            console.log(`[Integration] ✅ Gateway API ready on port ${port}`)
        })

    } catch (err) {
        console.log(`[Integration] ⚠️ Gateway Layer failed: ${err}`)
    }
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
    // Node-only workers already expose the authenticated REST API configured in
    // xaventra.config.json. Starting this legacy, unauthenticated gateway would add
    // a second authority and can collide with existing host services.
    if (process.env.NOVA_NODE_ONLY === 'true') {
        console.log('[Integration] Gateway API skipped on node-only worker (authenticated REST API is authoritative)')
    } else {
        await initGatewayLayer(3002)  // 3001 is Dashboard, Gateway uses 3002
    }

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
