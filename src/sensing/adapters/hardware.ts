import type { SensingAdapter } from '../event-bus.js'
import type { DeviceRecord } from '../device-registry.js'
import { verifyHardwareConnection } from '../hardware-recognition.js'
import { realTuyaBrowse } from '../tuya-discovery.js'

/**
 * Owner-facing name for a monitored device (2.89.4). Unknown Tuya LAN gear is
 * „unbekanntes Gerät im Netz (Tuya)“ — never the long discovery label and never
 * a technical id.
 */
export function deviceDisplayName(device: Pick<DeviceRecord, 'name' | 'hardware'>): string {
    const label = String(device.hardware?.label || '').trim()
    const looksKnown = label && !/unbekannt|noch ungeprüft|typ noch|geräteart noch/i.test(label)
    if (looksKnown) return label
    const name = String(device.name || '').trim()
    if (name && !/unbekannt|kompatibel|typ noch/i.test(name)) return name
    if (device.hardware?.connector === 'tuya-announcements' || device.hardware?.ecosystem === 'tuya') {
        return 'Unbekanntes Gerät im Netz (Tuya)'
    }
    return 'Unbekanntes Gerät im Netz'
}

/** One plain sentence the owner can read — no protocol essay, no words that look like an outage. */
export function connectionSentence(device: Pick<DeviceRecord, 'name' | 'hardware'>, reachable: boolean): string {
    const name = deviceDisplayName(device)
    const tuya = device.hardware?.connector === 'tuya-announcements' || device.hardware?.ecosystem === 'tuya'
    if (tuya) {
        return reachable
            ? `${name} ist wieder im Netz sichtbar.`
            : `${name} war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.`
    }
    return reachable
        ? `${name} ist wieder erreichbar.`
        : `${name} ist gerade nicht erreichbar.`
}

/** An approved connection is an identity-bound GET monitor, never a switch endpoint. */
export function createHardwareAdapter(devices: () => DeviceRecord[]): SensingAdapter {
    return {
        id: 'hardware-readonly', source: 'discovery', intervalMs: 5 * 60_000, timeoutMs: 25_000,
        async poll(ctx) {
            const events = []
            const targets = devices().filter(d => ['shelly-readonly', 'hue-readonly', 'tasmota-readonly', 'tuya-announcements'].includes(d.hardware?.connector)).slice(0, 16)
            const announcements = targets.some(d => d.hardware.connector === 'tuya-announcements') && !ctx.signal.aborted
                ? await realTuyaBrowse(3000, undefined, ctx.signal) : []
            for (const device of targets) {
                if (ctx.signal.aborted) break
                let reachable = false
                try { reachable = await verifyHardwareConnection(device, { tuyaBrowse: async () => announcements }, ctx.signal) } catch { /* Transport failure must not hide other devices. */ }
                if (ctx.signal.aborted) break
                const previous = ctx.state[device.id]
                ctx.state[device.id] = reachable
                if (previous === reachable) continue
                // 2.89.4: a missed Tuya announcement is info (it does not mean the device is
                // off); only a real lost connection is a warning. Summary is one sentence.
                // The hint makes it one owner notice („hoch“), never a repeating alarm.
                const tuyaMiss = !reachable && (device.hardware?.connector === 'tuya-announcements' || device.hardware?.ecosystem === 'tuya')
                events.push({ kind: 'hardware.connection', subject: device.id, severity: reachable || tuyaMiss ? 'info' as const : 'warning' as const,
                    dedupeKey: `hardware:${device.id}:${reachable}`, dedupeWindowMs: 60 * 60_000,
                    summary: connectionSentence(device, reachable),
                    evidence: { geraet: deviceDisplayName(device), erreichbar: reachable },
                    ...(tuyaMiss ? { hint: { importance: 'hoch' as const, title: connectionSentence(device, reachable) } } : {}),
                })
            }
            return events
        },
    }
}
