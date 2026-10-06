/**
 * 2.85 Integration — the docks between the packages, wired once at start
 * (daemon + desktop API; idempotent):
 *
 *   B → A  `registerConnectionsProvider(listConnections)`: the first start
 *          („Gefundene Dienste verbinden“) counts exactly what „Verbindungen“ shows.
 *   C → A  `registerConnectionSource('ki-modelle')`: Paket C's one list
 *          (`listLlmConnections`) appears in „Verbindungen“ — local models
 *          (KI-Modelle) and SearXNG (Suche/Hilfsdienste) under Gefunden, cloud
 *          providers under Möglich/Verbunden. Paket C keeps no view of its own:
 *          its desktop routes only do the key/login steps the buttons start.
 *   F ↔ A  `dockConnectionServiceRule()` (via `registerServiceNeedRule`): one need, one
 *          recipient — a failing tool of a catalog service that is not connected
 *          is classified once by `classifyNeed` as `dienst:<connector>`; the
 *          connection need rule (connection-demand.ts) reads that classification.
 */
import { registerConnectionsProvider } from '../onboarding/connections-port.js'
import type { LlmConnection } from '../llm/llm-connections.js'
import { listConnections, registerConnectionSource, unregisterConnectionSource, type SourceItem, type ViewDeps } from './connections-view.js'
import { dockConnectionServiceRule } from './connection-demand.js'

export const KI_SOURCE_ID = 'ki-modelle'

export interface DockOptions {
    /** View inputs for the first-start count (tests); default: the real data. */
    view?: () => ViewDeps
    /** Paket C's list (tests); default: `listLlmConnections({ includeMasks: true })` — the view is owner only. */
    llm?: () => Promise<{ alle: LlmConnection[] }> | { alle: LlmConnection[] }
    /** Connected connectors for the need rule (tests); default: the stored connections. */
    connected?: () => Set<string>
}

const hostOf = (endpoint?: string) => {
    try { return endpoint ? new URL(endpoint).host : '' } catch { return '' }
}

/** Paket C's entries as items of the „Verbindungen“ view (no secret: masks only). */
export function llmSourceItems(list: readonly LlmConnection[]): SourceItem[] {
    const out: SourceItem[] = []
    for (const item of list) {
        if (!item || typeof item.id !== 'string') continue
        if (item.datenklasse === 'lokal') {
            const host = hostOf(item.endpoint)
            out.push({
                id: item.id, title: item.title, kategorie: item.kategorie === 'suche' || item.kategorie === 'hilfsdienst' ? 'hilfsdienste' : 'ki-modelle', wirkung: item.wirkung,
                fund: host ? `im Netz ${host}` : 'auf diesem Rechner', datenklasse: 'lokal', icon: null,
                // Local = private: usable without a question, nothing to connect.
                verbunden: item.nutzbar === true,
            })
            continue
        }
        const provider = item.id.replace(/^cloud:/, '')
        const base = { id: item.id, title: item.title, kategorie: 'ki-modelle' as const, wirkung: item.wirkung, fund: '', datenklasse: 'cloud' as const, icon: null, connectorId: `llm:${provider}` }
        if (item.status === 'verbunden') {
            out.push({ ...base, status: 'verbunden', verbunden: true, llm: { provider, trennbar: Boolean(item.maske), maske: item.maske || null } })
        } else {
            out.push({
                ...base, status: 'moeglich', verbunden: false,
                llm: { provider, konto: item.anmeldung?.konto || null, kontoHinweis: item.anmeldung?.kontoHinweis || '', keyUrl: item.anmeldung?.keyUrl || '' },
            })
        }
    }
    return out
}

let unregisterRule: (() => void) | null = null

export function registerConnectionDocks(options: DockOptions = {}): void {
    registerConnectionsProvider(async () => (await listConnections(options.view ? options.view() : {})).map(entry => ({ ...entry })))
    registerConnectionSource({
        id: KI_SOURCE_ID,
        async list() {
            const result = options.llm
                ? await options.llm()
                : await (await import('../llm/llm-connections.js')).listLlmConnections({ includeMasks: true })
            return llmSourceItems(result.alle || [])
        },
    })
    unregisterRule?.()
    unregisterRule = dockConnectionServiceRule({ connected: options.connected })
}

/** Tests: undo the docks. */
export function unregisterConnectionDocks(): void {
    registerConnectionsProvider(null)
    unregisterConnectionSource(KI_SOURCE_ID)
    unregisterRule?.()
    unregisterRule = null
}
