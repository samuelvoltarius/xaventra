import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_FILENAME = 'xaventra.config.json'
export const LEGACY_CONFIG_FILENAME = 'nova.config.json'

/** New installs use Xaventra. Existing Nova installs keep their same file.
 * Never copy credentials or merge two independently edited configurations. */
export function resolveConfigPath(root = process.cwd()): string {
    const preferred = join(root, CONFIG_FILENAME)
    if (existsSync(preferred)) return preferred
    const legacy = join(root, LEGACY_CONFIG_FILENAME)
    return existsSync(legacy) ? legacy : preferred
}
