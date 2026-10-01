/**
 * P9 „ein Zeitplaner“: a legacy file that was taken over by the planner is
 * never deleted, only moved aside as `<name>.migriert` (or
 * `<name>.migriert.<zeit>` when an older copy is already there). A second
 * start therefore finds nothing to migrate again.
 */
import { existsSync, renameSync } from 'node:fs'

export const MIGRATED_SUFFIX = '.migriert'

/** Renames `path` to `<path>.migriert`; returns the new path or null when nothing was there. */
export function markMigrated(path: string, now: () => number = Date.now): string | null {
    if (!existsSync(path)) return null
    let target = `${path}${MIGRATED_SUFFIX}`
    if (existsSync(target)) target = `${target}.${now()}`
    try {
        renameSync(path, target)
        return target
    } catch (error) {
        console.warn(`[Planer] ${path} nicht umbenannt: ${(error as Error)?.message}`)
        return null
    }
}
