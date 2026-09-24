/** A supplied catalog may narrow a task contract, never widen it.
 * An empty allowlist means no tools, not unrestricted execution. */
export function selectContractTools<T extends { name: string }>(
    allowedNames: readonly string[],
    available: readonly T[],
    deniedNames: readonly string[] = [],
): T[] {
    const allowed = new Set(allowedNames)
    const denied = new Set(deniedNames)
    const seen = new Set<string>()
    return available.filter(tool => {
        if (!allowed.has(tool.name) || denied.has(tool.name) || seen.has(tool.name)) return false
        seen.add(tool.name)
        return true
    })
}
