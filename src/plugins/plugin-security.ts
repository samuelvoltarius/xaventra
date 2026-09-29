import { createHash, verify } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export interface PluginTrustOptions {
    /** Test seam: installation plugin root (default: <install>/plugins next to src/dist). */
    builtinRoot?: string
    /** Test seam: pinned built-in trust digests (default: BUILTIN_PLUGIN_DIGESTS). */
    builtinDigests?: Record<string, string>
}

const BUILTIN_PERMISSIONS: PluginPermission[] = [
    'config.read', 'tool.register', 'command.register', 'hook.register',
    'network', 'filesystem.read', 'process.spawn',
]

/**
 * Built-in plugins shipped with this installation, pinned by trust digest
 * (name, version, main, permissions and every module file). Location alone is
 * no trust: <cwd>/plugins is writable by file tools. When a built-in plugin
 * changes, update its digest here (`pluginTrustDigest(dir, manifest)`).
 */
export const BUILTIN_PLUGIN_DIGESTS: Record<string, string> = {
    'brain-hook': 'sha256-uR2htI480n9cEcfaeKdG5amUP9HkxAk9lL1prI8hrsA=',
}

const MANIFEST_FILES = new Set(['manifest.json', 'plugin.json'])

function installPluginRoot(): string {
    // src/plugins/plugin-security.ts and dist/plugins/plugin-security.js both sit two levels below the install root.
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins')
}

function isInside(root: string, target: string): boolean {
    const rel = relative(root, target)
    return rel !== '' && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..'
}

function realDir(dir: string): string {
    return realpathSync(resolve(dir))
}

function trustedKeys(): Record<string, string> {
    try {
        const parsed = JSON.parse(process.env.NOVA_PLUGIN_TRUSTED_KEYS || '{}')
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
}

function collectFiles(root: string, dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        const stat = lstatSync(path)
        // A symlink could point the signed tree at arbitrary code: fail closed.
        if (stat.isSymbolicLink()) throw new Error(`Plugin contains a symlink: ${relative(root, path)}`)
        if (stat.isDirectory()) collectFiles(root, path, out)
        else if (stat.isFile()) out.push(relative(root, path).split(/[\\/]/).join('/'))
    }
}

/**
 * Digest over every file of the plugin (except the manifest, which carries the
 * signature). Line endings are normalized so git checkouts hash identically.
 */
export function calculatePluginIntegrity(dir: string, manifest: SecurePluginManifest): string {
    const root = realDir(dir)
    const main = resolve(root, manifest.main)
    if (!isInside(root, main)) throw new Error('Plugin main escapes plugin directory')
    if (!existsSync(main)) throw new Error(`Plugin main does not exist: ${main}`)
    if (!isInside(root, realpathSync(main))) throw new Error('Plugin main escapes plugin directory')
    const files: string[] = []
    collectFiles(root, root, files)
    const hash = createHash('sha256')
    for (const file of files.filter(file => !MANIFEST_FILES.has(file)).sort()) {
        const content = readFileSync(join(root, file)).toString('latin1').replace(/\r\n/g, '\n')
        hash.update(`${file}\n${createHash('sha256').update(content, 'latin1').digest('hex')}\n`)
    }
    return `sha256-${hash.digest('base64')}`
}

/** What a signature or built-in pin covers: identity, entry point, permissions and all module files. */
function trustPayload(manifest: SecurePluginManifest, integrity: string): string {
    const permissions = [...new Set(manifest.permissions || [])].sort().join(',')
    return `${manifest.name}\n${manifest.version}\n${manifest.main}\n${permissions}\n${integrity}`
}

export function pluginTrustDigest(dir: string, manifest: SecurePluginManifest): string {
    const payload = trustPayload(manifest, calculatePluginIntegrity(dir, manifest))
    return `sha256-${createHash('sha256').update(payload).digest('base64')}`
}

function isBuiltin(dir: string, manifest: SecurePluginManifest, integrity: string, options: PluginTrustOptions): boolean {
    let root: string
    try { root = realDir(options.builtinRoot || installPluginRoot()) } catch { return false }
    const real = realDir(dir)
    if (dirname(real) !== root || basename(real) !== manifest.name) return false
    const pinned = (options.builtinDigests || BUILTIN_PLUGIN_DIGESTS)[manifest.name]
    if (!pinned) return false
    const digest = `sha256-${createHash('sha256').update(trustPayload(manifest, integrity)).digest('base64')}`
    return digest === pinned
}

export function evaluatePluginTrust(dir: string, manifest: SecurePluginManifest, options: PluginTrustOptions = {}): PluginTrustDecision {
    let integrity: string
    try {
        integrity = calculatePluginIntegrity(dir, manifest)
    } catch (error) {
        return { trusted: false, source: 'rejected', integrity: '', permissions: [], reason: String(error instanceof Error ? error.message : error) }
    }
    const builtin = isBuiltin(dir, manifest, integrity, options)
    const permissions = manifest.permissions?.length ? [...new Set(manifest.permissions)] : builtin ? BUILTIN_PERMISSIONS : []
    if (builtin) {
        if (manifest.integrity && manifest.integrity !== integrity) return { trusted: false, source: 'rejected', integrity, permissions, reason: 'Built-in plugin integrity mismatch' }
        return { trusted: true, source: 'builtin', integrity, permissions }
    }
    if (process.env.NOVA_ALLOW_UNSIGNED_PLUGINS === '1') return { trusted: true, source: 'development', integrity, permissions }
    if (!manifest.integrity || manifest.integrity !== integrity) return { trusted: false, source: 'rejected', integrity, permissions, reason: 'Plugin integrity missing or mismatched' }
    const key = manifest.signingKeyId ? trustedKeys()[manifest.signingKeyId] : undefined
    if (!key || !manifest.signature) return { trusted: false, source: 'rejected', integrity, permissions, reason: 'Trusted signing key or signature missing' }
    const payload = Buffer.from(trustPayload(manifest, integrity))
    let valid = false
    try { valid = verify(null, payload, key, Buffer.from(manifest.signature, 'base64')) } catch { valid = false }
    return valid
        ? { trusted: true, source: 'signed', integrity, permissions }
        : { trusted: false, source: 'rejected', integrity, permissions, reason: 'Plugin signature invalid' }
}

export function requirePluginPermission(permissions: readonly PluginPermission[], permission: PluginPermission, plugin: string): void {
    if (!permissions.includes(permission)) throw new Error(`Plugin ${plugin} lacks permission: ${permission}`)
}
