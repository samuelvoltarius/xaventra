export type RuntimeProfileName = 'home' | 'server' | 'nas' | 'worker' | 'developer'
export interface RuntimeBundle { name: string; capabilities: readonly string[]; defaults?: Readonly<Record<string, string | boolean | number>> }
export interface RuntimeProfile { name: RuntimeProfileName; bundles: readonly string[]; mainEligible: boolean; channels: 'fenced' | 'disabled' | 'development' }

const BUNDLES = new Map<string, RuntimeBundle>([
    ['core', { name: 'core', capabilities: ['execution-kernel', 'tool-evidence', 'outcome-ledger'] }],
    ['memory', { name: 'memory', capabilities: ['governed-memory', 'continuity', 'compaction'] }],
    ['mesh', { name: 'mesh', capabilities: ['direct-mesh', 'leases', 'fencing', 'checkpoints'] }],
    ['channels', { name: 'channels', capabilities: ['telegram', 'whatsapp', 'discord'], defaults: { channelAuthority: 'lease-and-fencing' } }],
    ['developer', { name: 'developer', capabilities: ['lsp', 'code-runtime', 'plugin-hmr', 'acp'] }],
    ['observability', { name: 'observability', capabilities: ['otel', 'trust', 'runtime-catalogs'] }],
    ['worker-hardening', { name: 'worker-hardening', capabilities: ['node-only', 'read-only-root', 'signed-work'] }],
])

const PROFILES: Record<RuntimeProfileName, RuntimeProfile> = {
    home: { name: 'home', bundles: ['core', 'memory', 'mesh', 'channels', 'observability'], mainEligible: true, channels: 'fenced' },
    server: { name: 'server', bundles: ['core', 'memory', 'mesh', 'observability', 'worker-hardening'], mainEligible: false, channels: 'disabled' },
    nas: { name: 'nas', bundles: ['core', 'memory', 'mesh', 'channels', 'observability', 'worker-hardening'], mainEligible: true, channels: 'fenced' },
    worker: { name: 'worker', bundles: ['core', 'mesh', 'observability', 'worker-hardening'], mainEligible: false, channels: 'disabled' },
    developer: { name: 'developer', bundles: ['core', 'memory', 'mesh', 'channels', 'developer', 'observability'], mainEligible: false, channels: 'development' },
}

export interface ResolvedRuntimeProfile extends RuntimeProfile { resolvedBundles: RuntimeBundle[]; capabilities: string[] }

export function resolveRuntimeProfile(input?: { profile?: string; bundles?: string[]; hotReload?: boolean }): ResolvedRuntimeProfile {
    const requested = String(input?.profile || process.env.NOVA_RUNTIME_PROFILE || (process.env.NOVA_NODE_ONLY === 'true' ? 'worker' : 'home')).toLowerCase()
    if (!(requested in PROFILES)) throw new Error(`Unknown Nova runtime profile: ${requested}`)
    const base = PROFILES[requested as RuntimeProfileName]
    const names = [...new Set([...base.bundles, ...(input?.bundles || [])])]
    const resolvedBundles = names.map(name => {
        const bundle = BUNDLES.get(name)
        if (!bundle) throw new Error(`Unknown Nova runtime bundle: ${name}`)
        return bundle
    })
    if (input?.hotReload && base.name !== 'developer') throw new Error('Plugin hot reload is restricted to the developer profile')
    return { ...base, bundles: names, resolvedBundles, capabilities: [...new Set(resolvedBundles.flatMap(bundle => bundle.capabilities))].sort() }
}

export function listRuntimeProfiles(): RuntimeProfile[] { return Object.values(PROFILES).map(profile => ({ ...profile, bundles: [...profile.bundles] })) }
export function listRuntimeBundles(): RuntimeBundle[] { return [...BUNDLES.values()].map(bundle => ({ ...bundle, capabilities: [...bundle.capabilities] })) }
