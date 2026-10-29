/**
 * 2.90.0 switches of "Kontext je Aufgabe" (one source for pipeline, runner and /kontext).
 *
 *   metrics     on | off               one line per turn in .nova-data/context-metrics.jsonl
 *   taskPrompt  off | shadow | on      task prompt: shadow builds and measures it, the old prompt is sent
 *   lagebild    off | shadow | on      measured self-image: shadow only via /lage, on puts it into the prompt
 *
 * Config `context.<name>` in xaventra.config.json, the environment variable wins.
 * An unknown value falls back to the default, never to `on`.
 */
import { getNovaState } from './nova-state.js'

export type ContextSwitchName = 'metrics' | 'taskPrompt' | 'lagebild'
export type ContextSwitchMode = 'off' | 'shadow' | 'on'

const ENV: Record<ContextSwitchName, string> = {
    metrics: 'XAVENTRA_CONTEXT_METRICS',
    taskPrompt: 'XAVENTRA_TASK_PROMPT',
    lagebild: 'XAVENTRA_LAGEBILD',
}
const DEFAULTS: Record<ContextSwitchName, ContextSwitchMode> = { metrics: 'on', taskPrompt: 'shadow', lagebild: 'shadow' }

function parseMode(name: ContextSwitchName, value: unknown): ContextSwitchMode | null {
    const text = String(value ?? '').trim().toLowerCase()
    if (!text) return null
    if (text === 'off' || text === 'false' || text === '0') return 'off'
    if (text === 'on' || text === 'true' || text === '1') return 'on'
    // Metrics have no shadow: measuring is the shadow.
    if (text === 'shadow') return name === 'metrics' ? 'on' : 'shadow'
    return null
}

function currentConfig(): Record<string, any> | null {
    try { return getNovaState().config } catch { return null }
}

export function contextSwitch(
    name: ContextSwitchName,
    source: { env?: NodeJS.ProcessEnv; config?: Record<string, any> | null } = {},
): ContextSwitchMode {
    const env = source.env ?? process.env
    const config = source.config === undefined ? currentConfig() : source.config
    return parseMode(name, env[ENV[name]])
        ?? parseMode(name, config?.context?.[name])
        ?? DEFAULTS[name]
}
