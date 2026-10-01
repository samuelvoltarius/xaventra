/**
 * Home-Assistant-Adapter (nur lesend): meldet Zustandswechsel konfigurierter
 * Entitäten (`GET /api/states/<entity>`). Ohne URL+Token oder ohne Entitäten
 * tut er nichts. Schalten bleibt im Werkzeug src/tools/homeassistant.ts.
 * Die erste Beobachtung einer Entität ist nur die Ausgangslage (kein Ereignis).
 */

import type { HassEntity } from '../../tools/homeassistant.js'
import type { AdapterContext, RawEvent, SensingAdapter } from '../event-bus.js'
import type { HaEntityConfig } from '../config.js'
import type { FetchLike } from './printer.js'

export interface HaConnection { url: string; token: string }

/** Owner-provided connection only: adapter config, then the tool's own config/env. Never guessed. */
export function resolveHaConnection(adapterCfg: { url?: string; token?: string; tokenEnv?: string }, rootConfig: any, env: NodeJS.ProcessEnv = process.env): HaConnection | null {
    const fromAdapter = adapterCfg.url && (adapterCfg.token || (adapterCfg.tokenEnv && env[adapterCfg.tokenEnv]))
    if (fromAdapter) return { url: adapterCfg.url!, token: String(adapterCfg.token || env[adapterCfg.tokenEnv!]) }
    if (env.HASS_URL && env.HASS_TOKEN) return { url: env.HASS_URL.replace(/\/+$/, ''), token: env.HASS_TOKEN }
    const ha = rootConfig?.homeassistant || rootConfig?.hass
    if (ha?.url && ha?.token) return { url: String(ha.url).replace(/\/+$/, ''), token: String(ha.token) }
    return null
}

export function haTransitions(entity: HaEntityConfig, previous: string | undefined, current: Pick<HassEntity, 'state' | 'last_changed' | 'attributes'>): RawEvent[] {
    if (previous === undefined || previous === current.state) return []
    const friendly = entity.name || (typeof current.attributes?.friendly_name === 'string' ? current.attributes.friendly_name : entity.id)
    return [{
        kind: 'ha.state', subject: entity.id, severity: entity.urgent ? 'urgent' : 'info',
        dedupeKey: `ha:${entity.id}:${current.state}:${current.last_changed || ''}`,
        summary: `${friendly}: ${previous} → ${current.state}`,
        evidence: { entitaet: entity.id, vorher: previous, jetzt: current.state, geaendert: current.last_changed || null },
        hint: { importance: entity.urgent ? 'dringend' : 'normal' },
    }]
}

export function createHomeAssistantAdapter(options: {
    connection: () => HaConnection | null
    entities: HaEntityConfig[]
    intervalMs: number
    timeoutMs: number
    fetch?: FetchLike
}): SensingAdapter {
    const doFetch: FetchLike = options.fetch || ((url, init) => fetch(url, init) as any)
    return {
        id: 'homeassistant', source: 'homeassistant', intervalMs: options.intervalMs, timeoutMs: options.timeoutMs,
        async poll(ctx: AdapterContext): Promise<RawEvent[]> {
            const connection = options.connection()
            if (!connection || !options.entities.length) return []
            const last = (ctx.state.last as Record<string, string>) || {}
            const events: RawEvent[] = []
            for (const entity of options.entities) {
                const res = await doFetch(`${connection.url}/api/states/${encodeURIComponent(entity.id)}`, {
                    method: 'GET', signal: ctx.signal, headers: { Authorization: `Bearer ${connection.token}`, Accept: 'application/json' },
                })
                if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`)
                const body = await res.json() as HassEntity
                const state = String(body?.state ?? 'unknown').slice(0, 60)
                events.push(...haTransitions(entity, last[entity.id], { state, last_changed: body?.last_changed, attributes: body?.attributes || {} }))
                last[entity.id] = state
            }
            ctx.state.last = last
            return events
        },
    }
}
