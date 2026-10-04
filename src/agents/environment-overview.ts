import { isEnvironmentOverview } from '../core/request-capabilities.js'

/** A bounded read-only plan, narrowed by the frozen tool contract. The normal
 * executor still owns authorization, Main fences, verification and receipts. */
export function environmentOverviewPlan(input: {
    content: string; permission: string; internal: boolean; hasImage: boolean
    constrained: boolean; tools: readonly { name: string }[]
}): Array<{ name: string; arguments: Record<string, unknown> }> | null {
    if (input.permission !== 'owner' || input.internal || input.hasImage || input.constrained || !isEnvironmentOverview(input.content)) return null
    const names = ['environment_inventory', 'mesh_status']
    if (!names.every(name => input.tools.some(tool => tool.name === name))) return null
    return names.map(name => ({ name, arguments: {} }))
}
