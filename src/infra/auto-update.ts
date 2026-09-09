/** Compatibility exports. Updates never stash, pull, install dependencies or
 * reset the running checkout. All discovery uses the canonical upstream source. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configuredUpstreamSource } from '../core/upstream-update-command.js'

export async function checkForUpdates() { return configuredUpstreamSource().check() }
export async function pullAndRebuild() {
    return { success: false, blocked: true, buildSuccess: false,
        error: 'In-place Git updates are disabled. Use /update check and /update prepare <release-id>; activation requires an enrolled controller.' }
}
export function getVersionInfo() {
    const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim() } catch { return 'unknown' } }
    return { commit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), date: git('log', '-1', '--format=%ci'), message: git('log', '-1', '--format=%s') }
}
/** Historical read only. Private log entries are never release artifacts. */
export function getUpdateHistory(limit = 10) {
    try { const history = JSON.parse(readFileSync(join(process.cwd(), '.nova-data', 'update-log.json'), 'utf8')); return Array.isArray(history) ? history.slice(-Math.max(1, Math.min(50, limit))) : [] }
    catch { return [] }
}
export default { checkForUpdates, pullAndRebuild, getVersionInfo, getUpdateHistory }
