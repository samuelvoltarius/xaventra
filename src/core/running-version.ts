/**
 * 2.92.2: the one source of "which version is running": package.json of this installation, found next to the code.
 * Never process.cwd() - a container's working directory is /runtime, which can hold a stale copy (ns1 named 2.90.2
 * while /lage said 2.91.2). Works from src/core and dist/core alike.
 */
import { readFileSync } from 'node:fs'

let cached: string | undefined

export function runningVersion(): string {
    if (cached !== undefined) return cached
    try { cached = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0') }
    catch { cached = '0.0.0' }
    return cached
}
