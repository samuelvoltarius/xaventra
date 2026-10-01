/**
 * /desktop – Direktverbindung: configuration (`desktop.direct` in the config).
 *
 * Off by default. Nothing here reads a password: a desktop only names the
 * file that holds it (`vncPasswordFile`); the file is opened by the gateway
 * at connect time and its content never leaves rfb.ts.
 */

export type DesktopMode = 'view' | 'control'

export interface DirectDesktop {
    /** Short id used in buttons and the audit log (`spark`, `lab`). */
    id: string
    /** Label shown in Telegram and on the page. */
    label: string
    /** `tcp://host:port` (RFB directly) or `ws://` / `wss://` (websockify endpoint). */
    target: string
    /** Absolute path of a plain-text password file (0600) on the Main. Optional for servers without auth. */
    vncPasswordFile?: string
    /** true = Xaventra's own desktop_input acts on this desktop; a takeover pauses it. */
    agentInput: boolean
    /** false = only "Ansehen" is offered. */
    allowControl: boolean
}

export interface DesktopDirectConfig {
    enabled: boolean
    /** HTTPS base URL that reaches the gateway (tailscale serve), e.g. https://main.example.ts.net */
    publicBaseUrl: string
    host: string
    port: number
    /** Link lifetime; never longer than 10 minutes. */
    linkTtlMs: number
    /** A session ends after this time even while connected. */
    sessionMaxMs: number
    /** Directory with the noVNC client (`core/rfb.js`), e.g. /usr/share/novnc. */
    novncDir?: string
    desktops: DirectDesktop[]
}

export const DESKTOP_DIRECT_DEFAULT_PORT = 18793
export const LINK_TTL_MAX_MS = 10 * 60_000
export const SESSION_MAX_DEFAULT_MS = 60 * 60_000
export const SESSION_MAX_LIMIT_MS = 4 * 60 * 60_000
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export const DISABLED_CONFIG: DesktopDirectConfig = Object.freeze({
    enabled: false, publicBaseUrl: '', host: '127.0.0.1', port: DESKTOP_DIRECT_DEFAULT_PORT,
    linkTtlMs: LINK_TTL_MAX_MS, sessionMaxMs: SESSION_MAX_DEFAULT_MS, desktops: [],
}) as DesktopDirectConfig

function validTarget(value: unknown): string | null {
    const raw = String(value ?? '').trim()
    try {
        const url = new URL(raw)
        if (!['tcp:', 'ws:', 'wss:'].includes(url.protocol)) return null
        if (!url.hostname || !url.port) return null
        return raw
    } catch { return null }
}

function validBaseUrl(value: unknown): string {
    const raw = String(value ?? '').trim().replace(/\/+$/, '')
    try {
        const url = new URL(raw)
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return ''
        return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
    } catch { return '' }
}

/** Parse `desktop.direct`; invalid entries are dropped, an unusable config is reported disabled. */
export function parseDesktopDirectConfig(config: any): { config: DesktopDirectConfig; problems: string[] } {
    const raw = config?.desktop?.direct
    const problems: string[] = []
    if (!raw || raw.enabled !== true) return { config: DISABLED_CONFIG, problems }
    const publicBaseUrl = validBaseUrl(raw.publicBaseUrl)
    if (!publicBaseUrl) problems.push('desktop.direct.publicBaseUrl fehlt oder ist kein https-URL')
    const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DESKTOP_DIRECT_DEFAULT_PORT
    const host = typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : '127.0.0.1'
    const ttl = Number(raw.linkTtlMinutes) > 0 ? Number(raw.linkTtlMinutes) * 60_000 : LINK_TTL_MAX_MS
    const sessionMax = Number(raw.sessionMaxMinutes) > 0 ? Number(raw.sessionMaxMinutes) * 60_000 : SESSION_MAX_DEFAULT_MS
    const seen = new Set<string>()
    const desktops: DirectDesktop[] = []
    for (const entry of Array.isArray(raw.desktops) ? raw.desktops : []) {
        const id = String(entry?.id ?? '').trim()
        const target = validTarget(entry?.target)
        if (!ID_PATTERN.test(id) || seen.has(id)) { problems.push(`Desktop-ID ungültig oder doppelt: ${id.slice(0, 32) || '(leer)'}`); continue }
        if (!target) { problems.push(`Desktop ${id}: target muss tcp://, ws:// oder wss:// mit Port sein`); continue }
        const passwordFile = typeof entry?.vncPasswordFile === 'string' && entry.vncPasswordFile.trim() ? entry.vncPasswordFile.trim() : undefined
        seen.add(id)
        desktops.push({
            id, target,
            label: String(entry?.label ?? id).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || id,
            ...(passwordFile ? { vncPasswordFile: passwordFile } : {}),
            agentInput: entry?.agentInput === true,
            allowControl: entry?.allowControl !== false,
        })
    }
    const parsed: DesktopDirectConfig = {
        enabled: Boolean(publicBaseUrl) && desktops.length > 0,
        publicBaseUrl, host, port,
        linkTtlMs: Math.min(LINK_TTL_MAX_MS, Math.max(60_000, ttl)),
        sessionMaxMs: Math.min(SESSION_MAX_LIMIT_MS, Math.max(60_000, sessionMax)),
        ...(typeof raw.novncDir === 'string' && raw.novncDir.trim() ? { novncDir: raw.novncDir.trim() } : {}),
        desktops,
    }
    if (desktops.length === 0) problems.push('desktop.direct.desktops ist leer')
    return { config: parsed, problems }
}
