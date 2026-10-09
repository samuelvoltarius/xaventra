/**
 * 2.89.4: the one store/resolve path for non-LLM service keys (Tavily, Brave,
 * Home Assistant, Proxmox, parcel tracking, …).
 *
 * Owner rule (binding): keys come in via chat (owner DM) or an explicit owner
 * tool call — never as clear text in `xaventra.config.json`. The value goes to
 * the existing 0600 Tresor (`credential-broker.ts`), is registered for
 * redaction, and is activated without a restart (env + in-memory config ref).
 * The config file only keeps `«field»Ref = tresor:<id>`.
 *
 * Existing single paths (`save_api_key`, `/apikey`, chat-key intake, search
 * tools) all land here — no parallel store.
 */
import { registerSecretValue } from '../security/secret-redaction.js'

export interface ServiceKeyPlan {
    /** Tresor id (also the redaction label). */
    id: string
    /** Human label for the owner reply. */
    label: string
    /** Process env var that makes the key live without a restart. */
    env?: string
    /** `config.apis` field name (legacy readers). Never written clear. */
    configField?: string
    /** Host names the Tresor release is bound to. */
    dienste: string[]
}

/** Canonical service id → store/activation plan. First match of callers' words uses this table. */
const SERVICE_KEY_PLANS: Record<string, ServiceKeyPlan> = {
    tavily: { id: 'chat-tavily', label: 'Tavily', env: 'TAVILY_API_KEY', configField: 'tavily_key', dienste: ['api.tavily.com', 'tavily.com'] },
    brave: { id: 'chat-brave', label: 'Brave Search', env: 'BRAVE_SEARCH_API_KEY', configField: 'brave_search_key', dienste: ['api.search.brave.com', 'brave.com'] },
    serper: { id: 'chat-serper', label: 'Serper', env: 'SERPER_API_KEY', dienste: ['google.serper.dev'] },
    serpapi: { id: 'chat-serpapi', label: 'SerpAPI', env: 'SERPAPI_API_KEY', dienste: ['serpapi.com'] },
    perplexity: { id: 'chat-perplexity', label: 'Perplexity', env: 'PERPLEXITY_API_KEY', configField: 'perplexity_key', dienste: ['api.perplexity.ai'] },
    'home-assistant': { id: 'chat-home-assistant', label: 'Home Assistant', env: 'HOME_ASSISTANT_TOKEN', dienste: ['home-assistant.local', 'hass.local'] },
    proxmox: { id: 'chat-proxmox', label: 'Proxmox', env: 'PVE_API_TOKEN', dienste: ['proxmox.local'] },
    telegram: { id: 'chat-telegram', label: 'Telegram', env: 'TELEGRAM_BOT_TOKEN', dienste: ['api.telegram.org'] },
    discord: { id: 'chat-discord', label: 'Discord', env: 'DISCORD_BOT_TOKEN', dienste: ['discord.com', 'discordapp.com'] },
    whatsapp: { id: 'chat-whatsapp', label: 'WhatsApp', env: 'WHATSAPP_TOKEN', dienste: ['graph.facebook.com'] },
    dhl: { id: 'chat-dhl', label: 'DHL Shipment Tracking', env: 'XAVENTRA_DHL_TRACKING_API_KEY', dienste: ['api-eu.dhl.com', 'dhl.com'] },
    '17track': { id: 'chat-17track', label: '17TRACK', env: 'XAVENTRA_17TRACK_TOKEN', dienste: ['api.17track.net', '17track.net'] },
}

export function serviceKeyPlan(serviceId: string): ServiceKeyPlan {
    const id = String(serviceId || '').toLowerCase().trim()
    const known = SERVICE_KEY_PLANS[id]
    if (known) return known
    const safe = id.replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'key'
    return { id: `chat-${safe}`, label: serviceId || safe, dienste: [`${safe}.local`] }
}

function isClearKey(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 8 && !/^(?:tresor|auth|ref):/i.test(value)
}

/**
 * Store a service key in the 0600 Tresor, register it for redaction and
 * activate it without a restart. Config never receives the clear value.
 */
export async function storeServiceApiKey(
    serviceId: string,
    value: string,
    options: { context?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; message: string; id: string }> {
    const plan = serviceKeyPlan(serviceId)
    const secret = String(value ?? '')
    if (!secret || secret.length > 4096 || /[\u0000\r\n]/.test(secret)) {
        return { ok: false, message: 'Ungültiger Schlüsselwert.', id: plan.id }
    }
    registerSecretValue(secret, plan.id)
    const { speichereEintrag } = await import('./credential-broker.js')
    const saved = speichereEintrag({
        id: plan.id,
        label: plan.label,
        quelle: 'datei',
        dienste: plan.dienste,
        geheim: secret,
    })
    if (saved.ok) {
        // continue below
    } else {
        return { ok: false, message: (saved as { meldung?: string }).meldung || 'nicht gespeichert', id: plan.id }
    }

    const env = options.env || process.env
    if (plan.env) env[plan.env] = secret

    // Config: only a reference. Never the value.
    try {
        const { getNovaConfig } = await import('../core/config.js')
        const config = getNovaConfig() as Record<string, any>
        if (!config.apis || typeof config.apis !== 'object') config.apis = {}
        if (plan.configField) {
            config.apis[`${plan.configField}Ref`] = `tresor:${plan.id}`
            // Drop a legacy clear value so a later saveConfig cannot persist it.
            delete config.apis[plan.configField]
        }
    } catch { /* config singleton optional */ }

    return {
        ok: true,
        message: `im Tresor als „${plan.id}“${plan.env ? ` (aktiv über ${plan.env})` : ''}`,
        id: plan.id,
    }
}

/**
 * Resolve a service key for a tool call: env first (already activated), then a
 * legacy clear config value, then the Tresor. Never logs or returns the source.
 */
export async function resolveServiceApiKey(serviceId: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
    const plan = serviceKeyPlan(serviceId)
    const env = options.env || process.env
    if (plan.env && isClearKey(env[plan.env])) return env[plan.env]!

    try {
        const { getNovaConfig } = await import('../core/config.js')
        const apis = (getNovaConfig() as any)?.apis || {}
        if (plan.configField) {
            if (isClearKey(apis[plan.configField])) return apis[plan.configField]
            const ref = String(apis[`${plan.configField}Ref`] || '')
            if (ref.startsWith('tresor:')) {
                const value = await readTresorSecret(ref.slice('tresor:'.length))
                if (value) return value
            }
        }
    } catch { /* fall through to Tresor */ }

    return readTresorSecret(plan.id)
}

async function readTresorSecret(id: string): Promise<string | null> {
    try {
        const { mitZugang, listeEintraege } = await import('./credential-broker.js')
        const entry = listeEintraege().find(item => item.id === id)
        if (!entry) return null
        const dienst = entry.dienste[0] || serviceKeyPlan(id).dienste[0] || 'local'
        const result = await mitZugang(id, dienst, async wert => wert.geheim)
        return result.ok ? result.ergebnis : null
    } catch {
        return null
    }
}

export default { serviceKeyPlan, storeServiceApiKey, resolveServiceApiKey }
