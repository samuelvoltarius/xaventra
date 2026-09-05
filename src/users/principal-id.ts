export interface PrincipalConfig {
    userPrincipals?: Record<string, string>
}

export interface PrincipalContext {
    channel: string
    rawUserId: string
    principalId: string
    permission?: 'owner' | 'admin' | 'user' | 'guest' | 'blocked'
}

function clean(value: unknown): string {
    return String(value || '').trim()
}

/**
 * Resolve an immutable memory/security identity. Display aliases are
 * deliberately ignored: changing a person's name must never move their data.
 * Cross-channel identities can be linked explicitly through userPrincipals:
 * { "telegram:123": "sample", "discord:456": "sample" }.
 */
export function resolvePrincipalId(config: PrincipalConfig | null | undefined, channel: string, rawUserId: string): string {
    const raw = clean(rawUserId)
    const normalizedChannel = clean(channel).toLowerCase() || 'unknown'
    const mappings = config?.userPrincipals || {}
    return clean(mappings[`${normalizedChannel}:${raw}`] || mappings[raw] || raw)
}

export function principalScope(principalId: string): string {
    return `user:${clean(principalId)}`
}

/** Includes old alias/raw scopes only for read/migration compatibility. */
export function compatiblePrincipalScopes(context: PrincipalContext, legacyAlias?: string): string[] {
    return [...new Set([
        principalScope(context.principalId),
        principalScope(context.rawUserId),
        legacyAlias ? principalScope(legacyAlias) : '',
    ].filter(Boolean))]
}
