/**
 * 2.85 Paket A — Stufe 2 „Weitere aus dem Verzeichnis“ (community, nicht geprüft).
 *
 * Source: the official MCP registry (`/v0/servers`, cursor paging, schema
 * 2025-12-11 with `icons`). Everything in it is UNTRUSTED data:
 * - only structured fields survive (name, title, description, version,
 *   remotes, packages as information, repository, one raster icon), each
 *   length-limited, control characters and markup removed, secrets redacted;
 * - unknown fields, header values, package arguments and environment
 *   variables are dropped — nothing from the directory is ever executed or
 *   installed automatically (packages are shown, never run);
 * - only https remotes are kept, without userinfo;
 * - deleted and non-latest entries are skipped.
 * The cache lives on the Main (`.nova-data/connections/registry-cache.json`)
 * and is refreshed by Xaventra herself at most once a day. Searching only
 * reads the cache. Entries that are already in the checked catalog are
 * hidden (Stufe 1 wins).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { getConnectorCatalog } from './connector-catalog.js'

export const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io/v0/servers'
export const DIRECTORY_REFRESH_MS = 24 * 60 * 60_000
const MAX_ENTRIES = 5000
const PAGE_LIMIT = 100

export interface CommunityRemote { type: 'streamable-http' | 'sse'; url: string; auth: boolean }
export interface CommunityPackage { registryType: string; identifier: string; version: string; transport: string }
export interface CommunityEntry {
    name: string
    title: string
    description: string
    version: string
    remotes: CommunityRemote[]
    packages: CommunityPackage[]
    repository?: string
    icon?: { src: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
    trust: 'community'
}
export interface DirectoryCache { version: 1; fetchedAt: number; complete: boolean; entries: CommunityEntry[] }

export interface DirectoryFetchResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type DirectoryFetch = (url: string) => Promise<DirectoryFetchResponse>

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{1,79}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Plain text: no control characters, no markup, secrets redacted, collapsed whitespace, length limit. */
export function plainText(value: unknown, max: number): string {
    const text = redactSecrets(String(value ?? ''))
        .replace(/<[^>]{0,200}>/g, ' ')
        .replace(/[<>`]/g, ' ')
        .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function httpsUrl(value: unknown, max = 300): string | null {
    if (typeof value !== 'string' || value.length > max) return null
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.username || url.password) return null
        return url.toString()
    } catch { return null }
}

/** One registry item → a clean community entry, or null. */
export function sanitizeRegistryEntry(raw: unknown): CommunityEntry | null {
    const item = raw as any
    const server = item?.server
    if (!server || typeof server !== 'object') return null
    const official = item?._meta?.['io.modelcontextprotocol.registry/official']
    if (official && (official.status === 'deleted' || official.isLatest === false)) return null
    const name = typeof server.name === 'string' && NAME.test(server.name) ? server.name : null
    if (!name) return null
    const remotes: CommunityRemote[] = []
    for (const remote of Array.isArray(server.remotes) ? server.remotes.slice(0, 6) : []) {
        if (remote?.type !== 'streamable-http' && remote?.type !== 'sse') continue
        const url = httpsUrl(remote.url)
        if (!url || remotes.some(existing => existing.url === url)) continue
        remotes.push({ type: remote.type, url, auth: Array.isArray(remote.headers) && remote.headers.length > 0 })
        if (remotes.length >= 3) break
    }
    const packages: CommunityPackage[] = []
    for (const pkg of Array.isArray(server.packages) ? server.packages.slice(0, 6) : []) {
        const identifier = plainText(pkg?.identifier, 120)
        if (!identifier) continue
        packages.push({
            registryType: plainText(pkg?.registryType, 20), identifier,
            version: plainText(pkg?.version, 40), transport: plainText(pkg?.transport?.type, 20),
        })
        if (packages.length >= 3) break
    }
    const icon = (Array.isArray(server.icons) ? server.icons : [])
        .map((entry: any) => ({ src: httpsUrl(entry?.src), mimeType: String(entry?.mimeType || '') }))
        .find((entry: { src: string | null; mimeType: string }) => entry.src && RASTER.has(entry.mimeType))
    const repository = httpsUrl(server.repository?.url, 200)
    return {
        name,
        title: plainText(server.title || name.split('/')[1], 60),
        description: plainText(server.description, 200),
        version: plainText(server.version, 40),
        remotes,
        packages,
        ...(repository ? { repository } : {}),
        ...(icon ? { icon: { src: icon.src!, mimeType: icon.mimeType as 'image/png' } } : {}),
        trust: 'community',
    }
}

const defaultCachePath = () => getNovaDataDir('connections', 'registry-cache.json')

export function readDirectoryCache(cachePath = defaultCachePath()): DirectoryCache {
    try {
        if (!existsSync(cachePath)) return { version: 1, fetchedAt: 0, complete: false, entries: [] }
        const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
        // The cache file is our own, but it is re-checked like fresh data.
        const entries = (Array.isArray(raw?.entries) ? raw.entries : []).slice(0, MAX_ENTRIES)
            .map((entry: CommunityEntry) => sanitizeRegistryEntry({ server: { ...entry, repository: entry?.repository ? { url: entry.repository } : undefined, icons: entry?.icon ? [entry.icon] : [] } }))
            .filter(Boolean) as CommunityEntry[]
        return { version: 1, fetchedAt: Number(raw?.fetchedAt) || 0, complete: raw?.complete === true, entries }
    } catch { return { version: 1, fetchedAt: 0, complete: false, entries: [] } }
}

export function directoryDue(cache: DirectoryCache, now = Date.now()): boolean {
    return !cache.fetchedAt || now - cache.fetchedAt >= DIRECTORY_REFRESH_MS
}

async function defaultFetch(url: string): Promise<DirectoryFetchResponse> {
    const { fetchWithSsrfGuard } = await import('../resilience/ssrf-guard.js')
    const res = await fetchWithSsrfGuard(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    return { ok: res.ok, status: res.status, json: async () => JSON.parse((await res.text()).slice(0, 2_000_000)) }
}

export interface RefreshOptions { fetchFn?: DirectoryFetch; baseUrl?: string; cachePath?: string; now?: number; maxPages?: number }
export interface RefreshResult { ok: boolean; entries: number; pages: number; complete: boolean; reason?: string }

/** Pages through the registry (cursor), sanitizes, writes the cache. A failed page keeps the previous cache. */
export async function refreshDirectory(options: RefreshOptions = {}): Promise<RefreshResult> {
    const fetchFn = options.fetchFn || defaultFetch
    const base = options.baseUrl || REGISTRY_BASE_URL
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 60, 200))
    const byName = new Map<string, CommunityEntry>()
    let cursor: string | undefined
    let pages = 0
    let complete = false
    try {
        while (pages < maxPages) {
            const url = `${base}?version=latest&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
            const res = await fetchFn(url)
            if (!res.ok) return { ok: false, entries: 0, pages, complete: false, reason: `Verzeichnis HTTP ${res.status}` }
            const body = await res.json() as any
            if (!body || !Array.isArray(body.servers)) return { ok: false, entries: 0, pages, complete: false, reason: 'Verzeichnis: unerwartete Antwort' }
            pages++
            for (const item of body.servers) {
                const clean = sanitizeRegistryEntry(item)
                if (clean && byName.size < MAX_ENTRIES) byName.set(clean.name, clean)
            }
            const next = typeof body.metadata?.nextCursor === 'string' && body.metadata.nextCursor.length <= 300 ? body.metadata.nextCursor : undefined
            if (!next) { complete = true; break }
            cursor = next
        }
    } catch (error) {
        return { ok: false, entries: 0, pages, complete: false, reason: plainText(error instanceof Error ? error.message : error, 160) }
    }
    const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    const cachePath = options.cachePath || defaultCachePath()
    mkdirSync(dirname(cachePath), { recursive: true })
    atomicWriteJsonSync(cachePath, { version: 1, fetchedAt: options.now ?? Date.now(), complete, entries })
    return { ok: true, entries: entries.length, pages, complete }
}

/** Refresh only when due (Main only; the caller decides). Never throws. */
export async function refreshDirectoryIfDue(options: RefreshOptions & { isMain: boolean }): Promise<RefreshResult | null> {
    if (!options.isMain) return null
    const cache = readDirectoryCache(options.cachePath)
    if (!directoryDue(cache, options.now ?? Date.now())) return null
    try { return await refreshDirectory(options) } catch { return null }
}

/** Search in the cache only (no network). Stufe-1 registry ids are hidden. */
export function searchDirectory(query: string, options: { cachePath?: string; limit?: number } = {}): CommunityEntry[] {
    const checked = new Set(getConnectorCatalog().entries.map(entry => entry.quelle.registry_id).filter(Boolean))
    const needle = plainText(query, 80).toLowerCase()
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
    return readDirectoryCache(options.cachePath).entries
        .filter(entry => !checked.has(entry.name))
        .filter(entry => !needle || `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(needle))
        .slice(0, limit)
}

export function findDirectoryEntry(name: string, cachePath?: string): CommunityEntry | undefined {
    if (!NAME.test(String(name || ''))) return undefined
    return readDirectoryCache(cachePath).entries.find(entry => entry.name === name)
}
