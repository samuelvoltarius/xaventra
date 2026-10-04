import type { MCPServer } from '../mcp/mcp-client.js'
import type { ConnectionRecord } from '../connections/connection-store.js'
import { connectorToolVerdict } from '../connections/connector-policy.js'
import { cleanText } from './ports.js'
import { redactSecrets } from '../security/secret-redaction.js'

type NodeView = { name: string; address: string; online: boolean; capabilities: Array<{ name: string; provider: string; available: boolean }> }

/** Display only canonical snapshots. No connections, probes, resource reads or
 * tool calls: catalog presence must never become an execution permission. */
export function connectionAwareness(nodes: NodeView[], servers: MCPServer[], connections: ConnectionRecord[], registeredTools: Set<string>): string {
    const safe = (value: string, limit = 100) => cleanText(redactSecrets(String(value || '')), limit)
    const labels: Record<string, string> = { llm: 'Sprachmodell', vision: 'Bildanalyse', tts: 'Sprachausgabe', stt: 'Spracherkennung', embedding: 'semantische Suche', code: 'Code-Modell', tools: 'Werkzeug-Modell' }
    const lines = ['Node-Fähigkeiten aus dem aktuellen Capability-Bestand:']
    for (const node of nodes.slice(0, 12)) {
        const capabilities = [...new Set(node.capabilities.filter(c => node.online && c.available).map(c => `${labels[c.name] || safe(c.name)} (${safe(c.provider, 60)})`))]
        lines.push(`${safe(node.name)} (${safe(node.address)}): ${node.online ? 'online' : 'veraltet/offline'}; ${capabilities.slice(0, 8).join(', ') || 'keine aktuell verfügbare Modell-Fähigkeit belegt'}.`)
    }
    if (!nodes.length) lines.push('Noch keine Node-Fähigkeiten im Capability-Bestand. Das bedeutet nicht, dass keine Nodes existieren.')
    if (nodes.length > 12) lines.push(`${nodes.length - 12} weitere Nodes; Übersicht gekürzt.`)
    const nodeEnd = lines.length
    lines.push('Verfügbare Arbeitswege (kein Ausführungsauftrag):')
    for (const [tool, label] of [['mesh_delegate', 'Aufträge an geeignete Nodes delegieren'], ['mesh_exchange_send', 'Dateien zwischen freigegebenen eigenen Austauschordnern senden; Erfolg erst mit Empfangsbeleg'], ['mesh_screenshot', 'Node-Screenshot nur mit dort freigegebenem Capture-Agent und grafischer Sitzung']]) {
        if (registeredTools.has(tool)) lines.push(`${label} (${tool}); Ziel und Freigabe werden beim Aufruf geprüft.`)
    }
    const pathsEnd = lines.length
    lines.push('MCP-Verbindungen und veröffentlichte Werkzeuge:')
    const known = new Set<string>()
    for (const server of servers.slice(0, 12)) {
        const record = connections.find(c => c.id.slice(2) === server.name)
        if (record) known.add(record.id)
        const live = server.connected && (!record || record.status === 'verbunden')
        const tools = live ? server.tools.filter(tool => !record || connectorToolVerdict(tool, record).sichtbar).slice(0, 6) : []
        lines.push(`${safe(record?.title || server.name)}: ${live ? 'MCP-Transport verbunden' : 'nicht aktuell verbunden'}${record ? `; Zugang: ${safe(record.status)}` : '; Aufrufrechte separat prüfen'}.`)
        for (const tool of tools) {
            const verdict = record ? connectorToolVerdict(tool, record) : undefined
            const permission = !verdict ? 'Freigabe beim Aufruf prüfen' : verdict.verdict.decision === 'never' ? 'gesperrt' : verdict.verdict.decision === 'ask' ? 'Zustimmung pro Aufruf nötig' : verdict.verdict.decision === 'auto' ? 'laut Verbindungspolicy lesend; Ausführung separat prüfen' : 'gesonderte Freigabe/Übergabe erforderlich'
            lines.push(`  ${safe(tool.name, 80)}: ${safe(tool.description, 120) || 'keine Beschreibung'}; ${permission}.`)
        }
        if (live && !tools.length) lines.push('  Keine nach Verbindungspolicy sichtbaren Werkzeuge im Katalog.')
        if (live && server.tools.length > 6) lines.push('  Werkzeugübersicht gekürzt.')
    }
    for (const record of connections.filter(c => !known.has(c.id)).slice(0, 12)) {
        lines.push(`${safe(record.title)}: Zugang ${safe(record.status)}; kein aktueller MCP-Transport belegt${record.status.startsWith('wartet-') || record.status === 'abgelaufen' ? '; Anmeldung/Zugang über den bestehenden Verbindungsdialog erforderlich' : ''}.`)
    }
    if (!servers.length && !connections.length) lines.push('Keine MCP-Verbindung im aktuellen Bestand. Ein LAN-Fund ist noch keine MCP-Verbindung.')
    const bound = (part: string[], limit: number) => {
        const text = part.join('\n')
        return text.length > limit ? text.slice(0, limit) + '\n[Weitere Einträge gekürzt.]' : text
    }
    return redactSecrets([
        bound(lines.slice(0, nodeEnd), 1500), bound(lines.slice(nodeEnd, pathsEnd), 700), bound(lines.slice(pathsEnd), 3000),
        'Katalogeinträge sind Fähigkeitenbeschreibungen, kein Beleg einer erfolgreichen Aktion oder einer erkannten physischen Lampe. Geräte/Entitäten benötigen eine passende autorisierte Abfrage. Keine Verbindung oder Aktion wurde durch diese Übersicht ausgeführt.',
    ].join('\n\n'))
}
