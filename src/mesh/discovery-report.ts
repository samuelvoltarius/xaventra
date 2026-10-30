/**
 * Späher (30.10.2026): a scout node (e.g. the NAS in the home LAN) reports the devices it found
 * in its own networks as a signed mesh envelope `discovery.report`. Main accepts only well-formed,
 * bounded reports and keeps the one gate rule of net-scope: private or own tailnet, never public
 * (SSRF guard), and only inside a reported private subnet of at most /24.
 */
import { isIP } from 'node:net'
import { ipToInt, isPrivateRange, scanTargetAllowed, type Cidr } from '../sensing/net-scope.js'

export type ReportedVia = 'tcp' | 'http' | 'mdns' | 'neighbor' | 'udp'
export interface DiscoveryReportCandidate { type: string; host: string; port: number; via: ReportedVia; name?: string; evidence?: Record<string, unknown> }
export interface DiscoveryReportPayload { subnets: string[]; hasTailnet: boolean; candidates: DiscoveryReportCandidate[] }

const VIA = new Set<string>(['tcp', 'http', 'mdns', 'neighbor', 'udp'])
const CANDIDATE_KEYS = new Set(['type', 'host', 'port', 'via', 'name', 'evidence'])
const MAX_SUBNETS = 8
const MAX_CANDIDATES = 512
const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const strictIpv4 = (ip: unknown): ip is string => typeof ip === 'string' && isIP(ip) === 4 && ip.split('.').every(part => String(Number(part)) === part)

/** Reported subnets as CIDRs; null when any is malformed, not private or wider than /24. */
export function parseReportedSubnets(list: unknown): Cidr[] | null {
    if (!Array.isArray(list) || list.length > MAX_SUBNETS) return null
    const subnets: Cidr[] = []
    for (const item of list) {
        const match = typeof item === 'string' ? /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(item) : null
        if (!match || !strictIpv4(match[1]) || !isPrivateRange(match[1])) return null
        const bits = Number(match[2])
        if (bits < 24 || bits > 32) return null
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
        subnets.push({ base: (ipToInt(match[1]) & mask) >>> 0, bits })
    }
    return subnets
}

function validCandidate(value: unknown): value is DiscoveryReportCandidate {
    if (!isPlainObject(value) || Object.keys(value).some(key => !CANDIDATE_KEYS.has(key))) return false
    if (typeof value.type !== 'string' || !/^[a-z0-9-]{1,30}$/.test(value.type)) return false
    if (!strictIpv4(value.host)) return false
    if (!Number.isInteger(value.port) || (value.port as number) < 0 || (value.port as number) > 65535) return false
    if (typeof value.via !== 'string' || !VIA.has(value.via)) return false
    if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 120)) return false
    if (value.evidence !== undefined && (!isPlainObject(value.evidence) || JSON.stringify(value.evidence).length > 2000)) return false
    return true
}

export function validDiscoveryReport(value: unknown): value is DiscoveryReportPayload {
    if (!isPlainObject(value) || Object.keys(value).some(key => !['subnets', 'hasTailnet', 'candidates'].includes(key))) return false
    if (typeof value.hasTailnet !== 'boolean' || !parseReportedSubnets(value.subnets)) return false
    return Array.isArray(value.candidates) && value.candidates.length <= MAX_CANDIDATES && value.candidates.every(validCandidate)
}

/** The one gate rule, applied on Main to every reported address. */
export function acceptedScoutCandidates(report: DiscoveryReportPayload): { accepted: DiscoveryReportCandidate[]; rejected: number } {
    const subnets = parseReportedSubnets(report.subnets) || []
    const accepted = report.candidates.filter(candidate => scanTargetAllowed(candidate.host, { subnets, hasTailnet: report.hasTailnet }).allowed)
    return { accepted, rejected: report.candidates.length - accepted.length }
}
