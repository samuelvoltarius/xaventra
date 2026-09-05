import { getServiceFencingToken, MAIN_SERVICE } from '../mesh/leader-election.js'

/**
 * Global autonomy is a Main control-plane responsibility. Workers keep their
 * execution/data planes warm, but must not generate goals, consolidate shared
 * memory, or inject self-authored messages without the current fencing token.
 */
export function shouldRunGlobalAutonomy(
    hasMainFence: boolean,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (String(env.NOVA_AUTONOMY_REQUIRE_MAIN_LEASE || 'true').toLowerCase() === 'false') return true
    return hasMainFence
}

export function hasGlobalAutonomyAuthority(env: NodeJS.ProcessEnv = process.env): boolean {
    return shouldRunGlobalAutonomy(Boolean(getServiceFencingToken(MAIN_SERVICE)), env)
}
