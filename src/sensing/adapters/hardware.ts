import type { SensingAdapter } from '../event-bus.js'
import type { DeviceRecord } from '../device-registry.js'
import { verifyHardwareConnection } from '../hardware-recognition.js'

/** An approved connection is an identity-bound GET monitor, never a switch endpoint. */
export function createHardwareAdapter(devices: () => DeviceRecord[]): SensingAdapter {
    return {
        id: 'hardware-readonly', source: 'discovery', intervalMs: 5 * 60_000, timeoutMs: 25_000,
        async poll(ctx) {
            const events = []
            for (const device of devices().filter(d => d.hardware?.connector === 'shelly-readonly').slice(0, 16)) {
                if (ctx.signal.aborted) break
                let reachable = false
                try { reachable = await verifyHardwareConnection(device, {}, ctx.signal) } catch { /* Transport failure must not hide other devices. */ }
                if (ctx.signal.aborted) break
                const previous = ctx.state[device.id]
                ctx.state[device.id] = reachable
                if (previous === reachable) continue
                events.push({ kind: 'hardware.connection', subject: device.id, severity: reachable ? 'info' as const : 'warning' as const,
                    dedupeKey: `hardware:${device.id}:${reachable}`, dedupeWindowMs: 60 * 60_000,
                    summary: `${device.hardware.label}: ${reachable ? 'lesende Verbindung und Gerätekennung bestätigt' : 'Verbindung oder Gerätekennung nicht mehr bestätigt; keine Steuerung ausgeführt'}.`,
                    evidence: { geraet: device.id, erreichbar: reachable },
                })
            }
            return events
        },
    }
}
