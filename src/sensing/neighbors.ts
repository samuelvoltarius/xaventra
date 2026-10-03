import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isIP } from 'node:net'

/** Existing OS neighbor cache only: no privileged ARP sweep or login attempts. */
export function parseNeighbors(raw: string): string[] {
    if (Buffer.byteLength(raw) > 256 * 1024) return []
    const hosts = new Set<string>()
    try {
        const rows = JSON.parse(raw)
        if (Array.isArray(rows)) for (const row of rows.slice(0, 2048)) {
            if (typeof row?.dst === 'string' && isIP(row.dst) === 4 && typeof row.lladdr === 'string'
                && /^[a-f0-9]{2}(?::[a-f0-9]{2}){5}$/i.test(row.lladdr)
                && ![].concat(row.state || []).some(s => /FAILED|INCOMPLETE/i.test(String(s)))) hosts.add(row.dst)
        }
    } catch {
        for (const line of raw.split(/\r?\n/).slice(0, 2048)) {
            if (/incomplete|failed|ff[:-]ff[:-]ff[:-]ff[:-]ff[:-]ff/i.test(line)) continue
            const ip = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]
            if (ip && isIP(ip) === 4 && /\b[a-f0-9]{2}(?:[:-][a-f0-9]{2}){5}\b/i.test(line)) hosts.add(ip)
        }
    }
    return [...hosts].sort().slice(0, 512)
}

export async function localNeighbors(timeoutMs = 1500): Promise<string[]> {
    if (process.env.NOVA_NO_SIDE_EFFECTS === '1') return []
    try {
        const { locateProgram } = await import('../startup/environment-scanner.js')
        const linux = process.platform === 'linux'
        const binary = locateProgram(linux ? 'ip' : 'arp', linux ? ['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip'] : ['/usr/sbin/arp', '/sbin/arp'])
        if (!binary) return []
        const { stdout } = await promisify(execFile)(binary, linux ? ['-j', 'neigh', 'show'] : process.platform === 'win32' ? ['-a'] : ['-an'], { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true })
        return parseNeighbors(stdout)
    } catch { return [] }
}
