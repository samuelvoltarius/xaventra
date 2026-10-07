/**
 * Mesh Brain — Nova's picture of her compute universe.
 *
 * Mesh-Gehirn 2.88: no own scan, no own tiers, no own routing table and no
 * own model list any more. Two duplicates were merged:
 *  - "wer kann was / wohin damit" → node-strengths.ts (signed node profiles,
 *    live load, measured latency; no SSH, no Tailscale scan, no config),
 *  - "welches Modell passt hierher" → model-recommender.ts (the one catalog).
 * This module only combines both into the snapshot the mesh tools show.
 * It installs nothing; a recommendation is text, the install path stays the
 * governed Stufe-2 queue.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { getRecommendations, hardwareFromStrength } from './model-recommender.js'
import {
    collectNodeStrengths, formatStrengthList, rankNodes, shortReason, SKILLS,
    type NodeStrength, type Skill,
} from './node-strengths.js'

const BRAIN_STALE_MS = 30 * 60 * 1000

export interface InstallRecommendation {
    tool: string
    reason: string
    priority: 'high' | 'medium' | 'low'
    confidence: 'measured' | 'derived' | 'assumed'
    installCmd?: string
    estimatedSizeGB?: number
}

export interface MeshNodeEntry {
    name: string
    online: boolean
    skills: Skill[]
    recommendations: InstallRecommendation[]
    deprecatedModels: string[]
}

export interface RoutingEntry {
    task: string
    bestNode: string
    reason: string
    fallback?: string
}

export interface MeshSnapshot {
    scannedAt: number
    nodes: MeshNodeEntry[]
    summary: string
    routingTable: RoutingEntry[]
}

/** Old task names of the mesh_route tool → skill. */
export const LEGACY_TASKS: Record<string, Skill> = {
    'large-llm': 'grosse-modelle',
    'fast-llm': 'llm',
    'embedding': 'embedding',
    'image-generation': 'bilder',
    'stt-voice': 'stt',
    'media-convert': 'medien',
    'cuda-inference': 'llm',
}

export function taskToSkill(task: string): Skill | null {
    const key = String(task || '').trim().toLowerCase()
    if ((SKILLS as readonly string[]).includes(key)) return key as Skill
    return LEGACY_TASKS[key] || null
}

function installedModels(node: NodeStrength): string[] {
    return [...new Set(node.services.flatMap(service => service.models))]
}

/** Model advice for one node, from the one catalog. Only where a model runtime already runs. */
export function recommendationsFor(node: NodeStrength): { recommendations: InstallRecommendation[]; deprecated: string[] } {
    const runsOllama = node.services.some(service => service.running && /ollama/i.test(`${service.name} ${service.type}`))
    const installed = installedModels(node)
    const result = getRecommendations(node.nodeId, hardwareFromStrength(node), installed)
    if (!runsOllama) return { recommendations: [], deprecated: result.deprecated }
    const recommendations = result.toInstall.slice(0, 3).map((model, index): InstallRecommendation => {
        const entry = result.recommended.find(item => item.model === model)
        return {
            tool: model,
            reason: entry ? `${entry.description} — passt zu ${node.modelMemoryGB} GB ${node.modelMemoryHow}` : `passt zu ${node.modelMemoryGB} GB`,
            priority: index === 0 ? 'high' : 'medium',
            confidence: 'measured',
            installCmd: entry?.pullCmd,
        }
    })
    return { recommendations, deprecated: result.deprecated }
}

export function buildSnapshot(nodes: readonly NodeStrength[], now = Date.now()): MeshSnapshot {
    const entries: MeshNodeEntry[] = nodes.map(node => {
        const advice = recommendationsFor(node)
        return { name: node.nodeId, online: node.online, skills: node.skills, recommendations: advice.recommendations, deprecatedModels: advice.deprecated }
    })
    const routingTable: RoutingEntry[] = []
    for (const skill of SKILLS) {
        const ranking = rankNodes(skill, nodes)
        const best = ranking.ranked[0]
        if (best) routingTable.push({ task: skill, bestNode: best.nodeId, reason: shortReason(ranking), fallback: ranking.ranked[1]?.nodeId })
    }
    const lines = [formatStrengthList(nodes, now)]
    const advice = entries.filter(entry => entry.recommendations.length || entry.deprecatedModels.length)
    if (advice.length) {
        lines.push('', '*Modell-Tipps* (nur Vorschlag, nichts wird automatisch installiert)')
        for (const entry of advice) {
            if (entry.recommendations[0]) lines.push(`• ${entry.name}: ${entry.recommendations.map(rec => rec.tool).join(', ')}`)
            if (entry.deprecatedModels.length) lines.push(`• ${entry.name}: veraltet ${entry.deprecatedModels.join(', ')}`)
        }
    }
    return { scannedAt: now, nodes: entries, summary: lines.join('\n'), routingTable }
}

export class MeshBrain {
    private snapshot: MeshSnapshot | null = null
    private strengths: NodeStrength[] = []

    /** `_configNodes` is ignored (kept for old callers): no config, no SSH. */
    async scan(_configNodes: unknown = []): Promise<MeshSnapshot> {
        this.strengths = await collectNodeStrengths()
        this.snapshot = buildSnapshot(this.strengths)
        this.save()
        return this.snapshot
    }

    getSnapshot(): MeshSnapshot | null { return this.snapshot }

    load(): MeshSnapshot | null {
        try {
            const file = join(getNovaDataDir(), 'mesh-brain.json')
            if (existsSync(file)) {
                const data = JSON.parse(readFileSync(file, 'utf-8')) as MeshSnapshot
                if (Date.now() - data.scannedAt < BRAIN_STALE_MS && Array.isArray(data.routingTable)) {
                    this.snapshot = data
                    return data
                }
            }
        } catch { /* ignore */ }
        return null
    }

    save(): void {
        if (!this.snapshot) return
        try {
            const dir = getNovaDataDir()
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, 'mesh-brain.json'), JSON.stringify(this.snapshot, null, 2))
        } catch { /* ignore */ }
    }

    async explain(_configNodes: unknown = []): Promise<string> {
        const snap = this.load() || await this.scan()
        return snap.summary
    }

    /** Best node for a skill or an old task name ("large-llm" …). */
    getBestNodeFor(task: string): RoutingEntry | null {
        const skill = taskToSkill(task)
        if (!skill) return null
        return this.snapshot?.routingTable.find(entry => entry.task === skill) || null
    }

    getAllRecommendations(): Array<{ node: string, rec: InstallRecommendation }> {
        if (!this.snapshot) return []
        const order = { high: 0, medium: 1, low: 2 }
        return this.snapshot.nodes.flatMap(node => node.recommendations.map(rec => ({ node: node.name, rec })))
            .sort((a, b) => order[a.rec.priority] - order[b.rec.priority])
    }
}

let brainInstance: MeshBrain | null = null
export function getMeshBrain(): MeshBrain {
    if (!brainInstance) brainInstance = new MeshBrain()
    return brainInstance
}

export default { MeshBrain, getMeshBrain }
