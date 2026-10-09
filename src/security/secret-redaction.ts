const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASS|PRIVATE_KEY)[A-Z0-9_]*=)([^\s"']+)/g
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi
const TELEGRAM_TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/g
// Proxmox API token: USER@REALM!TOKENID=<uuid> (with or without the PVEAPIToken= prefix)
const PVE_API_TOKEN = /(\b[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+=)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const KNOWN_API_TOKEN = /\b(?:tvly-(?:dev|prod)-|sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}\b/g
const GENERIC_SECRET_ASSIGNMENT = /(\b(?:api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|token|secret|password|passphrase|private[_\s-]?key)\b\s*[=:]\s*)(["']?)([^\s,;"'}]+)\2/gi

// `sshpass -p <password>` (also -p<password>) on command lines.
const SSHPASS_PASSWORD = /(\bsshpass\s+(?:-[A-Za-z]+\s+)*-p\s*)(["']?)([^\s"']+)\2/g
// Credentials in URL userinfo: scheme://user:password@host
const URL_USERINFO_PASSWORD = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@"'<>]+:)([^\s/@"'<>]+)(@)/g

// PEM private key blocks (RSA/EC/OPENSSH/PKCS#8/encrypted). A block without
// END marker (truncated output) is redacted to the end of the text.
const PEM_PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g

// JSON / JS-object key-value pairs whose key names a credential, e.g.
// "token": "…", "apiKey": "…", "Authorization": "Bearer …". Also matches the
// escaped form inside JSON strings (\"password\": \"…\"). Only string values
// are redacted, so numeric fields like "maxTokens": 1000 stay readable.
const SECRET_KEY_NAME = String.raw`[A-Za-z0-9_.-]*(?:token|password|passwd|passphrase|secret|api[_-]?key|authorization|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*`
const JSON_SECRET_VALUE = new RegExp(String.raw`("${SECRET_KEY_NAME}"\s*:\s*)"(?:[^"\\]|\\.)*"`, 'gi')
const ESCAPED_JSON_SECRET_VALUE = new RegExp(String.raw`(\\"${SECRET_KEY_NAME}\\"\s*:\s*)\\"(?:[^"\\]|\\[^"])*?\\"`, 'gi')

// ---------------------------------------------------------------------------
// 2.88: live values from the password vault (src/secrets/credential-broker.ts).
// A value the broker handed to a tool is redacted wherever redactSecrets runs
// (logs, thoughts, cards, memory, model context) — also without a key name.
// Only kept in memory, bounded, with an expiry.
// ---------------------------------------------------------------------------

const MIN_LIVE_SECRET = 6
const MAX_LIVE_SECRETS = 200
const liveSecrets = new Map<string, { label: string; until: number }>()

/** Remember a value handed out by the vault broker; `label` is the credential id (never the value). */
export function registerSecretValue(value: string, label: string, options: { ttlMs?: number; now?: number } = {}): void {
    const secret = String(value ?? '')
    if (secret.length < MIN_LIVE_SECRET) return
    const now = options.now ?? Date.now()
    liveSecrets.delete(secret)
    liveSecrets.set(secret, { label: String(label || 'zugang').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'zugang', until: now + (options.ttlMs ?? 6 * 60 * 60_000) })
    while (liveSecrets.size > MAX_LIVE_SECRETS) liveSecrets.delete(liveSecrets.keys().next().value as string)
}

/** Tests / vault locked: forget all live values. */
export function forgetSecretValues(): void { liveSecrets.clear() }

function redactLive(value: string, now: number): string {
    if (!liveSecrets.size) return value
    let out = value
    for (const [secret, entry] of liveSecrets) {
        if (entry.until < now) { liveSecrets.delete(secret); continue }
        if (out.includes(secret)) out = out.split(secret).join(`[TRESOR:${entry.label}]`)
        const escaped = JSON.stringify(secret).slice(1, -1)
        if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join(`[TRESOR:${entry.label}]`)
    }
    return out
}

/** Redacts credentials from command output before it reaches logs, memory or an LLM. */
export function redactSecrets(value: string, options: { now?: number } = {}): string {
    return redactLive(value, options.now ?? Date.now())
        .replace(PEM_PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
        .replace(SSHPASS_PASSWORD, '$1$2[REDACTED]$2')
        .replace(URL_USERINFO_PASSWORD, '$1[REDACTED]$3')
        .replace(JSON_SECRET_VALUE, '$1"[REDACTED]"')
        .replace(ESCAPED_JSON_SECRET_VALUE, '$1\\"[REDACTED]\\"')
        .replace(ENV_SECRET, '$1[REDACTED]')
        .replace(BEARER, '$1[REDACTED]')
        .replace(TELEGRAM_TOKEN, '[REDACTED_TELEGRAM_TOKEN]')
        .replace(PVE_API_TOKEN, '$1[REDACTED]')
        .replace(KNOWN_API_TOKEN, '[REDACTED_API_KEY]')
        .replace(GENERIC_SECRET_ASSIGNMENT, '$1[REDACTED]')
}
