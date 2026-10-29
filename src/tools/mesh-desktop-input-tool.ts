import { createHash } from 'node:crypto'
import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { getUserPermission } from '../users/multi-user-middleware.js'
import { desktopActionArgs } from '../host/desktop-input.js'
import { captureReason } from '../mesh/capture-reason.js'
import type { NovaTool } from './complete-registry.js'
import { storePrivateNodeCapture } from './mesh-screenshot-tool.js'
import { featureEnabled } from '../core/context-switches.js'

/** Computer use on an enrolled node (e.g. the lab workstation): one typed action,
 * then a fresh capture from the same node. Success names the executed input, never
 * the intended UI outcome — that is judged only from the new capture. */
export const meshDesktopInputTool: NovaTool = {
    name: 'mesh_desktop_input', category: 'mesh',
    description: 'Bediene den freigegebenen Arbeitsplatz eines Mesh-Nodes (z. B. eigener Labor-Computer): eine Aktion move/click/type/key/scroll oder open_url (öffentliche Webseite im Browser des Arbeitsplatzes, nur erlaubte Hosts). Danach liefert der Node eine frische Aufnahme; ob die Aktion gewirkt hat, prüfst du nur mit analyze_image auf capture.path. Erst mesh_screenshot zur Orientierung. Bei unsicherem Ergebnis nicht blind wiederholen.',
    parameters: [
        { name: 'node_id', type: 'string', required: true, description: 'Aktuelle Node-ID mit freigegebenem Arbeitsplatz (nicht all)' },
        { name: 'action', type: 'string', required: true, description: 'JSON: {"action":"open_url","url":"https://example.com"}, {"action":"click","x":100,"y":100,"button":"left"}, {"action":"move","x":1,"y":1}, {"action":"type","text":"Hallo"}, {"action":"key","key":"Return"}, {"action":"scroll","direction":"down","amount":3}' },
        { name: 'step', type: 'string', required: true, description: 'Eindeutige Schrittkennung in diesem Auftrag; bei Wiederholung desselben Schritts unverändert lassen.' },
    ],
    handler: async params => {
        const context = getExecutionPolicyContext()
        try {
            // 2.90.0: on by default on Main, NOVA_MESH_DESKTOP_INPUT_ENABLED=false / mesh.desktopInput=false turns it off.
            // The node keeps its own explicit opt-in (NOVA_DESKTOP_INPUT_ENABLED + input enrollment).
            if (!featureEnabled('meshDesktopInput')) throw new Error('Mesh desktop input is switched off on this Main')
            if (!context.authUserId || !context.runId || getUserPermission(context.authUserId, context.channel) !== 'owner') throw new Error('Node desktop input requires an authenticated owner run')
            const node = String(params.node_id || '')
            const { currentCaptureNodes, requestNodeInput } = await import('../mesh/mesh-transport-runtime.js')
            if (!node || node === 'all' || !currentCaptureNodes().includes(node)) throw new Error('No fresh known desktop node')
            if (typeof params.step !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(params.step)) throw new Error('Invalid step')
            let action: Record<string, unknown>
            try { action = JSON.parse(String(params.action)) } catch { throw new Error('Invalid action JSON') }
            desktopActionArgs(action)
            // Same run + owner + node + step = same node journal key: a retry is replayed, never repeated.
            const h = createHash('sha256').update(JSON.stringify(['mesh_desktop_input/v1', context.runId, context.authUserId, node, params.step])).digest('hex')
            const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
            const receipt = await requestNodeInput(node, { operation: 'input', principalId: context.authUserId, runId: context.runId, requestId, action })
            const path = storePrivateNodeCapture(receipt.capture)
            const replayed = receipt.input.replayed
            // Pixels stay out of model text; the path is for analyze_image.
            return { success: true, status: replayed ? 'replayed' : 'executed', executedNow: !replayed, nodeId: node,
                capture: { path, sha256: receipt.capture.sha256, capturedAt: receipt.capture.capturedAt },
                message: (replayed ? 'Früherer identischer Schritt, jetzt keine neue Eingabe. ' : 'Eingabe ausgeführt. ')
                    + 'Wirkung nur mit analyze_image auf capture.path prüfen, nicht behaupten.' }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            // The workstation refused before anything ran (e.g. host not on its allowlist): certain, not uncertain.
            const refused = /Desktop action refused: (.+)$/s.exec(message)
            if (refused) {
                const reason = refused[1].trim().slice(0, 300)
                return { success: false, refused: true, status: 'refused', executedNow: false, error: reason,
                    message: `Am Arbeitsplatz abgelehnt, nichts ausgeführt — so nicht wiederholen: ${reason}` }
            }
            return { success: false, executedNow: false, error: message.slice(0, 400), reason: captureReason(message) }
        }
    },
}
