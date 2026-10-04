/** IPv6 is observation-driven, never address-space enumeration. Only own /64
 * (or narrower) ULA and explicitly interface-scoped link-local peers are allowed. */
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ownSubnets, scanTargetAllowed, type InterfaceMap } from './net-scope.js'
function integer(ip: string): bigint | undefined {
    if (isIP(ip) !== 6 || ip.includes('.')) return
    const halves = ip.toLowerCase().split('::')
    const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : []
    const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    if (parts.length !== 8) return
    return parts.reduce((n, part) => (n << 16n) | BigInt('0x' + part), 0n)
}
export function matterInterfaceNames(interfaces: InterfaceMap = networkInterfaces() as InterfaceMap): string[] {
    return Object.entries(interfaces).filter(([name, entries]) => !/^(?:docker\d+|veth[\w-]*|br-[a-f0-9]{8,}|virbr\d+|tailscale\d*)$/i.test(name) && (entries || []).some(entry => {
        if (entry.internal) return false
        if (scanTargetAllowed(entry.address, ownSubnets(interfaces)).allowed) return true
        const ip = integer(entry.address.split('%')[0])
        return ['IPv6', 6].includes(entry.family) && ip !== undefined && ((ip >> 118n) === 1018n || (ip >> 121n) === 126n)
    })).map(([name]) => name)
}
export interface MatterRoute { prefix: string; bits: number; interface: string }
export function parseMatterRoutes(text: string, interfaces: InterfaceMap): MatterRoute[] {
    const names = matterInterfaceNames(interfaces), result: MatterRoute[] = []
    for (const line of text.slice(0, 32768).split('\n').slice(0, 128)) {
        const match = /^([a-f0-9:]+)\/(\d+)\s+via\s+(fe80:[a-f0-9:]+)\s+dev\s+([a-zA-Z0-9_.-]{1,64})\b/i.exec(line.trim())
        if (!match || !names.includes(match[4])) continue
        const prefix = integer(match[1]), bits = Number(match[2])
        if (prefix === undefined || (prefix >> 121n) !== 126n || !Number.isInteger(bits) || bits < 64 || bits > 128 || integer(match[3]) === undefined) continue
        result.push({ prefix: match[1], bits, interface: match[4] })
    }
    return result
}
export async function localMatterRoutes(interfaces: InterfaceMap = networkInterfaces() as InterfaceMap): Promise<MatterRoute[]> {
    if (process.platform !== 'linux') return []
    try {
        const { stdout } = await promisify(execFile)('ip', ['-6', 'route', 'show'], { timeout: 1000, maxBuffer: 32768, windowsHide: true })
        return parseMatterRoutes(stdout, interfaces)
    } catch { return [] }
}
export function matterMulticastAllowed(host: string, port: number, interfaces: InterfaceMap = networkInterfaces() as InterfaceMap): boolean {
    if (port !== 5353) return false
    const names = matterInterfaceNames(interfaces)
    if (host === '224.0.0.251') return names.length > 0
    const zone = /^ff02::fb%([a-zA-Z0-9_.-]{1,64})$/.exec(host)?.[1]
    return Boolean(zone && names.some(name => name === zone || interfaces[name]?.some(entry => String((entry as any).scopeid) === zone && ['IPv6', 6].includes(entry.family))))
}
export function matterTargetAllowed(host: string, interfaces: InterfaceMap = networkInterfaces() as InterfaceMap, routes: MatterRoute[] = []): boolean {
    if (isIP(host) === 4) return scanTargetAllowed(host, ownSubnets(interfaces)).allowed
    const [ip, zone, extra] = host.split('%'), target = integer(ip)
    if (target === undefined || extra !== undefined || (zone !== undefined && !/^[a-zA-Z0-9_.-]{1,64}$/.test(zone))) return false
    const ula = (target >> 121n) === 126n, link = (target >> 118n) === 1018n
    if (!ula && !link) return false
    for (const [name, entries] of Object.entries(interfaces)) {
        if (/^(?:docker\d+|veth[\w-]*|br-[a-f0-9]{8,}|virbr\d+|tailscale\d*)$/i.test(name)) continue
        const matchesZone = zone === name || (entries || []).some(entry => zone !== undefined && String((entry as any).scopeid) === zone)
        if ((link && !matchesZone) || (zone !== undefined && !matchesZone)) continue
        for (const entry of entries || []) {
            if (entry.internal || !['IPv6', 6].includes(entry.family)) continue
            const own = integer(entry.address.split('%')[0]); if (own === undefined) continue
            const rawBits = Number(entry.cidr?.split('/')[1] || 64)
            const bits = Number.isInteger(rawBits) && rawBits >= 64 && rawBits <= 128 ? rawBits : 64
            const shift = BigInt(128 - bits)
            if (link ? (own >> 118n) === 1018n : (own >> shift) === (target >> shift)) return target !== own
        }
    }
    if (ula && zone === undefined) for (const route of routes) {
        if (!matterInterfaceNames(interfaces).includes(route.interface)) continue
        const prefix = integer(route.prefix)
        if (prefix === undefined || route.bits < 64 || route.bits > 128) continue
        const shift = BigInt(128 - route.bits)
        if ((target >> shift) === (prefix >> shift)) return true
    }
    return false
}
