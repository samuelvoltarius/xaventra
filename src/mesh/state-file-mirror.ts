/**
 * 2.86 package K — bridge between the journal and the existing Main stores.
 *
 * The Main's knowledge lives in a fixed set of files under .nova-data. The
 * acting Main scans them (content hash), journals every change as a
 * put/delete of the whole file, and a successor materializes the restored
 * state back into its own .nova-data before it starts services. Only the
 * allow-listed paths below are ever read or written; content is verified
 * against its sha256 before it is written.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../core/atomic-storage.js'
import type { MainState, MainStateDomain, StateChange } from './state-journal.js'

export interface MainStateFile { domain: MainStateDomain; path: string }

/** Store files (relative to .nova-data) as used by the owning modules. */
export const MAIN_STATE_FILES: readonly MainStateFile[] = Object.freeze([
    { domain: 'missions', path: 'auftraege.json' },                                  // core/autonomous-executor
    { domain: 'missions', path: 'missions/responsibility-missions.json' },           // core/missions
    { domain: 'cards', path: 'approval-cards/cards.json' },                          // core/approval-cards
    { domain: 'planner', path: 'planner/jobs.json' },                                // planner/planner
    { domain: 'thoughts', path: 'thinking/thoughts.jsonl' },                         // thinking/ports
    { domain: 'thoughts', path: 'thinking/ideas-state.json' },                       // thinking
    { domain: 'responsibilities', path: 'responsibilities/responsibilities.json' },  // core/responsibilities
    { domain: 'decisions', path: 'decisions/decisions.json' },                       // core/decisions
    { domain: 'procedures', path: 'learning/procedures.json' },                      // learning/procedure-store
    { domain: 'memoryGovernance', path: 'memory/governance/records.json' },          // memory/memory-governance
    { domain: 'tools', path: 'forge/werkzeuge.json' },                               // tools/skill-builder
] as const)

interface FileValue { sha256: string; content: string }

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex')

export function scanStateFileChanges(
    dataDir: string,
    state: MainState,
    options: { files?: readonly MainStateFile[]; maxBytes?: number } = {},
): { changes: StateChange[]; skipped: string[] } {
    const files = options.files || MAIN_STATE_FILES
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    const changes: StateChange[] = []
    const skipped: string[] = []
    for (const file of files) {
        const full = join(dataDir, file.path)
        const known = state[file.domain]?.[file.path] as FileValue | undefined
        if (!existsSync(full)) {
            if (known) changes.push({ domain: file.domain, key: file.path, op: 'delete' })
            continue
        }
        try {
            if (statSync(full).size > maxBytes) { skipped.push(file.path); continue }
            const content = readFileSync(full, 'utf8')
            const hash = sha256(content)
            if (known?.sha256 !== hash) changes.push({ domain: file.domain, key: file.path, op: 'put', value: { sha256: hash, content } })
        } catch {
            skipped.push(file.path)
        }
    }
    return { changes, skipped }
}

/** Write the restored store files into `dataDir`; returns the written relative paths. */
export function materializeStateFiles(state: MainState, dataDir: string, files: readonly MainStateFile[] = MAIN_STATE_FILES): string[] {
    const written: string[] = []
    for (const file of files) {
        const value = state[file.domain]?.[file.path] as FileValue | undefined
        if (!value || typeof value.content !== 'string' || sha256(value.content) !== value.sha256) continue
        atomicWriteFileSync(join(dataDir, file.path), value.content)
        written.push(file.path)
    }
    return written
}
