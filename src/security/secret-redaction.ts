const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASS|PRIVATE_KEY)[A-Z0-9_]*=)([^\s"']+)/g
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi
const TELEGRAM_TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/g
const KNOWN_API_TOKEN = /\b(?:tvly-(?:dev|prod)-|sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}\b/g
const GENERIC_SECRET_ASSIGNMENT = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|private[_-]?key)\b\s*[=:]\s*)(["']?)([^\s,;"'}]+)\2/gi

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

/** Redacts credentials from command output before it reaches logs, memory or an LLM. */
export function redactSecrets(value: string): string {
    return value
        .replace(PEM_PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
        .replace(JSON_SECRET_VALUE, '$1"[REDACTED]"')
        .replace(ESCAPED_JSON_SECRET_VALUE, '$1\\"[REDACTED]\\"')
        .replace(ENV_SECRET, '$1[REDACTED]')
        .replace(BEARER, '$1[REDACTED]')
        .replace(TELEGRAM_TOKEN, '[REDACTED_TELEGRAM_TOKEN]')
        .replace(KNOWN_API_TOKEN, '[REDACTED_API_KEY]')
        .replace(GENERIC_SECRET_ASSIGNMENT, '$1[REDACTED]')
}
