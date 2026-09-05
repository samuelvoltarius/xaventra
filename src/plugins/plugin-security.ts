import { createHash, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type PluginPermission =
    | 'config.read'
    | 'tool.register'
    | 'command.register'
    | 'hook.register'
    | 'network'
    | 'filesystem.read'
    | 'filesystem.write'
    | 'process.spawn'

export interface SecurePluginManifest {
    name: string
    version: string
    main: string
    permissions?: PluginPermission[]
    integrity?: string
    signature?: string
    signingKeyId?: string
}

export interface PluginTrustDecision {
    trusted: boolean
    source: 'builtin' | 'signed' | 'development' | 'rejected'
    integrity: string
    permissions: PluginPermission[]
    reason?: string
}

const BUILTIN_PERMISSIONS: PluginPermission[] = [
    'config.read', 'tool.register', 'command.register', 'hook.register',
    'network', 'filesystem.read', 'process.spawn',
]

function isBuiltin(dir: string): boolean {
    const root = resolve(process.cwd(), 'plugins')
    const rel = relative(root, resolve(dir))
    return rel !== '' && !isAbsolute(rel) && !rel.startsWith('..') && !rel.includes('..\\') && !rel.includes('../')
}

function trustedKeys(): Record<string, string> {
    try {
        const parsed = JSON.parse(process.env.NOVA_PLUGIN_TRUSTED_KEYS || '{}')
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
}

export function calculatePluginIntegrity(dir: string, manifest: SecurePluginManifest): string {
    const main = resolve(dir, manifest.main)
    const rel = relative(resolve(dir), main)
    if (rel.startsWith('..') || rel.includes('..\\') || rel.includes('../')) throw new Error('Plugin main escapes plugin directory')
    if (!existsSync(main)) throw new Error(`Plugin main does not exist: ${main}`)
    return `sha256-${createHash('sha256').update(readFileSync(main)).digest('base64')}`
}

export function evaluatePluginTrust(dir: string, manifest: SecurePluginManifest): PluginTrustDecision {
    const integrity = calculatePluginIntegrity(dir, manifest)
    const permissions = manifest.permissions?.length ? [...new Set(manifest.permissions)] : isBuiltin(dir) ? BUILTIN_PERMISSIONS : []
    if (isBuiltin(dir)) {
        if (manifest.integrity && manifest.integrity !== integrity) return { trusted: false, source: 'rejected', integrity, permissions, reason: 'Built-in plugin integrity mismatch' }
        return { trusted: true, source: 'builtin', integrity, permissions }
    }
    if (process.env.NOVA_ALLOW_UNSIGNED_PLUGINS === '1') return { trusted: true, source: 'development', integrity, permissions }
    if (!manifest.integrity || manifest.integrity !== integrity) return { trusted: false, source: 'rejected', integrity, permissions, reason: 'Plugin integrity missing or mismatched' }
    const key = manifest.signingKeyId ? trustedKeys()[manifest.signingKeyId] : undefined
    if (!key || !manifest.signature) return { trusted: false, source: 'rejected', integrity, permissions, reason: 'Trusted signing key or signature missing' }
    const payload = Buffer.from(`${manifest.name}\n${manifest.version}\n${integrity}`)
    const valid = verify(null, payload, key, Buffer.from(manifest.signature, 'base64'))
    return valid
        ? { trusted: true, source: 'signed', integrity, permissions }
        : { trusted: false, source: 'rejected', integrity, permissions, reason: 'Plugin signature invalid' }
}

export function requirePluginPermission(permissions: readonly PluginPermission[], permission: PluginPermission, plugin: string): void {
    if (!permissions.includes(permission)) throw new Error(`Plugin ${plugin} lacks permission: ${permission}`)
}
