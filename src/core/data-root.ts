import { join, resolve } from 'node:path'

/**
 * Central location for mutable Nova runtime data.
 * Tests set NOVA_RUNTIME_ROOT to an isolated temporary directory.
 */
export function getRuntimeRoot(): string {
    return resolve(process.env.NOVA_RUNTIME_ROOT || process.cwd())
}

export function getNovaDataDir(...parts: string[]): string {
    return join(getRuntimeRoot(), '.nova-data', ...parts)
}

export function getNovaLearningDir(...parts: string[]): string {
    return join(getRuntimeRoot(), '.nova-learning', ...parts)
}

