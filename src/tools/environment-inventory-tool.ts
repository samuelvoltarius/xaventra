import type { NovaTool } from './complete-registry.js'
import { getNovaDataDir } from '../core/data-root.js'
import { environmentAwareness } from '../sensing/awareness.js'

export const environmentInventoryTool: NovaTool = {
    name: 'environment_inventory', category: 'system', parameters: [],
    description: 'Liest die bereits automatisch erkannten LAN-/Tailnet-Geräte mit Fundzeit, Status und Grenzen der letzten Suche. Startet keinen neuen Scan; trennt Gerätefunde von bestätigter Steuerbarkeit.',
    handler: async () => {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        const context = getExecutionPolicyContext()
        if (!context.authUserId || getUserPermission(context.authUserId, context.channel) !== 'owner') throw new Error('environment inventory requires the authenticated owner')
        return { formatted: environmentAwareness(getNovaDataDir(), 'owner', Date.now(), false) }
    },
}
