/**
 * scan_now — "scan mal das Netz / die Hardware" without a slash command.
 *
 * Read-only and owner-only. Refreshes, right now:
 *  - the node profile (hardware, runtime, GPU, self-check) of this node,
 *  - the AI/service scan (what runs where; no remote SSH),
 *  - on the Main only: the read-only device discovery in the own LAN/tailnet.
 * Nothing is installed, configured or switched; findings flow into the usual
 * thoughts/watch paths.
 */
import type { NovaTool } from './complete-registry.js'

type Part = 'alles' | 'hardware' | 'dienste' | 'geraete'
const PARTS: readonly Part[] = ['alles', 'hardware', 'dienste', 'geraete']

async function isOwner(): Promise<boolean> {
    const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
    const context = getExecutionPolicyContext() as { authUserId?: string; channel?: string }
    const id = String(context.authUserId || '').trim()
    if (!id) return false
    const { getUserPermission } = await import('../users/multi-user-middleware.js')
    return getUserPermission(id, context.channel || undefined) === 'owner'
}

const settle = async <T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try { return { ok: true, value: await run() } } catch (error) { return { ok: false, error: String((error as Error)?.message || error).slice(0, 160) } }
}

export const scanNowTool: NovaTool = {
    name: 'scan_now',
    description: 'Scannt sofort (nur lesend): Hardware/Knotenprofil dieses Knotens, laufende KI-Dienste und Modelle, und am Main die Geräte im eigenen Netz (Drucker, Home Assistant, Proxmox …). Für „scan mal“, „was ist im Netz“, „welche Hardware haben wir“.',
    category: 'system' as any,
    parameters: [
        { name: 'was', type: 'string', description: 'alles (Standard) | hardware | dienste | geraete', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        if (!(await isOwner())) return { success: false, error: 'scan_now: nur der Owner darf einen Netz-/Hardware-Scan anstoßen.' }
        const wanted = String(params.was || 'alles').toLowerCase().trim() as Part
        const part: Part = PARTS.includes(wanted) ? wanted : 'alles'
        const worker = process.env.NOVA_NODE_ONLY === 'true'
        const want = (p: Part) => part === 'alles' || part === p
        const [profile, services, devices] = await Promise.all([
            want('hardware') ? settle(async () => (await import('../core/node-profile.js')).collectNodeProfile({ force: true })) : null,
            want('dienste') ? settle(async () => (await import('../mesh/ai-scanner.js')).scanAllAIServices({ forceFresh: true, skipRemoteSSH: true })) : null,
            want('geraete') && !worker ? settle(async () => (await import('../sensing/runtime.js')).runDiscoveryNow()) : null,
        ])
        const lines: string[] = ['🔎 Scan (nur lesend):']
        if (profile) {
            if (profile.ok) {
                const p: any = profile.value || {}
                const gpu = p.gpu?.name ? `, GPU ${p.gpu.name}${p.gpu.viaVllm ? ' (via vLLM)' : ''}` : ''
                lines.push(`• Hardware: Rolle ${p.role ?? '?'}, ${p.cpu?.cores ?? '?'} Kerne, ${p.ramGB ?? '?'} GB RAM${gpu}, Laufzeit ${p.runtime ?? '?'}`)
            } else lines.push(`• Hardware: fehlgeschlagen (${(profile as any).error})`)
        }
        if (services) {
            if (services.ok) {
                const list: any[] = Array.isArray((services.value as any)?.services) ? (services.value as any).services : []
                lines.push(`• Dienste: ${list.length} gefunden${list.length ? ` — ${list.slice(0, 8).map(s => `${s.name}${s.status ? ` (${s.status})` : ''}`).join(', ')}` : ''}`)
            } else lines.push(`• Dienste: fehlgeschlagen (${(services as any).error})`)
        }
        if (want('geraete')) {
            if (worker) lines.push('• Geräte: die Netz-Suche macht nur der Main.')
            else if (devices?.ok) lines.push(`• Geräte: ${String(devices.value).split('\n').slice(0, 6).join(' / ')}`)
            else if (devices) lines.push(`• Geräte: fehlgeschlagen (${(devices as any).error})`)
        }
        return { success: true, formatted: lines.join('\n') }
    },
}
