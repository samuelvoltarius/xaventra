/**
 * `autonomy.sensing` — P8 "Standard: selbststaendig": every switch defaults to
 * ON at the Main (missing = on, `false` = off) and OFF on a mesh worker.
 * Adapters without owner credentials (Home Assistant token, mail login,
 * printer API key) poll nothing. Defaults:
 *
 * {
 *   "autonomy": { "sensing": {
 *     "enabled": true,
 *     "notify": { "quietStart": 22, "quietEnd": 7, "maxPerDay": 10, "timezone": "Europe/Vienna" },
 *     "adapters": {
 *       "printer":       { "enabled": true, "intervalSec": 60,  "timeoutSec": 10, "devices": [] },
 *       "homeassistant": { "enabled": true, "intervalSec": 60,  "timeoutSec": 10, "entities": [] },
 *       "mail":          { "enabled": true, "intervalSec": 300, "timeoutSec": 30, "knownContacts": [] },
 *       "system":        { "enabled": true, "intervalSec": 120, "timeoutSec": 10 }
 *     },
 *     "discovery": { "enabled": true, "deadlineSec": 60, "ratePerSec": 40, "concurrency": 16,
 *                    "maxHosts": 512, "mdns": true, "tailnetHosts": [],
 *                    "firstRunDelaySec": 120, "intervalHours": 24 }
 *   } }
 * }
 */

import { defaultOn } from '../core/autonomy-defaults.js'

export interface PrinterDeviceConfig {
    id: string
    name?: string
    type: 'moonraker' | 'octoprint' | 'prusalink'
    url: string
    /** Name of an env var holding the API key; the key itself is never logged. */
    apiKeyEnv?: string
    apiKey?: string
}

export interface HaEntityConfig { id: string; name?: string; urgent?: boolean }

export interface MailAdapterConfig {
    enabled: boolean
    intervalSec: number
    timeoutSec: number
    knownContacts: string[]
    keywords: string[]
    imap?: { host?: string; port?: number; user?: string; passwordEnv?: string; password?: string; tls?: boolean }
    gmail?: { profile?: string }
}

export interface SensingConfig {
    enabled: boolean
    notify: { quietStart: number; quietEnd: number; maxPerDay: number; timezone: string }
    adapters: {
        printer: { enabled: boolean; intervalSec: number; timeoutSec: number; devices: PrinterDeviceConfig[] }
        homeassistant: { enabled: boolean; intervalSec: number; timeoutSec: number; entities: HaEntityConfig[]; url?: string; token?: string; tokenEnv?: string }
        mail: MailAdapterConfig
        system: { enabled: boolean; intervalSec: number; timeoutSec: number }
    }
    discovery: { enabled: boolean; deadlineSec: number; ratePerSec: number; concurrency: number; maxHosts: number; mdns: boolean; tailnetHosts: string[]; firstRunDelaySec: number; intervalHours: number }
}

export const DEFAULT_KEYWORDS = Object.freeze(['angebot', 'rechnung', 'termin', 'offer', 'quote', 'invoice', 'appointment'])

const obj = (value: unknown): Record<string, any> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {})
function num(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}
const strings = (value: unknown, max = 200): string[] => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, max) : [])

export function parseSensingConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): SensingConfig {
    const on = (value: unknown): boolean => defaultOn(value, env)
    const root = obj(raw)
    const notify = obj(root.notify)
    const adapters = obj(root.adapters)
    const printer = obj(adapters.printer)
    const ha = obj(adapters.homeassistant)
    const mail = obj(adapters.mail)
    const system = obj(adapters.system)
    const discovery = obj(root.discovery)
    const devices: PrinterDeviceConfig[] = (Array.isArray(printer.devices) ? printer.devices : [])
        .map(obj)
        .filter(device => typeof device.url === 'string' && ['moonraker', 'octoprint', 'prusalink'].includes(device.type))
        .slice(0, 20)
        .map((device, index) => ({
            id: String(device.id || `printer-${index + 1}`),
            name: typeof device.name === 'string' ? device.name : undefined,
            type: device.type,
            url: String(device.url).replace(/\/+$/, ''),
            apiKeyEnv: typeof device.apiKeyEnv === 'string' ? device.apiKeyEnv : undefined,
            apiKey: typeof device.apiKey === 'string' ? device.apiKey : undefined,
        }))
    const entities: HaEntityConfig[] = (Array.isArray(ha.entities) ? ha.entities : [])
        .map((entry: unknown) => (typeof entry === 'string' ? { id: entry } : obj(entry)))
        .filter((entry: any) => typeof entry.id === 'string' && /^[a-z_]+\.[a-z0-9_]+$/i.test(entry.id))
        .slice(0, 100)
        .map((entry: any) => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : undefined, urgent: entry.urgent === true }))
    const imap = obj(mail.imap)
    return {
        enabled: on(root.enabled),
        notify: {
            quietStart: num(notify.quietStart, 22, 0, 23),
            quietEnd: num(notify.quietEnd, 7, 0, 23),
            maxPerDay: num(notify.maxPerDay, 10, 0, 100),
            timezone: typeof notify.timezone === 'string' ? notify.timezone : 'Europe/Vienna',
        },
        adapters: {
            printer: { enabled: on(printer.enabled), intervalSec: num(printer.intervalSec, 60, 15, 3600), timeoutSec: num(printer.timeoutSec, 10, 1, 60), devices },
            homeassistant: {
                enabled: on(ha.enabled), intervalSec: num(ha.intervalSec, 60, 15, 3600), timeoutSec: num(ha.timeoutSec, 10, 1, 60), entities,
                url: typeof ha.url === 'string' ? ha.url.replace(/\/+$/, '') : undefined,
                token: typeof ha.token === 'string' ? ha.token : undefined,
                tokenEnv: typeof ha.tokenEnv === 'string' ? ha.tokenEnv : undefined,
            },
            mail: {
                enabled: on(mail.enabled), intervalSec: num(mail.intervalSec, 300, 60, 86_400), timeoutSec: num(mail.timeoutSec, 30, 5, 120),
                knownContacts: strings(mail.knownContacts, 500).map(item => item.toLowerCase()),
                keywords: strings(mail.keywords, 50).map(item => item.toLowerCase()).length ? strings(mail.keywords, 50).map(item => item.toLowerCase()) : [...DEFAULT_KEYWORDS],
                imap: Object.keys(imap).length ? {
                    host: typeof imap.host === 'string' ? imap.host : undefined,
                    port: imap.port === undefined ? undefined : num(imap.port, 993, 1, 65_535),
                    user: typeof imap.user === 'string' ? imap.user : undefined,
                    passwordEnv: typeof imap.passwordEnv === 'string' ? imap.passwordEnv : undefined,
                    password: typeof imap.password === 'string' ? imap.password : undefined,
                    tls: imap.tls !== false,
                } : undefined,
                gmail: mail.gmail ? { profile: typeof obj(mail.gmail).profile === 'string' ? obj(mail.gmail).profile : undefined } : undefined,
            },
            system: { enabled: on(system.enabled), intervalSec: num(system.intervalSec, 120, 30, 3600), timeoutSec: num(system.timeoutSec, 10, 1, 60) },
        },
        discovery: {
            enabled: on(discovery.enabled),
            deadlineSec: num(discovery.deadlineSec, 60, 1, 300),
            ratePerSec: num(discovery.ratePerSec, 40, 1, 200),
            concurrency: num(discovery.concurrency, 16, 1, 64),
            maxHosts: num(discovery.maxHosts, 512, 1, 1024),
            mdns: discovery.mdns !== false,
            tailnetHosts: strings(discovery.tailnetHosts, 64),
            firstRunDelaySec: num(discovery.firstRunDelaySec, 120, 0, 86_400),
            intervalHours: num(discovery.intervalHours, 24, 1, 24 * 30),
        },
    }
}
