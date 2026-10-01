/**
 * Scan-Grenzen der Selbst-Erkennung: nur eigene private Netze.
 *
 * Erlaubt sind ausschließlich IPv4-Adressen, die
 *  1. in einem privaten Bereich liegen (10/8, 172.16/12, 192.168/16) oder im
 *     Tailnet-Bereich 100.64.0.0/10,
 *  2. vom SSRF-Guard als nicht-öffentlich eingestuft werden (Gegenprüfung mit
 *     derselben Klassifizierung wie src/resilience/ssrf-guard.ts),
 *  3. in einem Subnetz eines EIGENEN Interfaces liegen — oder im Tailnet, wenn
 *     dieser Knoten selbst ein Tailnet-Interface hat.
 * Subnetze breiter als /24 werden auf das /24 um die eigene Adresse begrenzt.
 */

import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { checkAddress } from '../resilience/ssrf-guard.js'

export interface InterfaceAddress { address: string; netmask: string; family: string | number; internal: boolean; cidr?: string | null }
export type InterfaceMap = Record<string, InterfaceAddress[] | undefined>

export interface Cidr { base: number; bits: number }

const PRIVATE: ReadonlyArray<[string, number]> = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]]
const TAILNET: [string, number] = ['100.64.0.0', 10]
const MIN_PREFIX = 24

export function ipToInt(ip: string): number {
    return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0) >>> 0
}
export function intToIp(value: number): string {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}
function maskOf(bits: number): number { return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }
export function inCidr(ip: string, base: string | number, bits: number): boolean {
    const b = typeof base === 'string' ? ipToInt(base) : base
    const mask = maskOf(bits)
    return ((ipToInt(ip) & mask) >>> 0) === ((b & mask) >>> 0)
}
function bitsFromNetmask(netmask: string): number {
    if (isIP(netmask) !== 4) return 32
    let value = ipToInt(netmask)
    let bits = 0
    while (value & 0x80000000) { bits++; value = (value << 1) >>> 0 }
    return bits
}

const isStrictIpv4 = (ip: string): boolean => isIP(ip) === 4 && ip.split('.').every(part => String(Number(part)) === part)
export const isPrivateRange = (ip: string): boolean => isStrictIpv4(ip) && PRIVATE.some(([base, bits]) => inCidr(ip, base, bits))
export const isTailnet = (ip: string): boolean => isStrictIpv4(ip) && inCidr(ip, TAILNET[0], TAILNET[1])

/** Own scan scopes from the machine's interfaces (private/tailnet only, max /24 each). */
export function ownSubnets(interfaces: InterfaceMap = networkInterfaces() as InterfaceMap): { subnets: Cidr[]; hasTailnet: boolean; own: string[] } {
    const subnets: Cidr[] = []
    const own: string[] = []
    let hasTailnet = false
    for (const list of Object.values(interfaces)) {
        for (const entry of list || []) {
            const family = entry.family === 4 ? 'IPv4' : entry.family
            if (family !== 'IPv4' || entry.internal || !isStrictIpv4(entry.address)) continue
            if (isTailnet(entry.address)) { hasTailnet = true; own.push(entry.address); continue }
            if (!isPrivateRange(entry.address)) continue
            own.push(entry.address)
            const bits = Math.max(MIN_PREFIX, Math.min(32, bitsFromNetmask(entry.netmask)))
            const base = (ipToInt(entry.address) & maskOf(bits)) >>> 0
            if (!subnets.some(item => item.base === base && item.bits === bits)) subnets.push({ base, bits })
        }
    }
    return { subnets, hasTailnet, own }
}

export interface ScopeDecision { allowed: boolean; reason: string }

/** The one gate every probe target passes. */
export function scanTargetAllowed(ip: string, scope: { subnets: Cidr[]; hasTailnet: boolean }): ScopeDecision {
    if (!isStrictIpv4(ip)) return { allowed: false, reason: 'keine eindeutige IPv4-Adresse' }
    const tailnet = isTailnet(ip)
    if (!isPrivateRange(ip) && !tailnet) return { allowed: false, reason: 'nicht privat (öffentliches oder Sondernetz)' }
    // Cross-check with the SSRF guard: a target it would let through as public is never scanned.
    if (checkAddress(ip).allowed) return { allowed: false, reason: 'SSRF-Guard stuft die Adresse als öffentlich ein' }
    if (tailnet) return scope.hasTailnet ? { allowed: true, reason: 'eigenes Tailnet' } : { allowed: false, reason: 'kein eigenes Tailnet-Interface' }
    const subnet = scope.subnets.find(item => inCidr(ip, item.base, item.bits))
    if (!subnet) return { allowed: false, reason: 'fremdes Netz (kein eigenes Interface)' }
    const host = ipToInt(ip) & ~maskOf(subnet.bits)
    if (subnet.bits <= 30 && (host === 0 || host === (~maskOf(subnet.bits) >>> 0))) return { allowed: false, reason: 'Netz- oder Broadcast-Adresse' }
    return { allowed: true, reason: 'eigenes Subnetz' }
}

/** All hosts of the own subnets plus validated tailnet hosts, capped at maxHosts. */
export function scanHosts(scope: { subnets: Cidr[]; hasTailnet: boolean }, extra: string[], maxHosts: number): { hosts: string[]; rejected: Array<{ host: string; reason: string }>; truncated: boolean } {
    const hosts: string[] = []
    const rejected: Array<{ host: string; reason: string }> = []
    let truncated = false
    const push = (ip: string) => {
        if (hosts.includes(ip)) return
        if (hosts.length >= maxHosts) { truncated = true; return }
        hosts.push(ip)
    }
    for (const ip of extra) {
        const decision = scanTargetAllowed(ip, scope)
        if (decision.allowed) push(ip)
        else rejected.push({ host: ip, reason: decision.reason })
    }
    for (const subnet of scope.subnets) {
        const size = 2 ** (32 - subnet.bits)
        for (let offset = 0; offset < size; offset++) {
            const ip = intToIp((subnet.base + offset) >>> 0)
            if (scanTargetAllowed(ip, scope).allowed) push(ip)
            if (truncated) break
        }
    }
    return { hosts, rejected, truncated }
}
