/** Read-only entity inventory behind an existing owner-approved HA connection.
 * Entities are functions, not a count of physical devices. No service calls. */
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { loadConnections } from '../connections/connection-store.js'
import { connectionState } from '../connections/connection-state.js'
import { cleanBasis, defaultDeps } from '../connections/connect-flow.js'
import { haBearerFetch } from '../connections/connector-login.js'
import { cleanText } from './ports.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { HaConnection } from './adapters/homeassistant.js'
import type { RawEvent } from './event-bus.js'
import { applyHaDeviceMetadata, boundedHaJson, haDeviceTemplate } from './ha-device-metadata.js'

export interface HaFunction { id: string; name: string; kind: string; state: string; available: boolean
    manufacturer?: string; model?: string; deviceId?: string; identitySource?: string
    /** 2.86 Paket N: HA area (Bereich) of the entity. */
    raum?: string }
export interface HaInventory { source: string; at: string; status: 'ok' | 'unavailable'; functions: HaFunction[]; truncated: boolean }
const file = (dataDir: string) => join(dataDir, 'sensing', 'ha-inventory.json')
const kinds: Record<string, string> = { light: 'Lichtfunktion', switch: 'Schalter (nicht automatisch eine Steckdose)', media_player: 'Medienfunktion (nicht automatisch ein TV)', climate: 'Heizung/Klima', cover: 'Rollladen/Abdeckung', fan: 'Ventilator', vacuum: 'Staubsauger', lock: 'Schloss' }

export function identifyHaFunctions(body: unknown): { functions: HaFunction[]; truncated: boolean } {
    if (!Array.isArray(body)) throw new Error('Ungültiger Home-Assistant-Bestand')
    const items = body.slice(0, 2000).filter(e => e && typeof e.entity_id === 'string' && /^[a-z_]+\.[a-z0-9_]{1,120}$/.test(e.entity_id) && Object.hasOwn(kinds, e.entity_id.split('.')[0]))
    const functions = items.slice(0, 200).map(e => ({ id: e.entity_id, name: cleanText(redactSecrets(String(e.attributes?.friendly_name || e.entity_id)), 80),
        kind: e.entity_id.startsWith('switch.') && e.attributes?.device_class === 'outlet' ? 'Steckdosenfunktion (laut HA-Geräteklasse)'
            : e.entity_id.startsWith('media_player.') && e.attributes?.device_class === 'tv' ? 'TV-Funktion (laut HA-Geräteklasse)' : kinds[e.entity_id.split('.')[0]],
        state: ['on', 'off', 'playing', 'paused', 'idle', 'unavailable'].includes(e.state) ? e.state : 'unknown', available: typeof e.state === 'string' && !!e.state && !['unavailable', 'unknown'].includes(e.state) }))
    return { functions, truncated: items.length > functions.length || body.length > 2000 }
}

/** Store a sanitized bounded observation, never connection credentials or arbitrary entity attributes. */
export function recordHaInventory(dataDir: string, inventory: HaInventory[]): void {
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(dataDir), { version: 1, sources: inventory.slice(0, 4) })
}

export async function refreshHaInventory(dataDir: string, legacy: HaConnection | null, signal: AbortSignal,
    fetchFn: typeof fetch = fetch, now = Date.now()): Promise<HaInventory[]> {
    // 2.89: „verbunden“ from the one connection truth; this reader only needs the owner's HA login records.
    const records = loadConnections({ dataDir }).filter(c => c.connectorId === 'home-assistant' && c.auth === 'ha-login' && c.approvedBy && c.basis
        && connectionState(dataDir, { verbindung: c }).zustand === 'verbunden')
    const sources: Array<{ id: string; base: string; fetch: typeof fetch }> = []
    for (const c of records.slice(0, 4)) {
        const base = cleanBasis(c.basis)
        if (base) sources.push({ id: c.id, base, fetch: haBearerFetch(c.id, { ...defaultDeps(), dataDir, fetchFn }) as typeof fetch })
    }
    const base = legacy && cleanBasis(legacy.url)
    if (base && !sources.some(s => s.base === base)) sources.push({ id: 'configured-ha', base,
        fetch: ((url, init) => fetchFn(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${legacy!.token}` } })) as typeof fetch })
    const result: HaInventory[] = []
    for (const source of sources.slice(0, 4)) {
        if (signal.aborted) return []
        try {
            const response = await source.fetch(`${source.base.replace(/\/$/, '')}/api/states`, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { Accept: 'application/json' } })
            if (!response.ok) throw new Error('HA inventory not available')
            const identified = identifyHaFunctions(await boundedHaJson(response))
            if (identified.functions.length && !signal.aborted) {
                try {
                    // POST is HA's documented template-read endpoint, NOT a state or service write.
                    // Only validated entity IDs enter a fixed template; no model/device code.
                    const metadata = await source.fetch(`${source.base.replace(/\/$/, '')}/api/template`, { method: 'POST', redirect: 'manual',
                        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ template: haDeviceTemplate(identified.functions) }) })
                    identified.functions = applyHaDeviceMetadata(identified.functions, await boundedHaJson(metadata))
                } catch { /* Keep measured functions when optional registry data is unavailable. */ }
            }
            result.push({ source: source.id, at: new Date(now).toISOString(), status: 'ok', ...identified })
        } catch { result.push({ source: source.id, at: new Date(now).toISOString(), status: 'unavailable', functions: [], truncated: false }) }
    }
    if (!signal.aborted) recordHaInventory(dataDir, result)
    return signal.aborted ? [] : result
}

/** One background thought for newly observed functions, no switching/card action. */
export function haInventoryEvents(sources: HaInventory[], previous: Record<string, string[]>): RawEvent[] {
    const events: RawEvent[] = []
    for (const source of sources.filter(s => s.status === 'ok')) {
        const known = new Set(previous[source.source] || [])
        const fresh = source.functions.filter(f => !known.has(f.id))
        previous[source.source] = source.functions.map(f => f.id)
        if (!fresh.length) continue
        events.push({ kind: 'ha.inventory', subject: source.source, severity: 'info',
            dedupeKey: `ha-functions:${source.source}:${fresh.map(f => f.id).sort().join(',').slice(0, 500)}`,
            dedupeWindowMs: 24 * 3600_000,
            summary: `${fresh.length} neue Gerätefunktionen über die bereits freigegebene Home-Assistant-Verbindung erkannt: ${fresh.slice(0, 4).map(f => `${f.name} (${f.kind})`).join('; ')}. Der Bestand wurde lesend geprüft; Schalten benötigt weiterhin eine konkrete Freigabe.`,
            evidence: { verbindung: source.source, neue_funktionen: fresh.length, quelle: 'autorisierte HA-Funktions-/Geräteregisterabfrage', beobachtet: source.at },
            hint: { importance: 'normal', title: 'Neue Gerätefunktionen hinter Home Assistant erkannt' } })
    }
    return events
}

export function haInventoryAwareness(dataDir: string, now = Date.now(), legacyAuthorized = false): string {
    let sources: HaInventory[] = []
    try { const raw = JSON.parse(readFileSync(file(dataDir), 'utf8')); sources = Array.isArray(raw.sources) ? raw.sources.slice(0, 4) : [] } catch { /* no receipt */ }
    const approved = new Set(loadConnections({ dataDir }).filter(c => c.connectorId === 'home-assistant' && c.approvedBy && connectionState(dataDir, { verbindung: c }).zustand === 'verbunden').map(c => c.id))
    const lines = ['Gerätefunktionen hinter Home Assistant (autorisierte lesende Bestandsabfrage):']
    for (const source of sources) {
        // A removed/expired owner connection invalidates its cached view immediately.
        const fresh = Number.isFinite(Date.parse(source.at)) && now >= Date.parse(source.at) && now - Date.parse(source.at) < 10 * 60_000
        if (source.source === 'configured-ha' ? !legacyAuthorized : !approved.has(source.source)) continue
        lines.push(`${cleanText(source.source, 80)}: ${source.status === 'ok' && fresh ? 'Bestand gelesen' : 'Bestand derzeit nicht bestätigt'}; ${cleanText(source.at, 30)}.`)
        if (source.status !== 'ok' || !fresh || !Array.isArray(source.functions)) continue
        if (!source.functions.length) lines.push('Keine unterstützten Licht-/Schalter-/Medienfunktionen im gelesenen Bestand.')
        for (const e of source.functions.slice(0, 16)) lines.push(`${cleanText(e.name, 80)} (${cleanText(e.id, 130)}): ${cleanText(e.kind, 80)}; ${e.manufacturer || e.model ? `Hersteller/Modell laut HA-Geräteregister: ${cleanText(e.manufacturer || 'unbekannt', 80)} / ${cleanText(e.model || 'unbekannt', 80)}; ` : ''}${e.available ? 'als verfügbar gemeldet' : 'nicht verfügbar'}; Verbindungsweg ${cleanText(source.source, 80)}. Schalten benötigt konkrete Freigabe.`)
        if (source.functions.length > 16 || source.truncated) lines.push('Weitere Funktionen vorhanden; Übersicht gekürzt.')
    }
    if (lines.length === 1) lines.push('Noch kein aktueller autorisierter Gerätebestand. Ein gefundener HA-Server reicht nicht; der bestehende Verbindungs-/Anmeldedialog ist nötig.')
    lines.push('Entitäten sind Funktionen. Hersteller/Modell stammen, wenn vorhanden, aus dem HA-Geräteregister; keine unabhängige physische Herstellerprüfung oder Geräteanzahl.')
    return redactSecrets(lines.join('\n')).slice(0, 3200)
}
