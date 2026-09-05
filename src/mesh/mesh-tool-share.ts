/**
 * Mesh Tool Share — Unified Tool Registry Across All Nodes
 * 
 * Every node knows what tools every other node has.
 * When a task requires a tool that only exists on Jetson,
 * the master delegates automatically.
 * 
 * Flow:
 * 1. Node boots → broadcasts its tool list
 * 2. Master collects → builds global registry
 * 3. Task comes in → router checks: "who has this tool?"
 * 4. If local: execute. If remote: delegate via mesh.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'mesh-tools')

// ============================================
// Types
// ============================================

interface MeshToolEntry {
    name: string
    node: string          // Which node has this tool
    description: string
    lastSeen: string
    exclusive: boolean    // Only available on this node (e.g. GPU-only tools)
}

interface MeshToolRegistry {
    tools: MeshToolEntry[]
    lastUpdate: string
    nodes: string[]
}

// ============================================
// State
// ============================================

let registry: MeshToolRegistry = {
    tools: [],
    lastUpdate: new Date().toISOString(),
    nodes: [],
}

// ============================================
// Core
// ============================================

/**
 * Register local tools and broadcast to mesh
 */
export async function broadcastLocalTools(tools: Array<{ name: string; description: string }>, nodeName: string): Promise<void> {
    const entries: MeshToolEntry[] = tools.map(t => ({
        name: t.name,
        node: nodeName,
        description: t.description,
        lastSeen: new Date().toISOString(),
        exclusive: false,
    }))

    // Update local registry
    registry.tools = registry.tools.filter(t => t.node !== nodeName)
    registry.tools.push(...entries)
    registry.lastUpdate = new Date().toISOString()
    if (!registry.nodes.includes(nodeName)) registry.nodes.push(nodeName)

    // Broadcast via Event Hub
    try {
        const { emit } = await import('./event-hub.js')
        emit('mesh:tool_share', {
            node: nodeName,
            tools: entries.map(e => ({ name: e.name, description: e.description })),
            count: entries.length,
        })
        console.log(`[ToolShare] 📡 Broadcast ${entries.length} Tools von ${nodeName}`)
    } catch { /* Event Hub not available */ }

    saveRegistry()
}

/**
 * Receive tool list from another node
 */
export function receiveNodeTools(nodeName: string, tools: Array<{ name: string; description: string }>): void {
    // Remove old entries for this node
    registry.tools = registry.tools.filter(t => t.node !== nodeName)

    // Add new
    for (const t of tools) {
        registry.tools.push({
            name: t.name,
            node: nodeName,
            description: t.description,
            lastSeen: new Date().toISOString(),
            exclusive: false,
        })
    }

    registry.lastUpdate = new Date().toISOString()
    if (!registry.nodes.includes(nodeName)) registry.nodes.push(nodeName)

    saveRegistry()
    console.log(`[ToolShare] 📥 ${tools.length} Tools von ${nodeName} registriert`)
}

/**
 * Find which node has a specific tool
 */
export function findToolNode(toolName: string): string | null {
    const entry = registry.tools.find(t => t.name === toolName)
    return entry?.node || null
}

/**
 * Get all tools available across the mesh
 */
export function getGlobalToolList(): MeshToolEntry[] {
    return registry.tools
}

/**
 * Get all tools exclusive to a specific node
 */
export function getNodeExclusiveTools(nodeName: string): MeshToolEntry[] {
    const nodeTools = registry.tools.filter(t => t.node === nodeName)
    const toolNames = new Set(nodeTools.map(t => t.name))

    return nodeTools.filter(t => {
        // A tool is exclusive if no other node has it
        const otherNodes = registry.tools.filter(ot => ot.name === t.name && ot.node !== nodeName)
        return otherNodes.length === 0
    })
}

/**
 * Get mesh tool status
 */
export function getToolShareStatus(): string {
    const total = registry.tools.length
    const nodes = registry.nodes.length
    const unique = new Set(registry.tools.map(t => t.name)).size
    return `🔧 ${unique} unique Tools über ${nodes} Nodes (${total} total registrations)`
}

// ============================================
// Persistence
// ============================================

function saveRegistry(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'registry.json'), JSON.stringify(registry, null, 2))
    } catch { /* non-critical */ }
}

function loadRegistry(): void {
    try {
        const path = join(DATA_DIR, 'registry.json')
        if (existsSync(path)) {
            registry = JSON.parse(readFileSync(path, 'utf-8'))
        }
    } catch { /* start fresh */ }
}

// ============================================
// Init
// ============================================

export async function initToolShare(): Promise<void> {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    loadRegistry()

    // Subscribe to tool share events from other nodes
    try {
        const { on } = await import('./event-hub.js')
        on('mesh:tool_share', (event: any) => {
            if (event.data?.node && event.data?.tools) {
                receiveNodeTools(event.data.node, event.data.tools)
            }
        })
    } catch { /* Event Hub not available */ }

    console.log(`[ToolShare] ✅ Initialized — ${registry.tools.length} Tools von ${registry.nodes.length} Nodes`)
}
