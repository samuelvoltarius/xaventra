/** Tuya LAN discovery only, following TinyTuya's documented 55AA/6699
 * broadcast framing. The public discovery key is not a device local key.
 * Never send control, session negotiation, provisioning or cloud requests. */
import { createSocket, type Socket } from 'node:dgram'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ownSubnets, scanTargetAllowed, isPrivateRange, intToIp, ipToInt, inCidr, type InterfaceMap } from './net-scope.js'
import type { DeviceCandidate } from './device-registry.js'

const discoveryKey = () => createHash('md5').update('yGAdlopoPVldABfn').digest()
function crc32(data: Buffer): number {
    let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    return (crc ^ 0xffffffff) >>> 0
}
function ecb(payload: Buffer): Buffer {
    const cipher = createDecipheriv('aes-128-ecb', discoveryKey(), null)
    return Buffer.concat([cipher.update(payload), cipher.final()])
}
function decode(packet: Buffer): Buffer | null {
    if (packet.length < 16 || packet.length > 4096) return null
    const prefix = packet.readUInt32BE(0)
    if (prefix === 0x55aa) {
        if (packet.length < 28 || packet.readUInt32BE(12) + 16 !== packet.length
            || ![0, 0x13, 0x23].includes(packet.readUInt32BE(8))
            || packet.readUInt32BE(packet.length - 4) !== 0xaa55
            || packet.readUInt32BE(packet.length - 8) !== crc32(packet.subarray(0, -8))) return null
        let payload = packet.subarray(16, -8)
        if (payload.length >= 4 && payload.readUInt32BE(0) === 0) payload = payload.subarray(4)
        return payload[0] === 0x7b ? payload : ecb(payload)
    }
    if (prefix === 0x6699) {
        if (packet.length < 50 || packet.readUInt16BE(4) !== 0 || packet.readUInt32BE(14) + 22 !== packet.length
            || ![0, 0x13, 0x23, 0x25].includes(packet.readUInt32BE(10)) || packet.readUInt32BE(packet.length - 4) !== 0x9966) return null
        const cipher = createDecipheriv('aes-128-gcm', discoveryKey(), packet.subarray(18, 30))
        cipher.setAAD(packet.subarray(4, 18)); cipher.setAuthTag(packet.subarray(-20, -4))
        let payload = Buffer.concat([cipher.update(packet.subarray(30, -20)), cipher.final()])
        if (payload.length > 4 && payload.readUInt32BE(0) === 0) payload = payload.subarray(4)
        return payload
    }
    // Older announcements can contain just a raw ECB payload.
    return packet.length % 16 === 0 ? ecb(packet) : null
}

/** Parse selected public fields only; bind reported IP to the datagram sender.
 * Device-reported product ID is not a model/type or proof of control access. */
export function parseTuyaAnnouncement(packet: Buffer, sender: string, interfaces?: InterfaceMap, now = Date.now()): DeviceCandidate | null {
    if (!isPrivateRange(sender) || !scanTargetAllowed(sender, ownSubnets(interfaces)).allowed) return null
    try {
        const payload = decode(packet)
        if (!payload) return null
        const v = JSON.parse(payload.toString('utf8').replace(/\x00+$/, ''))
        if (v?.ip !== sender || typeof v.gwId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(v.gwId)
            || !['3.1', '3.2', '3.3', '3.4', '3.5'].includes(String(v.version))) return null
        const product = typeof v.productKey === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(v.productKey) ? v.productKey : undefined
        return { type: 'networkservice', host: sender, port: 6668, via: 'udp', name: 'Tuya-kompatibles Gerät (Typ noch unbekannt)',
            hardware: { kind: 'unknown', label: 'Tuya-LAN-Gerät, konkrete Geräteart noch unbekannt', certainty: 'confirmed',
                manufacturer: 'Tuya-Protokoll (OEM-Hersteller ungeprüft)', identity: v.gwId, ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: new Date(now).toISOString() },
            evidence: { quelle: 'Tuya-LAN-Ankündigung', version: String(v.version), ...(product ? { produktkennung: product } : {}),
                hinweis: 'Protokollkennung beobachtet, kein TCP-/Steuerbarkeitsbeleg; Lampe/Steckdose und Hersteller noch ungeprüft' } }
    } catch { return null }
}

/** Fixed read-only app discovery command for newer 3.5 devices. */
export function tuyaDiscoveryRequest(address: string): Buffer {
    if (!isPrivateRange(address)) throw new Error('Private interface required')
    const payload = Buffer.from(JSON.stringify({ from: 'app', ip: address }))
    const header = Buffer.alloc(18)
    header.writeUInt32BE(0x6699, 0); header.writeUInt32BE(0x25, 10); header.writeUInt32BE(12 + payload.length + 16, 14)
    const iv = randomBytes(12), cipher = createCipheriv('aes-128-gcm', discoveryKey(), iv)
    cipher.setAAD(header.subarray(4))
    const body = Buffer.concat([cipher.update(payload), cipher.final()]), suffix = Buffer.from([0, 0, 0x99, 0x66])
    return Buffer.concat([header, iv, body, cipher.getAuthTag(), suffix])
}

/** Listen at discovery ports and send at most one query per own LAN interface.
 * Short-lived sockets, bounded packets/results, stop propagation, no Tailnet broadcast. */
export function realTuyaBrowse(timeoutMs: number, interfaces?: InterfaceMap, signal?: AbortSignal,
    socketFactory: () => Socket = () => createSocket({ type: 'udp4', reuseAddr: false })): Promise<DeviceCandidate[]> {
    const scope = ownSubnets(interfaces), addresses = scope.own.filter(isPrivateRange).slice(0, 4)
    if (!addresses.length || signal?.aborted) return Promise.resolve([])
    return new Promise(resolve => {
        const sockets: Socket[] = [], found: DeviceCandidate[] = []; let done = false, received = 0
        const finish = () => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', finish); for (const socket of sockets) try { socket.close() } catch { /* closed */ } resolve(found) }
        const timer = setTimeout(finish, Math.max(100, Math.min(timeoutMs, 3000)))
        signal?.addEventListener('abort', finish, { once: true })
        const listen = (port: number, address?: string) => {
            const socket = socketFactory(); sockets.push(socket)
            socket.on('error', () => { try { socket.close() } catch { /* closed */ } })
            socket.on('message', (packet, remote) => {
                if (done || ++received > 128 || found.length >= 32 || packet.length > 4096) return
                const device = parseTuyaAnnouncement(packet, remote.address, interfaces)
                if (device && !found.some(d => d.host === device.host && d.hardware?.identity === device.hardware?.identity)) found.push(device)
            })
            socket.bind(port, address || '0.0.0.0', () => {
                if (done || !address) return
                const subnet = scope.subnets.find(s => s.bits <= 30 && inCidr(address, s.base, s.bits))
                if (!subnet) return
                try { socket.setBroadcast(true); const broadcast = intToIp((subnet.base | (0xffffffff >>> subnet.bits)) >>> 0)
                    if (ipToInt(broadcast) !== ipToInt(address)) socket.send(tuyaDiscoveryRequest(address), 7000, broadcast, () => undefined)
                } catch { /* interface disappeared */ }
            })
        }
        for (const port of [6666, 6667, 7000]) listen(port)
        for (const address of addresses) listen(0, address)
        if (signal?.aborted) finish()
    })
}
