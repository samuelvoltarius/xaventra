/**
 * 2.85 Paket A — Community icons (Stufe 2). Only Stufe-1 icons ship with the
 * release; a community icon is fetched by the MAIN on first display (never by
 * the viewer's browser), checked and cached under `.nova-data/connections/icons/`:
 * - https only, through the SSRF guard (no private addresses), 5 s, no redirects
 *   to elsewhere beyond the guard's rules;
 * - raster only (PNG/JPEG/WebP), checked by magic bytes, not just the header;
 *   SVG is refused (no sanitizer needed when it never gets in);
 * - at most 64 KB; an `icon_hash` (sha256), when known, must match;
 * - stored by content hash; afterwards served from the cache only.
 * Any failure means "no icon", never an exception.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'

export const ICON_MAX_BYTES = 64 * 1024
export interface IconFetchResponse { ok: boolean; status: number; contentType: string; body: Buffer }
export type IconFetch = (url: string) => Promise<IconFetchResponse>
export type IconResult = { ok: true; hash: string; dataUri: string } | { ok: false; reason: string }

const TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
    'image/png': { ext: 'png', magic: b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    'image/jpeg': { ext: 'jpg', magic: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    'image/webp': { ext: 'webp', magic: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
}

const defaultDir = () => getNovaDataDir('connections', 'icons')
const indexPath = (dir: string) => join(dir, 'index.json')
function readIndex(dir: string): Record<string, { hash: string; type: string }> {
    try { return existsSync(indexPath(dir)) ? JSON.parse(readFileSync(indexPath(dir), 'utf8')) || {} : {} } catch { return {} }
}

async function defaultFetch(url: string): Promise<IconFetchResponse> {
    const { sideEffectsDisabled } = await import('../core/side-effects.js')
    if (sideEffectsDisabled()) throw new Error('Netzabruf in Tests/CI aus')
    const { fetchWithSsrfGuard } = await import('../resilience/ssrf-guard.js')
    const res = await fetchWithSsrfGuard(url, { headers: { Accept: 'image/png, image/jpeg, image/webp' }, signal: AbortSignal.timeout(5_000) })
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > ICON_MAX_BYTES) return { ok: false, status: 413, contentType: '', body: Buffer.alloc(0) }
    const body = Buffer.from(await res.arrayBuffer())
    return { ok: res.ok, status: res.status, contentType: String(res.headers.get('content-type') || ''), body }
}

const dataUri = (type: string, body: Buffer) => `data:${type};base64,${body.toString('base64')}`

/** Cached icon as data URI, or null (no network). */
export function cachedIcon(url: string, cacheDir = defaultDir()): string | null {
    const hit = readIndex(cacheDir)[url]
    if (!hit || !TYPES[hit.type] || !/^[a-f0-9]{64}$/.test(hit.hash)) return null
    try {
        const body = readFileSync(join(cacheDir, `${hit.hash}.${TYPES[hit.type].ext}`))
        return createHash('sha256').update(body).digest('hex') === hit.hash ? dataUri(hit.type, body) : null
    } catch { return null }
}

export async function fetchCommunityIcon(url: string, options: { fetchFn?: IconFetch; cacheDir?: string; expectedHash?: string } = {}): Promise<IconResult> {
    const cacheDir = options.cacheDir || defaultDir()
    let parsed: URL
    try { parsed = new URL(url) } catch { return { ok: false, reason: 'ungültige Adresse' } }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || url.length > 300) return { ok: false, reason: 'nur https' }
    const cached = cachedIcon(url, cacheDir)
    if (cached) {
        const hash = readIndex(cacheDir)[url].hash
        if (!options.expectedHash || options.expectedHash === hash) return { ok: true, hash, dataUri: cached }
    }
    let res: IconFetchResponse
    try { res = await (options.fetchFn || defaultFetch)(url) } catch { return { ok: false, reason: 'nicht erreichbar' } }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const type = String(res.contentType || '').split(';')[0].trim().toLowerCase()
    const spec = TYPES[type]
    if (!spec) return { ok: false, reason: 'nur PNG/JPEG/WebP' }
    if (!res.body?.length || res.body.length > ICON_MAX_BYTES) return { ok: false, reason: 'zu groß' }
    if (!spec.magic(res.body)) return { ok: false, reason: 'Inhalt passt nicht zum Typ' }
    const hash = createHash('sha256').update(res.body).digest('hex')
    if (options.expectedHash && options.expectedHash !== hash) return { ok: false, reason: 'icon_hash passt nicht' }
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, `${hash}.${spec.ext}`), res.body)
    const index = readIndex(cacheDir)
    index[url] = { hash, type }
    const keys = Object.keys(index)
    for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete index[key]
    atomicWriteJsonSync(indexPath(cacheDir), index)
    return { ok: true, hash, dataUri: dataUri(type, res.body) }
}
