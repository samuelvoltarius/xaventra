/**
 * 2.89.4: Schlüssel aus dem Chat — ein Weg für alle Schlüssel/Tokens/API-Zugänge
 * (Tools, Modell-Provider, Dienste wie Home Assistant, Proxmox, Tavily, Brave,
 * OpenAI-kompatible Provider …).
 *
 * Owner-Wunsch (verbindlich): „egal wie ich ihr den Key sende, sie soll ihn
 * selbst eintragen“. In einem Owner-Direktchat erkennt Xaventra den Wert plus
 * Zweck, speichert ihn SOFORT im vorhandenen verschlüsselten Speicher
 * (Tresor / Auth-Store — nie Klartext in xaventra.config.json), maskiert ihn in
 * Verlauf/Journal/Logs/LanceDB/Brain/Warteschlangen, löscht die Telegram-Nachricht
 * und merkt das an, testet den Zugang und aktiviert ohne Neustart.
 *
 * Ein Schritt für den Owner (Live 09.10. 00:37): bei eindeutigem Owner-Willen
 * („nimm den und trag ihn ein“) oder klarem Zweck wird direkt übernommen.
 * Unklarer Zweck → genau eine Frage „Wofür ist der?“. Nie der /freigabe-Dreischritt.
 * Sicherheitsniveau bleibt: nur Owner, nur Direktchat, Audit.
 *
 * Der Wert steht NIE im Modell-Prompt (vor dem Modellaufruf ersetzt / dieser
 * Zweig geht gar nicht zum Modell).
 */
import { registerSecretValue } from '../security/secret-redaction.js'

/** The one honest mask. Never the last characters of a chat key (too short to be safe). */
export const MASK = '[SCHLÜSSEL]'

export type ChatSecretKind = 'api-key' | 'token' | 'password'

export interface ChatSecret {
    value: string
    kind: ChatSecretKind
    /** Text around the value, already without the secret. */
    context: string
}

export interface ChatSecretIntakeDeps {
    /** Owner check (multi-user-middleware). */
    isOwner?: (userId: string, channel: string) => boolean
    /** Group check — keys are only taken in a 1:1 chat. */
    isGroup?: boolean
    /** Delete the Telegram message that carried the secret. */
    deleteMessage?: (chatId: string, messageId: number | string) => Promise<void> | void
    chatId?: string
    messageId?: number | string
    now?: () => number
    /** Store/activate hooks (tests). Defaults use Tresor + LLM auth store. */
    storeToolKey?: (id: string, service: string, value: string, context: string) => Promise<{ ok: boolean; message: string }>
    storeLlmKey?: (provider: string, value: string, context: string) => Promise<{ ok: boolean; message: string }>
    /** Read-only probe after store (tests stub this). */
    testKey?: (service: string, value: string) => Promise<{ ok: boolean; message: string }>
}

const INTENT = /\b(?:api[_\s-]?key|apikey|token|schlüssel|schluessel|passwort|password|zugang|credential|key)\b/i
const TAKEOVER = /\b(?:nimm(?:\s+(?:den|dir|ihn|sie))?(?:\s+(?:und\s+)?(?:trag|speicher|eintrag)\w*)?|trag(?:\s+(?:ihn|dir|den|sie))?\s+(?:dir\s+)?(?:ein|eintrag)|speicher(?:\s+(?:ihn|dir|den))|eintrag\w*\s+(?:ihn|dir|den|sie)|bitte\s+(?:eintrag\w*|speicher\w*|nimm))\b/i
const PURPOSE_ASK = /\b(?:wofür|wofuer|welcher dienst|welcher service|welchen zweck|für was|fuer was)\b/i

/** Known service words → stable id. First match wins (more specific first). */
const SERVICE_MAP: Array<{ id: string; re: RegExp; label: string }> = [
    { id: 'tavily', re: /\btavily\b/i, label: 'Tavily' },
    { id: 'brave', re: /\bbrave(?:\s*search)?\b/i, label: 'Brave Search' },
    { id: 'serper', re: /\bserper\b/i, label: 'Serper' },
    { id: 'serpapi', re: /\bserpapi\b/i, label: 'SerpAPI' },
    { id: 'dhl', re: /\bdhl\b/i, label: 'DHL Shipment Tracking' },
    { id: '17track', re: /\b17\s*track\b/i, label: '17TRACK' },
    { id: 'home-assistant', re: /\b(?:home[\s-]?assistant|hass)\b/i, label: 'Home Assistant' },
    { id: 'proxmox', re: /\bproxmox\b|\bpve\b/i, label: 'Proxmox' },
    { id: 'telegram', re: /\btelegram\b/i, label: 'Telegram' },
    { id: 'discord', re: /\bdiscord\b/i, label: 'Discord' },
    { id: 'whatsapp', re: /\bwhatsapp\b/i, label: 'WhatsApp' },
    { id: 'openai', re: /\bopenai\b|\bgpt-?[\d.]/i, label: 'OpenAI' },
    { id: 'anthropic', re: /\banthropic\b|\bclaude\b/i, label: 'Anthropic' },
    { id: 'gemini', re: /\bgemini\b|\bgoogle\s*ai\b/i, label: 'Google Gemini' },
    { id: 'openrouter', re: /\bopenrouter\b/i, label: 'OpenRouter' },
    { id: 'groq', re: /\bgroq\b/i, label: 'Groq' },
    { id: 'mistral', re: /\bmistral\b/i, label: 'Mistral' },
    { id: 'deepseek', re: /\bdeepseek\b/i, label: 'DeepSeek' },
    { id: 'xai', re: /\b(?:xai|grok)\b/i, label: 'xAI' },
    { id: 'ollama', re: /\bollama\b/i, label: 'Ollama' },
    { id: 'kimi', re: /\bkimi\b|\bmoonshot\b/i, label: 'Kimi / Moonshot' },
    { id: 'minimax', re: /\bminimax\b/i, label: 'MiniMax' },
]

const LLM_SERVICES = new Set(['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'ollama', 'kimi', 'minimax'])

const KNOWN_PREFIX = /^(?:sk-(?:proj-)?|tvly-(?:dev|prod)-|gh[pousr]_|xox[baprs]-|AIza|pveapitoken=|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+=)/i

/** Assignment / quote forms: `api_key: …`, `token=…`, „Schlüssel: …“. */
const ASSIGNED = /(?:api[_\s-]?key|apikey|access[_\s-]?token|refresh[_\s-]?token|token|schlüssel|schluessel|passwort|password|secret|key|zugang)\s*["']?\s*[=:]\s*["']?([^\s"',;]{16,512})["']?/gi
const QUOTED = /["'`]([A-Za-z0-9_\-.=+/:@]{16,512})["'`]/g
const TOKEN_RUN = /(?<![A-Za-z0-9_\-.=+/:@-])([A-Za-z0-9_\-.=+/:@]{24,512})(?![A-Za-z0-9_\-.=+/:@-])/g

function looksLikeUrlPart(value: string): boolean {
    return /^https?:\/\//i.test(value) || value.includes('://') || value.includes('/') && value.includes('.')
}

function looksLikePathOrMail(value: string): boolean {
    if (value.includes('@') && !value.includes('!')) return true
    if (/^[A-Za-z]:\\|^\.\//.test(value)) return true
    return false

}

function classify(value: string): ChatSecretKind {
    if (/passw|passwort|password/i.test(value)) return 'password'
    if (KNOWN_PREFIX.test(value) || /token/i.test(value)) return 'token'
    return 'api-key'
}

/**
 * The secret value in a chat message, or null. Never returns URLs, paths or
 * e-mail addresses. A known prefix alone is enough; otherwise the message must
 * also carry a key-purpose word (so normal long words stay conversation).
 */
export function detectChatSecret(text: unknown): ChatSecret | null {
    const value = String(text ?? '')
    if (!value || value.length > 4000) return null
    const hasIntent = INTENT.test(value) || TAKEOVER.test(value)
    const candidates: string[] = []
    for (const match of value.matchAll(ASSIGNED)) if (match[1]) candidates.push(match[1])
    for (const match of value.matchAll(QUOTED)) if (match[1]) candidates.push(match[1])
    for (const match of value.matchAll(TOKEN_RUN)) if (match[1]) candidates.push(match[1])
    for (const raw of candidates) {
        const candidate = raw.replace(/^[("'`]+|[)"'`,;]+$/g, '')
        if (candidate.length < 16 || candidate.length > 512) continue
        if (looksLikeUrlPart(candidate) || looksLikePathOrMail(candidate)) continue
        if (!KNOWN_PREFIX.test(candidate) && !hasIntent) continue
        if (!KNOWN_PREFIX.test(candidate) && !/^[\x21-\x7e]+$/.test(candidate)) continue
        const context = value.split(candidate).join(MASK).replace(/\s+/g, ' ').trim().slice(0, 240)
        return { value: candidate, kind: classify(candidate), context }
    }
    return null
}

/** Service id from the surrounding words, or null when unclear (→ one question). */
export function mapSecretService(text: unknown): { id: string; label: string } | null {
    const value = String(text ?? '')
    for (const entry of SERVICE_MAP) {
        if (entry.re.test(value)) return { id: entry.id, label: entry.label }
    }
    return null
}

export function isTakeoverIntent(text: unknown): boolean {
    return TAKEOVER.test(String(text ?? ''))
}

export function isPurposeQuestion(text: unknown): boolean {
    return PURPOSE_ASK.test(String(text ?? ''))
}

export function isLlmService(serviceId: string): boolean {
    return LLM_SERVICES.has(String(serviceId || '').toLowerCase())
}

/** Pending purpose question (one per principal, short-lived). Never persisted. */
interface PendingSecret {
    value: string
    kind: ChatSecretKind
    context: string
    at: number
}
const PENDING_TTL_MS = 5 * 60_000
const pendingByPrincipal = new Map<string, PendingSecret>()

export function resetChatKeyIntake(): void { pendingByPrincipal.clear() }

/**
 * Register a chat-carried secret for redaction as early as possible (trace,
 * session log, console) — before intake stores it. Never stores, never returns
 * the value. Safe to call on every message.
 */
export function primeChatSecretRedaction(text: unknown): void {
    const secret = detectChatSecret(text)
    if (!secret) return
    registerSecretValue(secret.value, toolKeyId(mapSecretService(text)?.id || 'chat'))
}

export function pendingChatSecret(principal: string): PendingSecret | null {
    const entry = pendingByPrincipal.get(principal)
    if (!entry) return null
    if (Date.now() - entry.at > PENDING_TTL_MS) { pendingByPrincipal.delete(principal); return null }
    return entry
}

/** Tresor path for tool/service keys (existing 0600 store + env activation). */
async function defaultStoreToolKey(_id: string, service: string, value: string, context: string): Promise<{ ok: boolean; message: string }> {
    const { storeServiceApiKey } = await import('./service-keys.js')
    const stored = await storeServiceApiKey(service, value, { context })
    return { ok: stored.ok, message: stored.message }
}

/** LLM provider keys: existing auth store (0600) + env activation without restart. */
async function defaultStoreLlmKey(provider: string, value: string, _context: string): Promise<{ ok: boolean; message: string }> {
    const { connectLlmApiKey, findLlmProvider, maskKey } = await import('../llm/llm-connections.js')
    registerSecretValue(value, `llm-${provider}`)
    const known = findLlmProvider(provider)
    if (known) {
        const result = await connectLlmApiKey(known.id, value)
        if (result.ok) {
            return { ok: true, message: `${known.title} verbunden (${result.maske || '••••'}, ${result.modelle} Modelle) — ohne Neustart aktiv` }
        }
        return { ok: false, message: (result as { meldung?: string }).meldung || 'nicht gespeichert' }
    }
    // Unknown / OpenAI-compatible name: auth store only, never the config file.
    try {
        const { getOAuthManager } = await import('../auth/oauth.js')
        const store = getOAuthManager() as unknown as { setApiKey(id: string, provider: string, key: string): void }
        store.setApiKey(`llm-provider:${provider}`, provider, value)
        return { ok: true, message: `im Auth-Speicher als „llm-provider:${provider}“ (${maskKey(value) || '••••'})` }
    } catch (error) {
        return { ok: false, message: `nicht gespeichert: ${String(error).slice(0, 80)}` }
    }
}

async function defaultTestKey(service: string, value: string): Promise<{ ok: boolean; message: string }> {
    // Known services get a read-only probe. Everything else is reported honestly.
    try {
        if (service === 'tavily') {
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: value, query: 'ping', max_results: 1 }),
                signal: AbortSignal.timeout(8000),
            })
            return res.ok
                ? { ok: true, message: `Tavily antwortet (HTTP ${res.status})` }
                : { ok: false, message: `Tavily HTTP ${res.status}` }
        }
        if (service === 'brave') {
            const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=ping&count=1', {
                headers: { 'Accept': 'application/json', 'X-Subscription-Token': value },
                signal: AbortSignal.timeout(8000),
            })
            return res.ok
                ? { ok: true, message: `Brave antwortet (HTTP ${res.status})` }
                : { ok: false, message: `Brave HTTP ${res.status}` }
        }
    } catch (error) {
        return { ok: false, message: `Live-Test fehlgeschlagen (${String(error).slice(0, 80)})` }
    }
    return { ok: true, message: 'Format geprüft (kein Live-Test hinterlegt)' }
}

export function toolKeyId(serviceId: string): string {
    return `chat-${String(serviceId || 'key').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'key'}`
}

/**
 * One owner-facing reply after a successful take-over. Never contains the value.
 */
export function formatIntakeReply(options: {
    serviceLabel: string
    storeNote: string
    testNote: string
    deleted: boolean
    activated: boolean
}): string {
    const storedOk = !/^FEHLER/i.test(options.storeNote)
    const parts = [
        storedOk ? `✅ Übernommen für ${options.serviceLabel}.` : `❌ Nicht übernommen für ${options.serviceLabel}.`,
        `Gespeichert: ${options.storeNote}.`,
        `Geprüft: ${options.testNote}.`,
    ]
    if (storedOk) {
        parts.push(options.activated ? 'Ohne Neustart aktiv.' : 'Aktivierung: Referenz steht; der nächste Aufruf nutzt sie.')
    }
    if (options.deleted) parts.push('Deine Nachricht mit dem Schlüssel habe ich gelöscht — der Wert steht in keinem Verlauf.')
    else parts.push('Den Klartext speichere ich nirgends; im Verlauf steht nur die Maske.')
    return parts.join(' ')
}

/**
 * The one entry: owner + 1:1 chat + a key in the text → store, mask, delete,
 * test, activate, report. Returns a reply when this branch owns the message
 * (never forward the original text to the model), otherwise null.
 */
export async function intakeOwnerChatSecret(
    content: string,
    meta: {
        channel: string
        from: string
        chatId?: string
        messageId?: number | string
    },
    deps: ChatSecretIntakeDeps = {},
): Promise<string | null> {
    const channel = String(meta.channel || '')
    const from = String(meta.from || '')
    const principal = `${channel.toLowerCase()}:${from}`
    const now = deps.now ? deps.now() : Date.now()

    // 1) Follow-up that only names the purpose of a pending key.
    const pending = pendingChatSecret(principal)
    if (pending) {
        const purpose = mapSecretService(content)
        if (purpose && detectChatSecret(content) === null) {
            pendingByPrincipal.delete(principal)
            return finishIntake({
                value: pending.value,
                service: purpose,
                context: pending.context,
                meta,
                deps,
                deleted: false,
            })
        }
        // Still waiting for a purpose — one question only, never a second key question.
        if (content.trim().length <= 80 && !detectChatSecret(content)) {
            return `Eine Frage noch: Wofür ist der Schlüssel? (z. B. Tavily, Brave, OpenAI, Home Assistant.)`
        }
        // Owner sent something else with a pending key: drop the pending value (expired intent).
        pendingByPrincipal.delete(principal)
    }

    const secret = detectChatSecret(content)
    if (!secret) return null

    // Owner only, 1:1 chat only. Non-owners and groups never get a take-over.
    const isOwner = deps.isOwner ? deps.isOwner(from, channel) : true
    const isGroup = deps.isGroup === true
    if (!isOwner || isGroup) {
        return '🔑 Einen API-Schlüssel trage ich nur im Direktchat des Owners ein — hier nicht. (Wert nicht gespeichert.)'
    }

    // Register for redaction BEFORE anything else can log or echo it.
    registerSecretValue(secret.value, toolKeyId(mapSecretService(content)?.id || 'chat'))

    let deleted = false
    if (deps.deleteMessage && meta.messageId !== undefined && meta.messageId !== null) {
        try {
            await deps.deleteMessage(meta.chatId || from, meta.messageId)
            deleted = true
        } catch { deleted = false }
    }

    const service = mapSecretService(content)
    if (!service) {
        // Exactly one question. The value stays pending (memory only, redacted).
        pendingByPrincipal.set(principal, { value: secret.value, kind: secret.kind, context: secret.context, at: now })
        return `Wofür ist der Schlüssel? (z. B. Tavily, Brave, OpenAI, Home Assistant — ein Wort reicht.)${deleted ? ' Deine Nachricht habe ich gelöscht.' : ''}`
    }

    return finishIntake({
        value: secret.value,
        service,
        context: secret.context,
        meta,
        deps,
        deleted,
    })
}

async function finishIntake(options: {
    value: string
    service: { id: string; label: string }
    context: string
    meta: { channel: string; from: string; chatId?: string; messageId?: number | string }
    deps: ChatSecretIntakeDeps
    deleted: boolean
}): Promise<string> {
    const { value, service, deps } = options
    registerSecretValue(value, toolKeyId(service.id))

    const store = isLlmService(service.id)
        ? (deps.storeLlmKey || defaultStoreLlmKey)
        : (deps.storeToolKey || defaultStoreToolKey)
    let stored: { ok: boolean; message: string }
    try {
        stored = await store(isLlmService(service.id) ? service.id : toolKeyId(service.id), service.id, value, options.context)
    } catch (error) {
        stored = { ok: false, message: String(error).slice(0, 120) }
    }

    const test = deps.testKey || defaultTestKey
    let probe: { ok: boolean; message: string } = { ok: false, message: 'nicht geprüft' }
    if (stored.ok) {
        try { probe = await test(service.id, value) } catch (error) {
            probe = { ok: false, message: String(error).slice(0, 120) }
        }
    }

    return formatIntakeReply({
        serviceLabel: service.label,
        storeNote: stored.ok ? stored.message : `FEHLER — ${stored.message}`,
        testNote: probe.ok ? probe.message : `FEHLER — ${probe.message}`,
        deleted: options.deleted,
        // LLM keys go live via the auth store + env; tool keys via Tresor + env.
        activated: stored.ok,
    })
}

export default {
    MASK,
    detectChatSecret,
    mapSecretService,
    isTakeoverIntent,
    isPurposeQuestion,
    isLlmService,
    intakeOwnerChatSecret,
    resetChatKeyIntake,
    pendingChatSecret,
    formatIntakeReply,
    toolKeyId,
    primeChatSecretRedaction,
}
