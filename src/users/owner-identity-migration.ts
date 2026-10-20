/**
 * 2.89.8 (U6): one-time, idempotent, governed re-scoping of the owner's data from the legacy
 * Desktop/HUD principals to the canonical owner principal (see owner-identity.ts).
 *
 *   - governed memories (the memory authority; KG nodes, facts and vector rows hang off them):
 *     `user:<alias>` → `user:<canonical>` through MemoryGovernance.rescope (audited). A memory
 *     that already exists identically under the canonical scope is NOT moved twice: the legacy
 *     copy is rejected (kept, never deleted) so recall shows the fact once.
 *   - session continuity summaries: copied to the canonical id when it has none (source stays).
 *   - the owner-account registry: a canonical that is still a legacy alias is repointed.
 * Before anything moves, a backup record (record ids + previous scopes) is written; a second run
 * finds nothing left to move. Non-owner principals (bots, probes, guests, REST) are never touched:
 * only the explicit alias list is considered.
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { principalScope } from './principal-id.js'
import { legacyOwnerAliases, resolveCanonicalOwner, type OwnerIdentityConfig } from './owner-identity.js'
import type { MemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import type { SessionContinuityStore } from '../memory/session-summarizer.js'
import type { OwnerAccountRegistry } from './owner-accounts.js'

export interface OwnerMigrationReport {
    skipped?: 'ambiguous' | 'no-canonical' | 'nothing-to-do'
    canonical: string | null
    rescoped: number
    duplicatesRetired: number
    sessionsAdopted: number
    registryRepointed: boolean
}

interface MarkerFile { version: 1; canonical: string; runs: Array<{ at: string; rescoped: number; duplicatesRetired: number; sessionsAdopted: number }> }

const aliasScopes = (aliases: string[]) => [...new Set(aliases.flatMap(alias => [principalScope(alias), principalScope(`desktop:${alias}`)]))]

export function migrateLegacyOwnerScopes(input: {
    config: OwnerIdentityConfig | null | undefined
    governance: MemoryGovernanceCoordinator
    sessions: SessionContinuityStore
    registry: OwnerAccountRegistry
    dir?: string
    aliases?: string[]
    now?: () => number
}): OwnerMigrationReport {
    const resolved = resolveCanonicalOwner(input.config)
    const report: OwnerMigrationReport = { canonical: resolved.principal, rescoped: 0, duplicatesRetired: 0, sessionsAdopted: 0, registryRepointed: false }
    if (resolved.ambiguous) {
        console.warn('[Owner] Migration skipped: several Telegram owners and no explicit owner mapping - nothing merged.')
        return { ...report, skipped: 'ambiguous' }
    }
    if (!resolved.principal) return { ...report, skipped: 'no-canonical' }
    const canonical = resolved.principal
    const aliases = (input.aliases || legacyOwnerAliases()).filter(alias => alias && alias !== canonical)
    const legacyScopes = aliasScopes(aliases).filter(scope => scope !== principalScope(canonical))
    const dir = input.dir || getNovaDataDir('users')
    const markerPath = `${dir}/owner-identity-migration.json`
    const stamp = new Date((input.now || Date.now)()).toISOString()

    const canonicalScope = principalScope(canonical)
    const existing = new Set(input.governance.list({ scope: canonicalScope }).map(record => record.fingerprint))
    const moves = legacyScopes.flatMap(scope => input.governance.list({ scope }).filter(record => record.status !== 'rejected'))
    const sessionMoves = aliases.flatMap(alias => [alias, `desktop:${alias}`]).filter(id => input.sessions.getSummary(id) && !input.sessions.getSummary(canonical))
    const repoint = Boolean(input.registry.canonical() && aliases.includes(input.registry.canonical()!))

    if (moves.length === 0 && sessionMoves.length === 0 && !repoint) return { ...report, skipped: 'nothing-to-do' }

    // Backup first: ids and previous scopes are enough to restore (nothing is deleted).
    const backupPath = `${dir}/owner-identity-backup-${stamp.replace(/[:.]/g, '-')}.json`
    atomicWriteJsonSync(backupPath, {
        version: 1, canonical, at: stamp,
        memories: moves.map(record => ({ id: record.id, scope: record.scope, fingerprint: record.fingerprint })),
        sessions: sessionMoves, registryCanonical: input.registry.canonical(),
    })

    for (const record of moves) {
        if (existing.has(record.fingerprint)) {
            input.governance.reject(record.id, 'owner-identity-migration')
            report.duplicatesRetired++
            continue
        }
        input.governance.rescope(record.id, canonicalScope, 'owner-identity-migration')
        existing.add(record.fingerprint)
        report.rescoped++
    }
    for (const id of sessionMoves) {
        if (input.sessions.adoptSession(id, canonical)) { report.sessionsAdopted++; break }
    }
    if (repoint) { input.registry.setCanonical(canonical); report.registryRepointed = true }

    let marker: MarkerFile = { version: 1, canonical, runs: [] }
    try { if (existsSync(markerPath)) marker = { ...marker, ...JSON.parse(readFileSync(markerPath, 'utf8')), canonical } } catch { /* fresh marker */ }
    marker.runs = [...(Array.isArray(marker.runs) ? marker.runs : []), { at: stamp, rescoped: report.rescoped, duplicatesRetired: report.duplicatesRetired, sessionsAdopted: report.sessionsAdopted }].slice(-20)
    atomicWriteJsonSync(markerPath, marker)
    console.log(`[Owner] Migration to canonical owner principal: ${report.rescoped} memories re-scoped, ${report.duplicatesRetired} duplicates retired, ${report.sessionsAdopted} session(s) adopted. Backup: ${backupPath}`)
    return report
}
