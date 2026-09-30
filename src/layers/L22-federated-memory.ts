/**
 * L22 - Federated governed memory sync.
 *
 * Nodes exchange lifecycle records (including rejection/supersession
 * tombstones), never raw Knowledge Graph snapshots. Local KG/Lance/Core Facts
 * remain projections rebuilt from the merged governance state.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sideEffectsDisabled } from '../core/side-effects.js'
import { getMemoryGovernanceCoordinator, type GovernedMemory } from '../memory/memory-governance.js'
import { pullSharedMemory, pushSharedMemory } from '../memory/shared-memory.js'

const SNAPSHOT_SCOPE = 'memory-governance'
const MAX_RECORDS_PER_SYNC = 500
const DEFAULT_SYNC_INTERVAL_MS = 10 * 60 * 1000

let syncTimer: ReturnType<typeof setInterval> | null = null
let lastSnapshotHash = ''

export function readNodeId(): string {
    const canonical = process.env.NOVA_NODE_ID?.trim()
    if (canonical) return canonical
    try {
        return readFileSync(join(process.cwd(), '.nova-data', 'instance-id.txt'), 'utf-8').trim()
    } catch {
        return process.env.NOVA_NODE_NAME || 'unknown'
    }
}

// Only memories that mean something on another node travel. Operational notes
// (health_status, nova_introspect, mesh_nodes observations every 10 minutes,
// 30-minute TTL) describe this node's own state, and expiry is time-based on
// every node. Live 30.09.2026 they were 1010 of 1012 records and every new note
// re-shipped up to 500 full records to all peers.
export function isReplicatedMemory(record: GovernedMemory): boolean {
    return record.status !== 'candidate' && record.status !== 'expired' && record.kind !== 'operational'
}

function compactSnapshot(records: GovernedMemory[]): GovernedMemory[] {
    return [...records]
        .filter(isReplicatedMemory)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_RECORDS_PER_SYNC)
}

let warnedNoTrustedNodes = false

// Fail-closed: shared_memory rows (including source_node) are writable by
// every node holding the shared key, so without an explicit allow-list no
// remote snapshot - and therefore no remote tombstone - is imported.
function isTrustedNode(nodeId: string): boolean {
    const configured = (process.env.NOVA_MEMORY_TRUSTED_NODES || '')
        .split(',').map(value => value.trim()).filter(Boolean)
    if (configured.length === 0) {
        if (!warnedNoTrustedNodes) {
            warnedNoTrustedNodes = true
            console.log('[L22] NOVA_MEMORY_TRUSTED_NODES not set - remote governance snapshots are ignored')
        }
        return false
    }
    return configured.includes(nodeId)
}

async function publishGovernanceSnapshot(): Promise<boolean> {
    const governance = getMemoryGovernanceCoordinator()
    const records = compactSnapshot(governance.getReplicationSnapshot())
    const content = JSON.stringify({ version: 1, records })
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 24)
    if (hash === lastSnapshotHash) return false

    const nodeId = readNodeId()
    const ok = await pushSharedMemory({
        id: `governance_snapshot_${nodeId}`,
        userId: 'system',
        role: 'system',
        content,
        timestamp: Date.now(),
        keywords: ['memory-governance', 'tombstones', nodeId],
        sourceNode: nodeId,
        scope: SNAPSHOT_SCOPE,
        metadata: { hash, records: records.length, format: 'nova-memory-governance-v1' },
    })
    if (ok) lastSnapshotHash = hash
    return ok
}

async function importRemoteSnapshots(): Promise<number> {
    const localNode = readNodeId()
    const entries = await pullSharedMemory({ scope: SNAPSHOT_SCOPE, limit: 200 })
    let imported = 0
    for (const entry of entries) {
        if (entry.scope !== SNAPSHOT_SCOPE || entry.sourceNode === localNode) continue
        if (entry.metadata?.format !== 'nova-memory-governance-v1') continue
        if (!entry.sourceNode || !isTrustedNode(entry.sourceNode)) continue
        const actualHash = createHash('sha256').update(entry.content).digest('hex').slice(0, 24)
        if (entry.metadata?.hash !== actualHash) continue
        try {
            const payload = JSON.parse(entry.content) as { version: number; records: GovernedMemory[] }
            if (payload.version !== 1 || !Array.isArray(payload.records)) continue
            imported += await getMemoryGovernanceCoordinator()
                .mergeReplicationSnapshot(compactSnapshot(payload.records), entry.sourceNode)
        } catch { /* malformed or untrusted snapshot */ }
    }
    return imported
}

export async function syncFederatedMemoryOnce(): Promise<{
    published: boolean
    imported: number
    stats: ReturnType<ReturnType<typeof getMemoryGovernanceCoordinator>['getStats']>
}> {
    const published = await publishGovernanceSnapshot()
    const imported = await importRemoteSnapshots()
    return { published, imported, stats: getMemoryGovernanceCoordinator().getStats() }
}

export function initFederatedMemory(intervalMs = DEFAULT_SYNC_INTERVAL_MS): void {
    if (sideEffectsDisabled()) {
        console.log('[L22] Federated Memory auto-sync skipped (side-effect guard active)')
        return
    }
    if (syncTimer) return
    syncFederatedMemoryOnce()
        .then(r => console.log(`[L22] Governance sync: published=${r.published}, imported=${r.imported}`))
        .catch(err => console.log(`[L22] Initial sync skipped: ${err}`))
    syncTimer = setInterval(() => {
        syncFederatedMemoryOnce()
            .then(r => {
                if (r.published || r.imported > 0) {
                    console.log(`[L22] Governance sync: published=${r.published}, imported=${r.imported}`)
                }
            })
            .catch(err => console.debug(`[L22] Sync failed: ${err}`))
    }, intervalMs)
    console.log('[L22] Federated governed memory initialized')
}

export function stopFederatedMemory(): void {
    if (syncTimer) clearInterval(syncTimer)
    syncTimer = null
}

export default { initFederatedMemory, stopFederatedMemory, syncFederatedMemoryOnce }
