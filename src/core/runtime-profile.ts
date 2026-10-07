/**
 * 2.89: ONE source for the operating profile of this process.
 *
 * Before 2.89 every DAU-friendly limit and prompt rule hung on NOVA_OS_MODE,
 * which is not set on the live Main: 3 tool rounds, 30 s per tool, 4 calls,
 * 1024 output tokens and no „BEDIENMODUS: STANDARD“ block. Now:
 * - `owner-assistant` (default on a Main): good limits plus the plain-language
 *   prompt block for the owner.
 * - `novaos` (NOVA_OS_MODE=true): the larger NovaOS limits and its own blocks;
 *   it is the upper bound of every default.
 * - `worker` (NOVA_NODE_ONLY=true): a mesh node without channels; same limits
 *   as the owner assistant, no owner prompt block.
 */

export type RuntimeProfile = 'owner-assistant' | 'novaos' | 'worker'

export function runtimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
    if (env.NOVA_OS_MODE === 'true') return 'novaos'
    if (env.NOVA_NODE_ONLY === 'true') return 'worker'
    return 'owner-assistant'
}
