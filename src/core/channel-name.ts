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
