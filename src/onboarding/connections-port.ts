// ============================================================================
// Andockstelle zu 2.85 Paket A ("Verbindungen", Branch claude/p13-connect).
//
// Der Erste Start fragt höchstens: "Gefundene Dienste verbinden?" und verweist
// dafür nur auf die Desktop-Ansicht "Verbindungen" aus Paket A. Er baut keinen
// eigenen Katalog und kein eigenes Verbinden. Bis Paket A gemergt ist, gibt es
// keinen Anbieter: der Schritt zeigt dann "noch nicht verfügbar".
//
// Beim Merge von Paket A genügt eine Zeile beim Start von Paket A:
//     registerConnectionsProvider(listConnections)
// listConnections() liefert die Einträge von Paket A; hier zählen nur status
// (gefunden | moeglich | verbunden) und title. Weitere Felder bleiben unberührt.
// ============================================================================

export interface ConnectionEntry {
    id: string
    title: string
    status: 'gefunden' | 'moeglich' | 'verbunden' | string
    [key: string]: unknown
}
export type ListConnections = () => Promise<readonly ConnectionEntry[]> | readonly ConnectionEntry[]

export interface ConnectionsSummary {
    /** false until Paket A registered its listConnections(). */
    available: boolean
    gefunden: number
    verbunden: number
    /** Up to five found services, for the sentence on the first-start page. */
    beispiele: string[]
    /** Desktop section that Paket A provides. */
    view: 'verbindungen'
}

let provider: ListConnections | null = null

export function registerConnectionsProvider(listConnections: ListConnections | null): void {
    provider = listConnections
}

export async function summarizeConnections(): Promise<ConnectionsSummary> {
    const empty: ConnectionsSummary = { available: false, gefunden: 0, verbunden: 0, beispiele: [], view: 'verbindungen' }
    if (!provider) return empty
    try {
        const entries = await provider()
        const found = entries.filter(entry => entry?.status === 'gefunden')
        return {
            available: true,
            gefunden: found.length,
            verbunden: entries.filter(entry => entry?.status === 'verbunden').length,
            beispiele: found.slice(0, 5).map(entry => String(entry.title || entry.id).slice(0, 60)),
            view: 'verbindungen',
        }
    } catch { return { ...empty, available: true } }
}
