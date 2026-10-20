/**
 * 2.89.8 (U6): ONE canonical owner principal for every owner-authenticated channel.
 *
 * Telegram uses the numeric Telegram id as principal, Desktop/HUD/App historically a
 * Desktop alias ("desktop-owner"). Memory is scoped per principal, so the owner had a
 * different memory per channel. The canonical principal is, in this order:
 *   1. config.ownerPrincipal (explicit),
 *   2. NOVA_DESKTOP_TELEGRAM_OWNER_ID (numeric, explicit),
 *   3. the ONE numeric Telegram owner in channels.telegram.allowFrom.
 * Several Telegram owners without 1./2. are ambiguous: nothing is merged.
 * Authentication is unchanged (users/owner-accounts.ts only links accounts that
 * authenticated as owner themselves); this file only names the target principal.
 */
export interface OwnerIdentityConfig {
    ownerPrincipal?: string
    userPrincipals?: Record<string, string>
    channels?: { telegram?: { allowFrom?: unknown[] } }
}

export interface CanonicalOwner {
    principal: string | null
    ambiguous: boolean
}

const clean = (value: unknown) => String(value ?? '').trim()

/** The Desktop-side owner id (rooms, tokens). Legacy alias of the canonical principal. */
export function desktopOwnerAlias(): string {
    return clean(process.env.NOVA_DESKTOP_OWNER_ID || 'desktop-owner').slice(0, 200)
}

/** Every old name the owner's data may sit under besides the canonical principal. */
export function legacyOwnerAliases(): string[] {
    return [...new Set(['desktop-owner', desktopOwnerAlias(), 'even-g2:owner'])]
}

export function resolveCanonicalOwner(config: OwnerIdentityConfig | null | undefined, env: NodeJS.ProcessEnv = process.env): CanonicalOwner {
    const explicit = clean(config?.ownerPrincipal)
    if (explicit) return { principal: explicit, ambiguous: false }
    const mappings = config?.userPrincipals || {}
    const mapTelegram = (id: string) => clean(mappings[`telegram:${id}`] || mappings[id] || id)
    const envOwner = clean(env.NOVA_DESKTOP_TELEGRAM_OWNER_ID)
    if (/^[1-9]\d{0,19}$/.test(envOwner)) return { principal: mapTelegram(envOwner), ambiguous: false }
    const allowFrom = Array.isArray(config?.channels?.telegram?.allowFrom) ? config!.channels!.telegram!.allowFrom! : []
    const owners = [...new Set(allowFrom.map(item => clean(item).replace(/^telegram:/i, '')).filter(item => /^\d{1,20}$/.test(item)))]
    if (owners.length === 1) return { principal: mapTelegram(owners[0]), ambiguous: false }
    return { principal: null, ambiguous: owners.length > 1 }
}
