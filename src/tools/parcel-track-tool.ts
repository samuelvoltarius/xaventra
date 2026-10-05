import type { NovaTool } from './complete-registry.js'
import { getToolAbortSignal } from '../core/tool-abort-scope.js'

const text = (v: unknown) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) : ''
export function parseParcelResult(provider: string, number: string, body: any) {
    if (provider === 'dhl') {
        const shipment = body?.shipments?.find((s: any) => s.id === number)
        if (!shipment?.status?.statusCode) return { success: false, error: 'Keine passende Sendung mit belegtem Status zurückgegeben.' }
        return { success: true, number, provider, status: text(shipment.status.statusCode), description: text(shipment.status.description), eventAt: text(shipment.status.timestamp), service: text(shipment.service) }
    }
    const matches = Array.isArray(body?.data?.accepted) ? body.data.accepted.filter((s: any) => s.number === number) : []
    if (matches.length > 1) return { success: false, error: 'Mehrere Paketdienste passen zur Nummer. Kein einzelner Anbieter oder Lieferstatus bestätigt; Anbieterzuordnung zuerst klären.' }
    const item = matches[0]
    if (body?.code !== 0 || !item?.track_info?.latest_status?.status) return { success: false, error: 'Kein belegter Status vorhanden. Bei 17TRACK muss die Sendung bereits registriert sein; Nova registriert sie nicht automatisch.' }
    return { success: true, number, provider, carrierCode: Number.isInteger(item.carrier) ? item.carrier : undefined, status: text(item.track_info.latest_status.status), description: text(item.track_info.latest_event?.description), eventAt: text(item.track_info.latest_event?.time_iso), cachedProviderResult: true }
}

let lastRequest = 0
export const parcelTrackTool: NovaTool = {
    name: 'parcel_track', category: 'other',
    description: 'Liest den belegten Paketstatus einer angegebenen Trackingnummer bei DHL oder 17TRACK (bereits registrierte Sendungen vieler Anbieter). Anbieter muss vom Nutzer gewählt sein; fragt bei fehlendem Zugang. Keine Registrierung, kein Abonnement, keine kostenpflichtige Echtzeitabfrage.',
    parameters: [
        { name: 'number', type: 'string', required: true, description: 'Trackingnummer aus dem aktuellen Nutzerauftrag, 4–40 Buchstaben/Ziffern/Bindestriche.' },
        { name: 'provider', type: 'string', required: true, description: 'dhl oder 17track; bei unklarer Anbieterwahl zuerst den Nutzer fragen.' },
    ],
    handler: async (params: Record<string, unknown>) => {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        const ctx = getExecutionPolicyContext()
        if (!ctx.authUserId || getUserPermission(ctx.authUserId, ctx.channel) !== 'owner') throw new Error('Paketverfolgung benötigt den authentifizierten Owner.')
        const number = String(params.number || '').trim(), provider = String(params.provider || '').toLowerCase()
        if (!/^[A-Za-z0-9-]{4,40}$/.test(number) || !['dhl', '17track'].includes(provider)) return { success: false, error: 'Gültige Trackingnummer und Anbieterwahl dhl oder 17track erforderlich. Nummernformat allein bestätigt keinen Anbieter.' }
        const request = String(params.requestText || '')
        const requestedNumber = (request.match(/[A-Za-z0-9-]+/g) || []).some(token => token.toLowerCase() === number.toLowerCase())
        if (!requestedNumber || !new RegExp(`\\b${provider}\\b`, 'i').test(request)) return { success: false, error: 'Bitte die Trackingnummer und den gewünschten Abfragedienst DHL oder 17TRACK im aktuellen Auftrag ausdrücklich nennen. Kein stiller Wechsel zu einer anderen Cloud.' }
        const key = provider === 'dhl' ? process.env.XAVENTRA_DHL_TRACKING_API_KEY : process.env.XAVENTRA_17TRACK_TOKEN
        if (!key) return { success: false, needsSetup: true, question: `Möchtest du ${provider === 'dhl' ? 'DHL Shipment Tracking' : '17TRACK für mehrere Paketdienste'} verbinden? Dafür ist ein API-Zugang nötig. Den Schlüssel ausschließlich privat in der Service-Konfiguration hinterlegen, nicht im Chat.`, requiredEnvironmentVariable: provider === 'dhl' ? 'XAVENTRA_DHL_TRACKING_API_KEY' : 'XAVENTRA_17TRACK_TOKEN' }
        if (Date.now() - lastRequest < 5000) return { success: false, error: 'Abfragelimit: bitte mindestens fünf Sekunden zwischen Abfragen warten.' }
        lastRequest = Date.now()
        const parent = getToolAbortSignal(), timeout = AbortSignal.timeout(15_000)
        const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
        try {
            const response = await fetch(provider === 'dhl' ? `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(number)}` : 'https://api.17track.net/track/v2.4/gettrackinfo', {
                method: provider === 'dhl' ? 'GET' : 'POST', redirect: 'error', signal,
                headers: provider === 'dhl' ? { 'DHL-API-Key': key, accept: 'application/json' } : { '17token': key, 'content-type': 'application/json' },
                ...(provider === '17track' ? { body: JSON.stringify([{ number }]) } : {}),
            })
            if (!response.ok) return { success: false, error: `Paketdienst meldet HTTP ${response.status}; kein Lieferstatus bestätigt.` }
            const reader = response.body?.getReader()
            if (!reader) return { success: false, error: 'Leere Anbieterantwort.' }
            const chunks: Uint8Array[] = []; let size = 0
            while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 512_000) { await reader.cancel(); throw new Error('oversize') }; chunks.push(value) }
            const result = parseParcelResult(provider, number, JSON.parse(Buffer.concat(chunks).toString('utf8')))
            return { ...result, queriedAt: new Date().toISOString(), source: provider === 'dhl' ? 'DHL Shipment Tracking Unified' : '17TRACK gettrackinfo' }
        } catch { signal.throwIfAborted(); return { success: false, error: 'Paketabfrage fehlgeschlagen oder ungültige Anbieterantwort; kein Lieferstatus bestätigt.' } }
    },
}
