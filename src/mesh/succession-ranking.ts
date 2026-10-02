/**
 * 2.86 package K — narrow ranking interface for the Main succession.
 *
 * DOCKING POINT for package J ("Ein Mesh-Gehirn", branch claude/p14-meshbrain):
 * J provides the one measured node-strength module with `rankNodes('main')`.
 * Until it is merged this stub keeps the identical call shape
 * `rankNodes(role, nodes)` and reuses the existing deterministic hardware
 * score of the takeover preference (leader-election `nodeStrength`), so there
 * is no second scoring world. After the merge, re-export J's function here
 * (or point the import in succession.ts at it) and delete the stub body.
 */

import type { MeshNode } from './mesh-registry.js'
import { nodeStrength } from './leader-election.js'

export type NodeRankRole = 'main'

export interface RankedNode {
    nodeId: string
    hostname?: string
    score: number
    /** False for worker-only / retired nodes: they may hold state, never the Main role. */
    eligible: boolean
    reasons: string[]
}

export type RankNodesFn = (role: NodeRankRole, nodes: MeshNode[]) => RankedNode[]

export function rankNodes(role: NodeRankRole, nodes: MeshNode[]): RankedNode[] {
    if (role !== 'main') throw new Error(`unsupported ranking role ${String(role)}`)
    return nodes.map(node => {
        const caps = new Set(node.capabilities || [])
        const hw = (node.hardware || {}) as Record<string, unknown>
        const reasons: string[] = []
        if (hw.ram_gb) reasons.push(`RAM ${hw.ram_gb} GB`)
        if (hw.cores) reasons.push(`${hw.cores} Kerne`)
        if (hw.gpu || caps.has('gpu') || caps.has('cuda') || caps.has('metal')) reasons.push('GPU')
        if (caps.has('local-llm') || caps.has('ollama') || caps.has('inference-runtime')) reasons.push('lokales Modell')
        if (caps.has('internet')) reasons.push('Internet')
        const retired = node.lifecycle_state === 'retired' || node.lifecycle_state === 'tombstoned'
        const eligible = !caps.has('main-ineligible') && !retired
        if (!eligible) reasons.push(retired ? 'stillgelegt' : 'nicht Main-fähig (nur Speicher/Arbeit)')
        return { nodeId: node.node_id, hostname: node.hostname, score: nodeStrength(node), eligible, reasons }
    }).sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
}
