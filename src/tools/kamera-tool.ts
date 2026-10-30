import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { getUserPermission } from '../users/multi-user-middleware.js'
import type { NovaTool } from './complete-registry.js'

/** Kamera anbinden: one still of a connected camera, on request, read only. The model sees the private
 * path for analyze_image, never a login; no stream, no sound, no second try. */
export const kameraStandbildTool: NovaTool = {
    name: 'kamera_standbild', category: 'media',
    description: 'Holt EIN Standbild einer angebundenen Kamera (nur lesend, nur auf Anfrage, ohne Ton, kein Video). Zum Auswerten danach analyze_image auf path. Fehlt der Zugang, sag das ehrlich: Benutzer und Passwort gibt nur der Besitzer in der App ein, nie im Chat; rate nichts.',
    parameters: [{ name: 'kamera', type: 'string', required: true, description: 'Geräte-ID (dev-…) oder ein Teil des Kameranamens' }],
    handler: async params => {
        const context = getExecutionPolicyContext()
        if (!context.authUserId || !context.runId || getUserPermission(context.authUserId, context.channel) !== 'owner') {
            return { success: false, error: 'Kamerabilder nur für den angemeldeten Besitzer.' }
        }
        const { sensingDataDir } = await import('../sensing/runtime.js')
        const { loadDevices } = await import('../sensing/device-registry.js')
        const { cameraStandbild } = await import('../sensing/camera-access.js')
        const { requestNodeKamera } = await import('../mesh/mesh-transport-runtime.js')
        const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
        const root = sensingDataDir()
        const wanted = String(params.kamera || '').trim().toLowerCase()
        const cameras = loadDevices(root).filter(device => device.type === 'camera')
        const hits = cameras.filter(device => device.id === wanted || (wanted && device.name.toLowerCase().includes(wanted)))
        if (hits.length !== 1) return { success: false, error: hits.length ? 'Mehrere Kameras passen; bitte genauer sagen.' : 'Diese Kamera kenne ich nicht.' }
        const result = await cameraStandbild(root, hits[0].id, { requestNodeKamera, principalId: context.authUserId, runId: context.runId, localNode: getLocalNodeId() })
        return result.ok ? { success: true, path: result.path, capturedAt: result.capturedAt, message: `${result.message} Auswerten mit analyze_image auf path.` } : { success: false, error: result.message }
    },
}
