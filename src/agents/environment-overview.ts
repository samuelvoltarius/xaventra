import { isEnvironmentOverview, inventoryRequestText } from '../core/request-capabilities.js'

/** A bounded read-only plan, narrowed by the frozen tool contract. The normal
 * executor still owns authorization, Main fences, verification and receipts. */
export function environmentOverviewPlan(input: {
    content: string; permission: string; internal: boolean; hasImage: boolean
    constrained: boolean; tools: readonly { name: string }[]
}): Array<{ name: string; arguments: Record<string, unknown> }> | null {
    const fresh = isFreshEnvironmentRequest(input.content)
    if (input.permission !== 'owner' || input.internal || input.hasImage || input.constrained || (!fresh && !isEnvironmentOverview(input.content))) return null
    const names = fresh ? ['scan_now', 'environment_inventory', 'mesh_status'] : ['environment_inventory', 'mesh_status']
    if (!names.every(name => input.tools.some(tool => tool.name === name))) return null
    return names.map(name => ({ name, arguments: name === 'scan_now' ? { was: 'geraete' } : {} }))
}

/** Only an explicit fresh, read-only discovery request gets an active scan. */
export function isFreshEnvironmentRequest(content: string): boolean {
    const text = content.trim()
    if (!isEnvironmentOverview(content) || !/^(?:bitte\s+)?(?:prüfe|pruefe|ermittle|suche|scanne)\b/i.test(text)
        || !/\b(?:netzwerk|lan|mesh)\b/i.test(text)
        || !/\b(?:erneut|jetzt|frisch|neu|scan\w*)\b/i.test(text)) return false
    // Explicit prohibitions do not turn a read-only test into an effect request.
    const effects = inventoryRequestText(text)
    return !/\b(?:kopier\w*|lösch\w*|loesch\w*|installier\w*|schalt\w*|koppel\w*|deploy\w*|update\w*|übertrag\w*)\b/i.test(effects)
}
