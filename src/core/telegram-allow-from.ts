/**
 * TELEGRAM_ALLOW_FROM parsing (R2 NZ-9).
 *
 * An empty entry ('' from "12345," or an empty variable) would match every
 * sender without @username in the Telegram adapter. Entries are trimmed, empty
 * ones dropped, and an env value without any usable entry does not replace the
 * allowlist from the config.
 */
export function resolveTelegramAllowFrom(envValue: string | undefined, configAllowFrom: unknown): string[] {
    const fromEnv = String(envValue ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
    if (fromEnv.length > 0) return fromEnv
    return Array.isArray(configAllowFrom)
        ? configAllowFrom.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : []
}
