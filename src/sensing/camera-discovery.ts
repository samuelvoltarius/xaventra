/**
 * Kameras erkennen (30.10.2026): ONVIF WS-Discovery and RTSP OPTIONS, both WITHOUT any login.
 * Answers are untrusted: an ONVIF answer only counts for the address that sent it, nothing here
 * ever sends credentials, requests an image or tries a default password. Every target still
 * passes the net-scope gate in discoverDevices, directly before it is used.
 */
import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIP, Socket } from 'node:net'
import { cleanText } from './ports.js'
import { isPrivateRange, ownSubnets, scanTargetAllowed, type InterfaceMap } from './net-scope.js'

export interface OnvifFind { host: string; port: number; name?: string; model?: string; manufacturer?: string }
export interface RtspAnswer { status: number; server?: string; zugang: 'noetig' | 'offen' }

const MAX_ANSWER = 64 * 1024
const WS_DISCOVERY_ADDRESS = '239.255.255.250'
const WS_DISCOVERY_PORT = 3702

/** One WS-Discovery Probe for ONVIF video devices. It carries a message id and nothing else. */
export function onvifProbeMessage(messageId: string = `urn:uuid:${randomUUID()}`): string {
    return '<?xml version="1.0" encoding="UTF-8"?>'
        + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        + 'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        + `<e:Header><w:MessageID>${messageId}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>`
        + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
        + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
}

const element = (xml: string, name: string): string | undefined =>
    new RegExp(`<(?:[a-z0-9]+:)?${name}(?:\\s[^>]*)?>([^<]{0,4000})</(?:[a-z0-9]+:)?${name}>`, 'i').exec(xml)?.[1]?.trim()

function scopeValue(scopes: string[], key: string): string | undefined {
    const prefix = `onvif://www.onvif.org/${key}/`
    const raw = scopes.find(scope => scope.toLowerCase().startsWith(prefix.toLowerCase()))?.slice(prefix.length)
    if (!raw) return undefined
    try { return cleanText(decodeURIComponent(raw).replace(/[_+]/g, ' '), 80) || undefined } catch { return undefined }
}

/** An answer counts only for the address that sent it: the service address must be that host, without credentials. */
export function parseOnvifProbeMatch(xml: string, responder: string): OnvifFind | null {
    if (xml.length > MAX_ANSWER || isIP(responder) !== 4) return null
    if (!/ProbeMatch/i.test(xml) || !/NetworkVideoTransmitter/i.test(element(xml, 'Types') || '')) return null
    let port = 0
    for (const address of (element(xml, 'XAddrs') || '').split(/\s+/).filter(Boolean).slice(0, 8)) {
        try {
            const url = new URL(address)
            if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
            if (url.username || url.password) return null
            if (url.hostname !== responder) continue
            port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
            break
        } catch { /* a broken address does not count */ }
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    const scopes = (element(xml, 'Scopes') || '').split(/\s+/).filter(Boolean).slice(0, 32)
    const name = scopeValue(scopes, 'name'), model = scopeValue(scopes, 'hardware'), manufacturer = scopeValue(scopes, 'mfr')
    return { host: responder, port, ...(name ? { name } : {}), ...(model ? { model } : {}), ...(manufacturer ? { manufacturer } : {}) }
}

/** One bounded ONVIF probe per own private interface; only answers from allowed addresses are kept. */
export function realOnvifBrowse(timeoutMs: number, interfaces?: InterfaceMap): Promise<OnvifFind[]> {
    const scope = ownSubnets(interfaces)
    const addresses = scope.own.filter(isPrivateRange).slice(0, 4)
    if (!addresses.length) return Promise.resolve([])
    return new Promise(resolve => {
        const socket = createSocket('udp4'); const found: OnvifFind[] = []; let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(timer); try { socket.close() } catch { /* closed */ } resolve(found) }
        const timer = setTimeout(finish, Math.max(100, Math.min(timeoutMs, 2000)))
        socket.on('error', finish)
        socket.on('message', (packet, remote) => {
            if (found.length >= 32 || packet.length > MAX_ANSWER || !scanTargetAllowed(remote.address, scope).allowed) return
            const match = parseOnvifProbeMatch(packet.toString('utf8'), remote.address)
            if (match && !found.some(item => item.host === match.host)) found.push(match)
        })
        socket.bind(0, () => {
            if (done) return
            socket.setMulticastTTL(1)
            for (const address of addresses) {
                try {
                    socket.setMulticastInterface(address)
                    socket.send(Buffer.from(onvifProbeMessage()), WS_DISCOVERY_PORT, WS_DISCOVERY_ADDRESS, () => undefined)
                } catch { /* optional interface may disappear */ }
            }
        })
    })
}

/** RTSP OPTIONS asks what the server can do. No credentials, no stream, no image. */
export function rtspOptionsRequest(host: string, port: number): string {
    return `OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: Xaventra-Discovery\r\n\r\n`
}

export function parseRtspOptions(answer: string): RtspAnswer | null {
    const match = /^RTSP\/1\.[01] (\d{3})\b/.exec(answer)
    if (!match) return null
    const status = Number(match[1])
    const server = /^server:\s*(.{1,200})$/im.exec(answer)?.[1]?.trim()
    return { status, ...(server ? { server: cleanText(server, 80) } : {}), zugang: status === 200 ? 'offen' : 'noetig' }
}

export function realRtspProbe(host: string, port: number, timeoutMs: number): Promise<RtspAnswer | null> {
    return new Promise(resolve => {
        const socket = new Socket(); let text = ''; let done = false
        const finish = (value: RtspAnswer | null) => { if (done) return; done = true; socket.destroy(); resolve(value) }
        socket.setTimeout(timeoutMs, () => finish(null))
        socket.on('error', () => finish(null))
        socket.on('close', () => finish(parseRtspOptions(text)))
        socket.on('data', chunk => {
            text += chunk.toString('latin1')
            if (text.length > 4096 || text.includes('\r\n\r\n')) finish(parseRtspOptions(text.slice(0, 4096)))
        })
        socket.connect(port, host, () => socket.write(rtspOptionsRequest(host, port)))
    })
}
