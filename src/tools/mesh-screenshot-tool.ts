import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getRuntimeRoot } from '../core/data-root.js'
import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { getUserPermission } from '../users/multi-user-middleware.js'
import type { NovaTool } from './complete-registry.js'

export const meshScreenshotTool: NovaTool = {
    name: 'mesh_screenshot', category: 'mesh',
    description: 'Echte Bildschirmaufnahme eines aktuellen Mesh-Nodes oder aller Nodes (node_id=all). Nur lokal freigegebene grafische Capture-Agenten; Headless/gesperrte Nodes liefern einen konkreten Fehler. Bilder werden nur dem authentifizierten Auftraggeber gesendet, keine SSH-Ersatzaufnahme.',
    parameters: [
        { name: 'node_id', type: 'string', required: true, description: 'Aktuelle Node-ID oder all' },
        { name: 'send', type: 'boolean', required: false, description: 'An den authentifizierten Telegram-Auftraggeber senden (default true); false: nur private lokale Aufnahme' },
    ],
    handler: async params => {
        const context = getExecutionPolicyContext()
        if (!context.authUserId || !context.runId || getUserPermission(context.authUserId, context.channel) !== 'owner') {
            return { success: false, captured: false, delivered: false, error: 'Node screenshots require an authenticated owner run' }
        }
        const send = params.send !== false
        if (send && (context.channel?.toLowerCase() !== 'telegram' || !/^[1-9][0-9]*$/.test(context.authUserId))) {
            return { success: false, captured: false, delivered: false, error: 'No authenticated Telegram image recipient; use send=false for local capture' }
        }
        const { currentCaptureNodes, requestNodeCapture } = await import('../mesh/mesh-transport-runtime.js')
        const known = currentCaptureNodes()
        const target = String(params.node_id || '')
        const nodes = target === 'all' ? known : known.includes(target) ? [target] : []
        if (!nodes.length) return { success: false, captured: false, delivered: false, error: 'No fresh known capture target' }
        const captures: Array<Record<string, unknown>> = []
        for (const nodeId of nodes) {
            let row: Record<string, unknown> = { nodeId, captured: false, delivered: false }
            try {
                const receipt = await requestNodeCapture(nodeId, { operation: 'capture', principalId: context.authUserId, runId: context.runId })
                row = { nodeId, captured: true, delivered: false, capturedAt: receipt.capturedAt, sha256: receipt.sha256, bytes: receipt.bytes }
                const parent = join(getRuntimeRoot(), '.nova-vision')
                mkdirSync(parent, { recursive: true, mode: 0o700 })
                if (lstatSync(parent).isSymbolicLink()) throw new Error('Capture directory must not be a link')
                const dir = join(parent, 'mesh-captures')
                mkdirSync(dir, { recursive: true, mode: 0o700 })
                if (lstatSync(dir).isSymbolicLink()) throw new Error('Capture directory must not be a link')
                const files = readdirSync(dir)
                let storedBytes = 0
                for (const file of files) {
                    const stat = lstatSync(join(dir, file))
                    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected capture storage entry')
                    storedBytes += stat.size
                }
                if (files.length >= 256 || storedBytes + receipt.bytes > 256 * 1024 * 1024) throw new Error('Private capture quota reached; no files overwritten or removed')
                const path = join(dir, `node_${Date.now()}_${randomBytes(12).toString('hex')}.png`)
                writeFileSync(path, Buffer.from(receipt.base64, 'base64'), { mode: 0o600, flag: 'wx' })
                row = { nodeId, captured: true, delivered: false, capturedAt: receipt.capturedAt, sha256: receipt.sha256, bytes: receipt.bytes, path }
                if (send) {
                    const { executeSendFile } = await import('./send-file-tool.js')
                    const result = await executeSendFile({ path, caption: `Mesh-Screenshot: ${nodeId}`, chat_id: context.authUserId })
                    row.delivered = /^✅ (?:Foto|Dokument) gesendet:/.test(result)
                    if (!row.delivered) row.error = 'Capture succeeded, but image delivery was not verified'
                }
            } catch (error) { row.error = String(error).slice(0, 400) }
            captures.push(row)
        }
        // Pixels stay out of model text, shared queues, audit results and caches.
        // A partial result must never claim all requested pictures were delivered.
        return { success: captures.every(r => r.captured === true && (!send || r.delivered === true)),
            captured: captures.some(r => r.captured === true), delivered: send && captures.every(r => r.delivered === true), captures }
    },
}
