import { createSocket } from 'node:dgram'
import { isIP } from 'node:net'
import { cleanText } from './ports.js'
import { ownSubnets, scanTargetAllowed, isPrivateRange, type InterfaceMap } from './net-scope.js'

export interface SsdpDescription { host: string; port: number; path: string; usn: string }
/** LOCATION is untrusted: only the responding private IPv4 host, GET an XML
 * description, no redirects, credentials, queries, DNS or control URLs. */
export function parseSsdpDescription(packet: string, responder: string, interfaces?: InterfaceMap): SsdpDescription | null {
    if (packet.length > 8192 || !/^HTTP\/1\.[01] 200\b/.test(packet) || !scanTargetAllowed(responder, ownSubnets(interfaces)).allowed) return null
    const headers: Record<string, string> = {}
    for (const line of packet.split(/\r?\n/).slice(1, 40)) {
        const match = /^([a-z-]+):\s*(.{1,500})$/i.exec(line)
        if (match) { const key = match[1].toLowerCase(); if (headers[key]) return null; headers[key] = match[2].trim() }
    }
    try {
        const url = new URL(headers.location)
        if (url.protocol !== 'http:' || isIP(url.hostname) !== 4 || url.hostname !== responder || url.username || url.password || url.search || url.hash
            || !/^\/[a-z0-9_./-]{1,150}\.xml$/i.test(url.pathname) || url.pathname.includes('..')) return null
        const port = Number(url.port || 80)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null
        const usn = headers.usn || ''
        if (!/^uuid:[a-z0-9_-]{4,100}(?:::urn:[a-z0-9:_-]{1,150})?$/i.test(usn)) return null
        return { host: responder, port, path: url.pathname, usn: cleanText(usn, 180) }
    } catch { return null }
}

/** One bounded SSDP discovery request, on explicitly physical LAN interfaces. */
export function realSsdpBrowse(timeoutMs: number, interfaces?: InterfaceMap): Promise<SsdpDescription[]> {
    const addresses = ownSubnets(interfaces).own.filter(isPrivateRange).slice(0, 4)
    if (!addresses.length) return Promise.resolve([])
    return new Promise(resolve => {
        const socket = createSocket('udp4'); const found: SsdpDescription[] = []; let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(timer); try { socket.close() } catch { /* closed */ } resolve(found) }
        const timer = setTimeout(finish, Math.max(100, Math.min(timeoutMs, 1500)))
        socket.on('error', finish)
        socket.on('message', (packet, remote) => {
            if (found.length >= 8 || packet.length > 8192) return
            const descriptor = parseSsdpDescription(packet.toString('utf8'), remote.address, interfaces)
            if (descriptor && !found.some(d => d.host === descriptor.host && d.port === descriptor.port && d.path === descriptor.path)) found.push(descriptor)
        })
        socket.bind(0, () => {
            if (done) return
            socket.setMulticastTTL(1)
            for (const address of addresses) {
                try {
                    socket.setMulticastInterface(address)
                    socket.send(Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n'), 1900, '239.255.255.250', () => undefined)
                } catch { /* optional interface may disappear */ }
            }
        })
    })
}
