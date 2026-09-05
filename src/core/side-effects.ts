/**
 * Shared guard for smoke tests and CI.
 *
 * Modules may still be imported, but they should not start network scans,
 * timers, SSH probes, Supabase calls, Telegram listeners, or hardware setup.
 */
export function sideEffectsDisabled(): boolean {
    return process.env.NOVA_NO_SIDE_EFFECTS === '1'
        || process.env.NOVA_TEST_MODE === '1'
        || process.env.VITEST === 'true'
        || process.env.NODE_ENV === 'test'
}

export default { sideEffectsDisabled }
