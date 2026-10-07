/**
 * 2.89: one way to compare channel names. The pipeline gets the adapter's
 * spelling ('Telegram', 'WhatsApp', 'Discord'); comparisons against lower-case
 * literals silently failed (e.g. /aktivitaet and /desktop buttons never came).
 */
export function channelKey(channel: unknown): string {
    return String(channel ?? '').trim().toLowerCase()
}

export function isChannel(channel: unknown, name: string): boolean {
    return channelKey(channel) === channelKey(name)
}

/**
 * 2.89: technical probes (rollout smoke tests over REST, header
 * `X-Xaventra-Probe: 1`) have their own identity. They are never the owner and
 * never write to the session log, the cross-channel handoff or the memory —
 * before, every rollout probe landed in the owner's one context.
 */
export const TECHNICAL_PROBE_PRINCIPAL = 'rest-api:probe'

export function isTechnicalProbe(channel: unknown, from: unknown): boolean {
    return isChannel(channel, 'rest-api') && String(from ?? '') === TECHNICAL_PROBE_PRINCIPAL
}
