/**
 * Nova Tool — Home Assistant Integration
 *
 * Connects Nova to a local Home Assistant instance via REST + WebSocket API.
 * Covers lights, switches, climate, media players, sensors — everything HA knows.
 *
 * Config (xaventra.config.json or env):
 *   HASS_URL   = "http://homeassistant.local:8123"
 *   HASS_TOKEN = "eyJ..."   (Long-Lived Access Token from HA Profile page)
 *
 * Or xaventra.config.json:
 *   { "homeassistant": { "url": "...", "token": "..." } }
 *
 * Slash commands: /hass list, /hass status <entity>, /hass <domain>.<service> <entity>
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NovaTool } from './complete-registry.js'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Config
// ============================================

export interface HassConfig {
    url: string
    token: string
}

function getHassConfig(): HassConfig | null {
    // 1. Environment variables
    if (process.env.HASS_URL && process.env.HASS_TOKEN) {
        return { url: process.env.HASS_URL.replace(/\/$/, ''), token: process.env.HASS_TOKEN }
    }

    // 2. xaventra.config.json
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
            const ha = cfg.homeassistant || cfg.hass
            if (ha?.url && ha?.token) {
                return { url: ha.url.replace(/\/$/, ''), token: ha.token }
            }
        }
    } catch { /* ignore */ }

    return null
}

// ============================================
// HTTP Helper
// ============================================

async function hassGet<T = unknown>(path: string): Promise<T> {
    const cfg = getHassConfig()
    if (!cfg) throw new Error('Home Assistant nicht konfiguriert. Setze HASS_URL und HASS_TOKEN.')

    const res = await fetch(`${cfg.url}/api${path}`, {
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(`HA API Fehler ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
}

async function hassPost<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    const cfg = getHassConfig()
    if (!cfg) throw new Error('Home Assistant nicht konfiguriert. Setze HASS_URL und HASS_TOKEN.')

    const res = await fetch(`${cfg.url}/api${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HA API Fehler ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
}

// ============================================
// Types
// ============================================

export interface HassEntity {
    entity_id: string
    state: string
    attributes: Record<string, unknown>
    last_changed: string
    last_updated: string
}

export interface HassServiceResult {
    entity_id: string
    state: string
}

// ============================================
// Core Functions
// ============================================

export async function hassGetState(entityId: string): Promise<HassEntity> {
    return hassGet<HassEntity>(`/states/${entityId}`)
}

export async function hassListEntities(domain?: string): Promise<HassEntity[]> {
    const all = await hassGet<HassEntity[]>('/states')
    if (!domain) return all
    return all.filter(e => e.entity_id.startsWith(`${domain}.`))
}

export async function hassCallService(
    domain: string,
    service: string,
    entityId?: string,
    extra?: Record<string, unknown>,
): Promise<HassServiceResult[]> {
    const body: Record<string, unknown> = { ...extra }
    if (entityId) body.entity_id = entityId
    return hassPost<HassServiceResult[]>(`/services/${domain}/${service}`, body)
}

export async function hassToggle(entityId: string): Promise<HassServiceResult[]> {
    const domain = entityId.split('.')[0]
    return hassCallService(domain, 'toggle', entityId)
}

export async function hassTurnOn(entityId: string, extra?: Record<string, unknown>): Promise<HassServiceResult[]> {
    const domain = entityId.split('.')[0]
    return hassCallService(domain, 'turn_on', entityId, extra)
}

export async function hassTurnOff(entityId: string): Promise<HassServiceResult[]> {
    const domain = entityId.split('.')[0]
    return hassCallService(domain, 'turn_off', entityId)
}

export async function hassGetApiStatus(): Promise<{ message: string }> {
    return hassGet<{ message: string }>('/')
}

// ============================================
// Smart Formatters
// ============================================

export function formatEntityState(entity: HassEntity): string {
    const id = entity.entity_id
    const domain = id.split('.')[0]
    const name = (entity.attributes.friendly_name as string) || id
    const state = entity.state

    const icons: Record<string, string> = {
        light: '💡', switch: '🔌', climate: '🌡️', sensor: '📊',
        binary_sensor: '🔍', media_player: '🎵', cover: '🪟',
        lock: '🔒', camera: '📷', vacuum: '🤖', fan: '💨',
    }
    const icon = icons[domain] || '🏠'

    let out = `${icon} **${name}** (${id}): ${state}`

    // Extra attributes per domain
    if (domain === 'light' && state === 'on') {
        const brightness = entity.attributes.brightness as number
        if (brightness) out += ` — ${Math.round((brightness / 255) * 100)}% Helligkeit`
        const color = entity.attributes.rgb_color
        if (color) out += ` — RGB ${(color as number[]).join(',')}`
    }
    if (domain === 'climate') {
        const temp = entity.attributes.current_temperature
        const target = entity.attributes.temperature
        if (temp) out += ` — ${temp}°C (Ziel: ${target}°C)`
    }
    if (domain === 'sensor') {
        const unit = entity.attributes.unit_of_measurement
        if (unit) out += ` ${unit}`
    }
    if (domain === 'media_player' && state === 'playing') {
        const title = entity.attributes.media_title
        const artist = entity.attributes.media_artist
        if (title) out += ` — ${artist ? artist + ' - ' : ''}${title}`
    }

    return out
}

export function formatEntityList(entities: HassEntity[], maxItems = 30): string {
    if (entities.length === 0) return 'Keine Entitäten gefunden.'

    const grouped: Record<string, HassEntity[]> = {}
    for (const e of entities) {
        const domain = e.entity_id.split('.')[0]
        if (!grouped[domain]) grouped[domain] = []
        grouped[domain].push(e)
    }

    const domainIcons: Record<string, string> = {
        light: '💡', switch: '🔌', climate: '🌡️', sensor: '📊',
        binary_sensor: '🔍', media_player: '🎵', automation: '⚙️',
        scene: '🎬', script: '📝', cover: '🪟', lock: '🔒',
        vacuum: '🤖', fan: '💨', camera: '📷',
    }

    let out = `🏠 **Home Assistant** — ${entities.length} Entitäten\n\n`
    let shown = 0

    for (const [domain, items] of Object.entries(grouped).sort()) {
        if (shown >= maxItems) break
        const icon = domainIcons[domain] || '🏠'
        out += `${icon} **${domain}** (${items.length})\n`
        for (const item of items.slice(0, 5)) {
            if (shown >= maxItems) break
            const name = (item.attributes.friendly_name as string) || item.entity_id
            out += `  • ${name}: ${item.state}\n`
            shown++
        }
        if (items.length > 5) out += `  … +${items.length - 5} weitere\n`
        out += '\n'
    }

    return out
}

// ============================================
// Nova Tools
// ============================================

export const homeAssistantTools: NovaTool[] = [
    {
        name: 'hass_status',
        description: 'Prüft ob Home Assistant erreichbar ist und gibt die API-Version zurück.',
        category: 'other',
        parameters: [],
        handler: async () => {
            try {
                const status = await hassGetApiStatus()
                const cfg = getHassConfig()
                return { connected: true, message: status.message, url: cfg?.url }
            } catch (err) {
                return { connected: false, error: String(err) }
            }
        },
    },
    {
        name: 'hass_list',
        description: 'Listet alle Home Assistant Entitäten auf. Optional nach Domain filtern (light, switch, climate, sensor, etc.).',
        category: 'other',
        parameters: [
            { name: 'domain', type: 'string', description: 'Optional: Domain filtern (z.B. light, switch, climate)', required: false },
        ],
        handler: async (params) => {
            const entities = await hassListEntities(params.domain as string | undefined)
            return { count: entities.length, formatted: formatEntityList(entities), entities: entities.slice(0, 50) }
        },
    },
    {
        name: 'hass_get',
        description: 'Gibt den aktuellen Zustand einer Home Assistant Entität zurück.',
        category: 'other',
        parameters: [
            { name: 'entity_id', type: 'string', description: 'Entitäts-ID (z.B. light.wohnzimmer, switch.steckdose_1)', required: true },
        ],
        handler: async (params) => {
            const entity = await hassGetState(params.entity_id as string)
            return { formatted: formatEntityState(entity), entity }
        },
    },
    {
        name: 'hass_turn_on',
        description: 'Schaltet eine Home Assistant Entität ein. Unterstützt brightness (0-255), color_temp, rgb_color für Lichter.',
        category: 'other',
        parameters: [
            { name: 'entity_id', type: 'string', description: 'Entitäts-ID (z.B. light.schlafzimmer)', required: true },
            { name: 'brightness', type: 'number', description: 'Helligkeit 0-255 (nur für Lichter)', required: false },
            { name: 'color_temp', type: 'number', description: 'Farbtemperatur in Kelvin (nur für Lichter)', required: false },
        ],
        handler: async (params) => {
            const { entity_id, ...extra } = params
            const result = await hassTurnOn(entity_id as string, Object.keys(extra).length > 0 ? extra : undefined)
            return { success: true, result }
        },
    },
    {
        name: 'hass_turn_off',
        description: 'Schaltet eine Home Assistant Entität aus.',
        category: 'other',
        parameters: [
            { name: 'entity_id', type: 'string', description: 'Entitäts-ID', required: true },
        ],
        handler: async (params) => {
            const result = await hassTurnOff(params.entity_id as string)
            return { success: true, result }
        },
    },
    {
        name: 'hass_toggle',
        description: 'Schaltet eine Home Assistant Entität um (ein→aus oder aus→ein).',
        category: 'other',
        parameters: [
            { name: 'entity_id', type: 'string', description: 'Entitäts-ID', required: true },
        ],
        handler: async (params) => {
            const result = await hassToggle(params.entity_id as string)
            return { success: true, result }
        },
    },
    {
        name: 'hass_service',
        description: 'Ruft einen beliebigen Home Assistant Service auf (domain.service). Für erweiterte Aktionen wie Szenen aktivieren, Thermostat setzen, Medien steuern.',
        category: 'other',
        parameters: [
            { name: 'domain', type: 'string', description: 'Domain (z.B. light, climate, media_player, scene)', required: true },
            { name: 'service', type: 'string', description: 'Service (z.B. turn_on, set_temperature, play_media)', required: true },
            { name: 'entity_id', type: 'string', description: 'Optionale Entitäts-ID', required: false },
            { name: 'data', type: 'object', description: 'Optionale Service-Daten als JSON-Objekt', required: false },
        ],
        handler: async (params) => {
            const result = await hassCallService(
                params.domain as string,
                params.service as string,
                params.entity_id as string | undefined,
                params.data as Record<string, unknown> | undefined,
            )
            return { success: true, result }
        },
    },
]

// ============================================
// Slash Command Handler
// ============================================

export async function handleHassCommand(args: string): Promise<string> {
    const parts = args.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()

    try {
        switch (sub) {
            case 'status':
            case '': {
                const status = await hassGetApiStatus()
                const cfg = getHassConfig()
                return `🏠 *Home Assistant*\n✅ Verbunden: ${cfg?.url}\n${status.message}`
            }

            case 'list': {
                const domain = parts[1]
                const entities = await hassListEntities(domain)
                return formatEntityList(entities)
            }

            case 'get': {
                if (!parts[1]) return '❌ Verwendung: /hass get <entity_id>'
                const entity = await hassGetState(parts[1])
                return formatEntityState(entity)
            }

            case 'on':
            case 'ein': {
                if (!parts[1]) return '❌ Verwendung: /hass on <entity_id>'
                await hassTurnOn(parts[1])
                return `✅ ${parts[1]} eingeschaltet`
            }

            case 'off':
            case 'aus': {
                if (!parts[1]) return '❌ Verwendung: /hass off <entity_id>'
                await hassTurnOff(parts[1])
                return `✅ ${parts[1]} ausgeschaltet`
            }

            case 'toggle': {
                if (!parts[1]) return '❌ Verwendung: /hass toggle <entity_id>'
                await hassToggle(parts[1])
                return `🔄 ${parts[1]} umgeschaltet`
            }

            case 'help':
            default:
                return `🏠 *Home Assistant Befehle*

/hass status — Verbindungsstatus
/hass list [domain] — Alle Entitäten (optional nach Domain filtern)
/hass get <entity_id> — Zustand einer Entität
/hass on <entity_id> — Einschalten
/hass off <entity_id> — Ausschalten
/hass toggle <entity_id> — Umschalten

*Beispiele:*
/hass list light
/hass get light.wohnzimmer
/hass on light.küche
/hass toggle switch.kaffeemaschine

*Domains:* light, switch, climate, sensor, media_player, cover, lock, fan, vacuum`
        }
    } catch (err) {
        return `❌ Home Assistant Fehler: ${err}`
    }
}

export default { homeAssistantTools, handleHassCommand, hassGetState, hassListEntities, hassCallService, hassTurnOn, hassTurnOff, hassToggle }
