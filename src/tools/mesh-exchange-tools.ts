import { createHash } from 'node:crypto'
import type { NovaTool } from './complete-registry.js'
import { EXCHANGE_MAX_BYTES } from '../mesh/node-exchange.js'

async function requireOwner(): Promise<void> {
    const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
    const { getUserPermission } = await import('../users/multi-user-middleware.js')
    const context = getExecutionPolicyContext()
    if (!context.authUserId || getUserPermission(context.authUserId, context.channel) !== 'owner') throw new Error('node exchange requires the authenticated owner context')
}

export const meshExchangeTools: NovaTool[] = [
    {
        name: 'mesh_exchange_list', category: 'mesh',
        description: 'Listet Dateien im eigenen Austauschordner eines Nodes. Keine anderen Verzeichnisse oder Laufzeitdaten.',
        parameters: [{ name: 'node_id', type: 'string', required: true, description: 'Aktuelle Mesh-Node-ID' }],
        handler: async params => {
            await requireOwner()
            const { requestNodeExchange } = await import('../mesh/mesh-transport-runtime.js')
            return requestNodeExchange(String(params.node_id || ''), { operation: 'list' })
        },
    },
    {
        name: 'mesh_exchange_write', category: 'mesh',
        description: 'Legt einen erzeugten Text/JSON-Bericht im eigenen Austauschordner eines Nodes ab (max. 256 KiB). Überschreibt keine andere Datei. Keine Secrets oder Laufzeitdaten ablegen.',
        parameters: [
            { name: 'node_id', type: 'string', required: true, description: 'Aktuelle Mesh-Node-ID' },
            { name: 'name', type: 'string', required: true, description: 'Einfacher Dateiname, z.B. bericht.md, keine Pfade' },
            { name: 'content', type: 'string', required: true, description: 'Erzeugter Dateiinhalt' },
        ],
        handler: async params => {
            await requireOwner()
            const content = String(params.content ?? '')
            const { redactSecrets } = await import('../security/secret-redaction.js')
            if (redactSecrets(content) !== content) throw new Error('secrets must not enter node exchange')
            const bytes = Buffer.from(content, 'utf8')
            if (bytes.length > EXCHANGE_MAX_BYTES) throw new Error('exchange file too large')
            const { requestNodeExchange } = await import('../mesh/mesh-transport-runtime.js')
            return requestNodeExchange(String(params.node_id || ''), { operation: 'write', name: String(params.name || ''), base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
        },
    },
    {
        name: 'mesh_exchange_send', category: 'mesh',
        description: 'Kopiert eine vorhandene Datei zwischen den eigenen Austauschordnern zweier Nodes. Meldet Erfolg erst nach bestätigter Größen- und SHA-256-Prüfung am Ziel. Keine allgemeinen Dateipfade.',
        parameters: [
            { name: 'source_node', type: 'string', required: true, description: 'Aktuelle Quell-Node-ID' },
            { name: 'target_node', type: 'string', required: true, description: 'Aktuelle Ziel-Node-ID' },
            { name: 'name', type: 'string', required: true, description: 'Dateiname im Austauschordner' },
        ],
        handler: async params => {
            await requireOwner()
            const { transferNodeExchange } = await import('../mesh/mesh-transport-runtime.js')
            return transferNodeExchange(String(params.source_node || ''), String(params.target_node || ''), String(params.name || ''))
        },
    },
]
