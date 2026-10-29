/**
 * 2.90.0 switches of "Kontext je Aufgabe" (one source for pipeline, runner and /kontext).
 *
 *   metrics     on | off               one line per turn in .nova-data/context-metrics.jsonl
 *   taskPrompt  off | shadow | on      task prompt: shadow builds and measures it, the old prompt is sent
 *   lagebild    off | shadow | on      measured self-image: shadow only via /lage, on puts it into the prompt
 *   threads     off | shadow           2.91.0 topic threads: shadow assigns and measures; own history per thread from 2.91.1
 *
 * Config `context.<name>` in xaventra.config.json, the environment variable wins.
 * An unknown value falls back to the default, never to `on`.
 */
import { getNovaState } from './nova-state.js'

export type ContextSwitchName = 'metrics' | 'taskPrompt' | 'lagebild' | 'threads'
export type ContextSwitchMode = 'off' | 'shadow' | 'on'

const ENV: Record<ContextSwitchName, string> = {
    metrics: 'XAVENTRA_CONTEXT_METRICS',
    taskPrompt: 'XAVENTRA_TASK_PROMPT',
    lagebild: 'XAVENTRA_LAGEBILD',
    threads: 'XAVENTRA_THREADS',
}
const DEFAULTS: Record<ContextSwitchName, ContextSwitchMode> = { metrics: 'on', taskPrompt: 'shadow', lagebild: 'shadow', threads: 'shadow' }

function parseMode(name: ContextSwitchName, value: unknown): ContextSwitchMode | null {
    const text = String(value ?? '').trim().toLowerCase()
    if (!text) return null
    if (text === 'off' || text === 'false' || text === '0') return 'off'
    // 2.91.0: threads have no `on` yet (own history per thread comes with 2.91.1) — it stays a measurement.
    if (text === 'on' || text === 'true' || text === '1') return name === 'threads' ? 'shadow' : 'on'
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

/**
 * 2.90.0 capabilities that are on by default and can each be turned off
 * (Koordinator 29.10.): test pods in xaventra-test and desktop input on an
 * enrolled node. Turning one off never touches the other; the node keeps its
 * own opt-in for desktop input, the cluster its RBAC for test pods.
 */
export type FeatureName = 'meshDesktopInput' | 'k8sTestPods'

const FEATURES: Record<FeatureName, { env: string; config: (config: Record<string, any> | null) => unknown }> = {
    meshDesktopInput: { env: 'NOVA_MESH_DESKTOP_INPUT_ENABLED', config: config => config?.mesh?.desktopInput },
    k8sTestPods: { env: 'XAVENTRA_K8S_TEST_PODS', config: config => config?.infra?.kubernetes?.testPods },
}

function parseOnOff(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value
    const text = String(value ?? '').trim().toLowerCase()
    if (!text) return null
    if (text === 'off' || text === 'false' || text === '0') return false
    if (text === 'on' || text === 'true' || text === '1') return true
    return null
}

export function featureEnabled(
    name: FeatureName,
    source: { env?: NodeJS.ProcessEnv; config?: Record<string, any> | null } = {},
): boolean {
    const feature = FEATURES[name]
    const env = source.env ?? process.env
    const config = source.config === undefined ? currentConfig() : source.config
    return parseOnOff(env[feature.env]) ?? parseOnOff(feature.config(config)) ?? true
}
