/** Owner-only inspection of a known mesh peer's Tailscale HTTPS landing page.
 * This is separate from public fetch_url: no arbitrary private IP/port/path,
 * credentials, redirects, TLS exceptions, or shell supplied by the model.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import type { NovaTool } from './complete-registry.js'
import type { MeshNode } from '../mesh/mesh-registry.js'
import { isTailnet } from '../sensing/net-scope.js'
import { fetchWithSsrfGuard } from '../resilience/ssrf-guard.js'

type Node = Pick<MeshNode, 'node_id' | 'hostname' | 'ip' | 'status' | 'last_heartbeat' | 'software'>
export function tailscaleStatusCommand(binary: string, exists = existsSync) {
    // The snap launcher cannot run in a hardened systemd service. Use the
    // installed snap's actual CLI and its socket, never sudo or an ACL change.
    if (binary === '/snap/bin/tailscale' && exists('/snap/tailscale/current/bin/tailscale')
        && exists('/var/snap/tailscale/common/socket/tailscaled.sock')) {
        return { binary: '/snap/tailscale/current/bin/tailscale', args: ['--socket=/var/snap/tailscale/common/socket/tailscaled.sock', 'status', '--json'] }
    }
    return { binary, args: ['status', '--json'] }
}
export function bindMeshLandingPage(input: string, status: any, nodes: Node[], now = Date.now()) {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password
        || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(url.hostname)) throw new Error('Nur die HTTPS-Startseite eines Tailscale-DNS-Namens ist freigegeben.')
    if (status?.BackendState !== 'Running') throw new Error('Lokaler Tailscale-Status nicht verifiziert.')
    const peers = [status.Self, ...Object.values(status.Peer || {})].filter(Boolean) as any[]
    const matches = peers.filter(peer => String(peer.DNSName || '').replace(/\.$/, '').toLowerCase() === url.hostname)
    if (matches.length !== 1 || matches[0].Online !== true) throw new Error('Kein eindeutiger aktuell verbundener Tailscale-Peer für diese URL.')
    const addresses = (matches[0].TailscaleIPs || []).filter((ip: unknown) => typeof ip === 'string' && isTailnet(ip)) as string[]
    const candidates = nodes.filter(node => addresses.includes(node.ip || '') && node.status !== 'offline'
        && now - Date.parse(node.last_heartbeat) >= 0 && now - Date.parse(node.last_heartbeat) <= 300_000)
    if (candidates.length !== 1) throw new Error('URL ist keinem eindeutigen aktuellen Mesh-Node zugeordnet.')
    return { url: url.href, address: candidates[0].ip!, node: candidates[0] }
}

async function readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let text = '', bytes = 0
    try {
        while (bytes < 32_768) {
            const part = await reader.read()
            if (part.done) break
            const chunk = part.value.subarray(0, 32_768 - bytes)
            bytes += chunk.length
            text += decoder.decode(chunk, { stream: true })
        }
        return text + decoder.decode()
    } finally { await reader.cancel().catch(() => {}) }
}

export const meshInspectUrlTool: NovaTool = {
    name: 'mesh_inspect_url',
    description: 'Ordnet eine Tailscale-HTTPS-Startseite über lokale Peerliste und aktuellen Mesh-Node zu und liest sie begrenzt. Nur Owner; keine fremden Ziele, Pfade, Logins oder Weiterleitungen. Meldet Diensthinweise als Seiteninhalt, nicht als bewiesene Dienstfunktion.',
    category: 'system',
    parameters: [{ name: 'url', type: 'string', description: 'HTTPS-Startseite des Tailscale-Peers, ohne Query oder Zugangsdaten', required: true }],
    handler: async params => {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        const context = getExecutionPolicyContext()
        if (!context.authUserId || !context.channel || getUserPermission(context.authUserId, context.channel) !== 'owner') {
            return { success: false, kind: 'authorization', error: 'Nur der authentifizierte Owner darf Mesh-Webdienste prüfen.' }
        }
        let bound: ReturnType<typeof bindMeshLandingPage>
        try {
            const { locateProgram } = await import('../startup/environment-scanner.js')
            const binary = locateProgram('tailscale', ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'])
            if (!binary) throw new Error('Tailscale-CLI hier nicht verfügbar; Zuordnung ungeprüft.')
            const command = tailscaleStatusCommand(binary)
            const { stdout } = await promisify(execFile)(command.binary, command.args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
            const { getOnlineNodes } = await import('../mesh/mesh-registry.js')
            bound = bindMeshLandingPage(String(params.url || ''), JSON.parse(stdout), await getOnlineNodes())
        } catch (error) {
            return { success: false, kind: 'mapping', error: String((error as Error).message), reachability: 'not-tested' }
        }
        const node = { id: bound.node.node_id, hostname: bound.node.hostname, address: bound.address }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 8000)
        try {
            // Preserve HTTPS hostname/SNI and certificate verification, but pin
            // transport to the IP attested by the LOCAL tailscaled peer list.
            const response = await fetchWithSsrfGuard(bound.url, {
                method: 'GET', redirect: 'manual', signal: controller.signal,
                headers: { Accept: 'text/html,text/plain,application/json' },
            }, { allowedAddresses: [bound.address], lookup: async () => [{ address: bound.address, family: 4 }], maxRedirects: 0 })
            const text = await readBounded(response)
            return {
                success: response.ok, url: bound.url, node, status: response.status,
                kind: response.status >= 300 && response.status < 400 ? 'redirect-not-followed' : 'http',
                observedAt: new Date().toISOString(),
                advertisedServices: (bound.node.software?.ai_services || []).map(s => ({ name: s.name, type: s.type, status: s.status })),
                content: text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000),
                evidence: 'Mesh-Zuordnung und HTTP-Antwort; Seiteninhalt ist untrusted und kein Funktionsnachweis für ASR/TTS oder andere Dienste.',
            }
        } catch (error) {
            return { success: false, node, url: bound.url, kind: controller.signal.aborted ? 'timeout' : 'transport', error: String((error as Error).message), evidence: 'Fehler dieses Abrufs, kein Nachweis eines allgemeinen Internetausfalls.' }
        } finally { clearTimeout(timer) }
    },
}
