const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASS|PRIVATE_KEY)[A-Z0-9_]*=)([^\s"']+)/g
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi
const TELEGRAM_TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/g
const KNOWN_API_TOKEN = /\b(?:tvly-(?:dev|prod)-|sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}\b/g
const GENERIC_SECRET_ASSIGNMENT = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|private[_-]?key)\b\s*[=:]\s*)(["']?)([^\s,;"'}]+)\2/gi

/** Redacts credentials from command output before it reaches logs, memory or an LLM. */
export function redactSecrets(value: string): string {
    return value
        .replace(ENV_SECRET, '$1[REDACTED]')
        .replace(BEARER, '$1[REDACTED]')
        .replace(TELEGRAM_TOKEN, '[REDACTED_TELEGRAM_TOKEN]')
        .replace(KNOWN_API_TOKEN, '[REDACTED_API_KEY]')
        .replace(GENERIC_SECRET_ASSIGNMENT, '$1[REDACTED]')
}
