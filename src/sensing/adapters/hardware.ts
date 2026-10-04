import type { SensingAdapter } from '../event-bus.js'
import type { DeviceRecord } from '../device-registry.js'
import { verifyHardwareConnection } from '../hardware-recognition.js'
import { realTuyaBrowse } from '../tuya-discovery.js'

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
                events.push({ kind: 'hardware.connection', subject: device.id, severity: reachable ? 'info' as const : 'warning' as const,
                    dedupeKey: `hardware:${device.id}:${reachable}`, dedupeWindowMs: 60 * 60_000,
                    summary: `${device.hardware.label}: ${device.hardware.connector === 'tuya-announcements'
                        ? reachable ? 'öffentliche Tuya-Ankündigung erneut gesehen; kein authentifizierter Direktzugriff' : 'im begrenzten Zeitfenster keine passende Tuya-Ankündigung; daraus folgt nicht, dass das Gerät offline ist'
                        : reachable ? 'lesende Verbindung und Gerätekennung bestätigt' : 'Verbindung oder Gerätekennung nicht mehr bestätigt; keine Steuerung ausgeführt'}.`,
                    evidence: { geraet: device.id, erreichbar: reachable },
                })
            }
            return events
        },
    }
}
