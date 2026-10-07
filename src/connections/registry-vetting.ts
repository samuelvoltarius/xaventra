/**
 * 2.88 Paket „Verbinden ohne Technik“, Punkt 1 — the registry is DISCOVERY,
 * Xaventra's own check decides the trust level.
 *
 *   Registry (registry-directory.ts, untrusted, cached)  →  pruefeEintrag  →  Stufe
 *
 * Checked, fixed rules (no model): manifest shape (sanitized on read),
 * publisher (namespace), source (repository), version (pinned semver),
 * tools/effects (description words; the real tool list is classified again at
 * connect time by connector-policy.ts), network (remote hosts) and required
 * secrets.
 *
 *   geprueft  — the entry IS in the checked catalog (Stufe 1): normal rules.
 *   community — https remote + public source + pinned version + no exec hint:
 *               only reading tools at first; a writing tool only after the
 *               owner allows exactly that tool (card on every call).
 *   unbekannt — anything else (no source, unpinned, exec/shell hints, package
 *               only): connect only through the card; then EVERY tool asks
 *               (also reads) — „Karte + Sandbox“: nothing of it runs here;
 *               packages are never installed or started from the directory
 *               (no npx/uvx, no curl|sh).
 *
 * Matching (what was found / what the owner wants) only reads the cache, so it
 * works offline; a failed refresh keeps the previous cache.
 */
import { getConnectorCatalog, type ConnectorCatalog, type ConnectorManifest } from './connector-catalog.js'
import { plainText, readDirectoryCache, searchDirectory, type CommunityEntry } from './registry-directory.js'

export type PruefStufe = 'geprueft' | 'community' | 'unbekannt'

export interface Pruefung {
    stufe: PruefStufe
    /** Publisher from the registry namespace (io.github.foo → github.com/foo, com.example → example.com). */
    herausgeber: string
    /** Public source (repository) or null. */
    quelle: string | null
    version: string
    gepinnt: boolean
    /** Hosts the connection talks to. */
    netz: string[]
    /** The server needs a login/secret (remote declares headers). */
    brauchtZugang: boolean
    /** Effects from the description words (hint only; tools are classified again at connect time). */
    wirkungen: Array<'lesen' | 'schreiben' | 'ausfuehren'>
    /** Can be connected at all (https remote). Packages only: never automatically. */
    verbindbar: boolean
    /** Plain reasons, shown on the card. */
    gruende: string[]
}

const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/
const FORGES = new Set(['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org'])
const EXEC_WORDS = /\b(?:execute|exec|shell|terminal|command[- ]line|run (?:any |arbitrary )?(?:code|commands?|scripts?)|bash|powershell|ssh|sudo|root access|eval)\b/i
const WRITE_WORDS = /\b(?:create|update|write|edit|delete|remove|send|post|publish|modify|manage|upload|deploy|schreib|lösch|sende|ändern)/i

/** github.com/foo for io.github.foo/…, example.com for com.example/…, else the namespace. */
export function publisherOf(name: string): string {
    const namespace = String(name || '').split('/')[0] || ''
    const parts = namespace.split('.').filter(Boolean)
    if (parts.length >= 3 && parts[0] === 'io' && parts[1] === 'github') return `github.com/${parts.slice(2).join('.')}`
    if (parts.length >= 2) return parts.slice().reverse().join('.')
    return namespace
}

function hostOf(url: string): string | null {
    try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

/** The fixed check of one directory entry. Never throws; never trusts the entry's own claims. */
export function pruefeEintrag(entry: CommunityEntry, catalog: ConnectorCatalog = getConnectorCatalog()): Pruefung {
    const checked = catalog.entries.find(item => item.quelle.registry_id === entry.name)
    const herausgeber = publisherOf(entry.name)
    const quelle = entry.repository || null
    const version = plainText(entry.version, 40)
    const gepinnt = SEMVER.test(version)
    const netz = [...new Set(entry.remotes.map(remote => hostOf(remote.url)).filter(Boolean) as string[])]
    const brauchtZugang = entry.remotes.some(remote => remote.auth)
    const text = `${entry.title} ${entry.description}`
    const wirkungen: Pruefung['wirkungen'] = ['lesen']
    if (WRITE_WORDS.test(text)) wirkungen.push('schreiben')
    const exec = EXEC_WORDS.test(text)
    if (exec) wirkungen.push('ausfuehren')
    const verbindbar = entry.remotes.length > 0
    if (checked) {
        return { stufe: 'geprueft', herausgeber, quelle, version, gepinnt, netz, brauchtZugang, wirkungen, verbindbar: true, gruende: [`steht im geprüften Katalog als „${checked.title}“`] }
    }
    const gruende: string[] = []
    const quelleHost = quelle ? hostOf(quelle) : null
    if (!quelle) gruende.push('keine öffentliche Quelle angegeben')
    else if (!quelleHost || !FORGES.has(quelleHost)) gruende.push(`Quelle auf ${quelleHost || 'unbekanntem Server'} (kein bekannter Code-Hoster)`)
    if (!gepinnt) gruende.push(`Version „${version || '—'}“ ist nicht fest`)
    if (!verbindbar) gruende.push('nur als Paket zum Installieren — das führe ich nie automatisch aus')
    if (exec) gruende.push('kann laut Beschreibung Befehle oder Code ausführen')
    // A GitHub publisher whose source lives in another account is suspicious (name squatting).
    if (quelle && herausgeber.startsWith('github.com/') && quelleHost === 'github.com') {
        let owner = ''
        try { owner = new URL(quelle).pathname.split('/')[1]?.toLowerCase() || '' } catch { owner = '' }
        if (owner && owner !== herausgeber.slice('github.com/'.length).toLowerCase()) gruende.push(`Quelle gehört ${owner}, nicht dem Herausgeber`)
    }
    const stufe: PruefStufe = gruende.length === 0 ? 'community' : 'unbekannt'
    if (stufe === 'community') gruende.push('öffentliche Quelle, feste Version, nur über https — zuerst nur lesend')
    if (brauchtZugang) gruende.push('braucht eine Anmeldung')
    return { stufe, herausgeber, quelle, version, gepinnt, netz, brauchtZugang, wirkungen, verbindbar, gruende }
}

/** One plain sentence for a card/list row. */
export function pruefSatz(pruefung: Pruefung): string {
    const stufe = pruefung.stufe === 'geprueft' ? 'Geprüft' : pruefung.stufe === 'community' ? 'Nicht geprüft (Verzeichnis), zuerst nur lesend' : 'Unbekannt: jedes Werkzeug fragt dich, auch Lesen'
    return `${stufe}. Von ${pruefung.herausgeber || '?'}${pruefung.version ? `, Version ${pruefung.version}` : ''}${pruefung.netz.length ? `, spricht mit ${pruefung.netz.join(', ')}` : ''}. ${pruefung.gruende.join('; ')}.`
}

export interface Vorschlag {
    /** Catalog name or directory name — what `requestConnect` takes. */
    connectorId: string
    title: string
    /** One short sentence. */
    satz: string
    stufe: PruefStufe
    verbindbar: boolean
    /** Logo (checked catalog: built-in; directory: only an already cached icon, no network). */
    icon: string | null
    pruefung?: Pruefung
}

const norm = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

function catalogHits(wish: string, catalog: ConnectorCatalog): ConnectorManifest[] {
    const words = norm(wish).split(/[^a-z0-9]+/).filter(word => word.length >= 3)
    if (!words.length) return []
    return catalog.entries.filter(entry => {
        const hay = norm(`${entry.name} ${entry.title} ${(entry.bedarf?.woerter || []).join(' ')}`)
        return words.some(word => hay.split(/[^a-z0-9]+/).some(token => token === word || (word.length >= 4 && token.startsWith(word))))
    })
}

export interface VorschlagOptions {
    cachePath?: string
    limit?: number
    catalog?: ConnectorCatalog
    icon?: (entry: CommunityEntry) => string | null
    catalogIcon?: (entry: ConnectorManifest) => string | null
}

/**
 * „Was der Owner will“ / „was gefunden wurde“ → suggestions: checked catalog first,
 * then the cached directory (each entry checked). Offline: cache only.
 */
export function vorschlaegeFuer(wunsch: string, options: VorschlagOptions = {}): Vorschlag[] {
    const catalog = options.catalog || getConnectorCatalog()
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20))
    const clean = plainText(wunsch, 80)
    if (!clean) return []
    const out: Vorschlag[] = catalogHits(clean, catalog).map(entry => ({
        connectorId: entry.name, title: entry.title, satz: `${entry.wirkung} (geprüft, ${entry.datenklasse}).`, stufe: 'geprueft' as const, verbindbar: true,
        icon: options.catalogIcon ? options.catalogIcon(entry) : null,
    }))
    const terms = [clean, ...clean.split(/\s+/).filter(word => word.length >= 4)]
    const seen = new Set(out.map(item => item.connectorId))
    for (const term of terms) {
        for (const entry of searchDirectory(term, { cachePath: options.cachePath, limit: 20 })) {
            if (seen.has(entry.name)) continue
            seen.add(entry.name)
            const pruefung = pruefeEintrag(entry, catalog)
            out.push({
                connectorId: entry.name, title: entry.title, satz: entry.description || entry.name, stufe: pruefung.stufe, verbindbar: pruefung.verbindbar,
                icon: options.icon ? options.icon(entry) : null, pruefung,
            })
        }
        if (out.length >= limit * 2) break
    }
    // Connectable first, then trust (geprüft, community, unbekannt); stable otherwise.
    const rank = (item: Vorschlag) => (item.verbindbar ? 0 : 10) + (item.stufe === 'geprueft' ? 0 : item.stufe === 'community' ? 1 : 2)
    return out.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).slice(0, limit).map(({ item }) => item)
}

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

export interface VersionsDrift { connectionId: string; connectorId: string; title: string; gepinnt: string; neu: string }

/**
 * Directory connections are pinned to the version the owner approved. When the
 * directory now lists another version, the caller drops the connection to
 * „unbekannt“ (every tool asks) and clears individually allowed tools until the
 * owner connects it again. Pure: reads the cache only.
 */
export function versionsDrift(records: ReadonlyArray<{ id: string; connectorId: string; title: string; trust: string; version?: string; status: string }>, cachePath?: string): VersionsDrift[] {
    const cache = readDirectoryCache(cachePath)
    if (!cache.entries.length) return []
    const byName = new Map(cache.entries.map(entry => [entry.name, entry]))
    const out: VersionsDrift[] = []
    for (const record of records) {
        if (record.trust !== 'community' || !record.version || record.status === 'getrennt') continue
        const latest = byName.get(record.connectorId)
        if (latest && latest.version && latest.version !== record.version) out.push({ connectionId: record.id, connectorId: record.connectorId, title: record.title, gepinnt: record.version, neu: latest.version })
    }
    return out
}
