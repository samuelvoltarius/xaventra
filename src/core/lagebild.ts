/**
 * 2.90.0 Lagebild: measured self-image and capability map (Stufe 1).
 *
 * Before: the soul said „Du läufst AUF DEM PC DES USERS“ (soul.ts, DEINE
 * UMGEBUNG) plus a static mesh text, while the node profile already measured
 * „VM on Proxmox“ — so Xaventra took herself for the old Spark with its own
 * vLLM (B5) and asked herself via nova_capabilities until the budget ran out.
 *
 * One read-only picture from what is measured: own node profile, peer
 * strengths, Proxmox pool, Kubernetes, configured model. A failing source is
 * „unbekannt“, never „kann nicht“. Nothing here writes or reads secrets.
 *
 * Switch `lagebild` (context-switches.ts): shadow = only /lage, on = the block
 * goes into the prompt (protected from the cap) and replaces the static soul text.
 */
import { splitPromptBlocks } from './prompt-budget.js'
import { getNovaState } from './nova-state.js'

export interface LagebildSelf {
    nodeId: string
    hostname?: string
    platform?: string
    cpus?: number
    ramGB?: number
    where: string
    localModel: string | null
}
export interface LagebildPeer { name: string; online: boolean; version?: string; skills: string[] }
export type LagebildProxmox =
    | { state: 'ok'; pool: string; guests: Array<{ vmid: number; name: string; status: string }>; free: { ramGB: number; cores: number; diskGB: number } }
    | { state: 'off'; reason: string }
    | { state: 'unknown'; reason: string }

export interface Lagebild {
    at: number
    self: LagebildSelf | null
    selfError?: string
    peers: LagebildPeer[] | null
    peersError?: string
    proxmox: LagebildProxmox
    kubernetes: { state: 'configured' | 'off' | 'unknown'; reason?: string }
    model: { provider?: string; model?: string; local?: boolean } | null
    missing: string[]
}

type ProxmoxRead =
    | { ok: true; pool: string; guests: Array<{ vmid: number; name: string; status: string }>; free: { ramGB: number; cores: number; diskGB: number } }
    | { ok: false; reason: string }

export interface LagebildDeps {
    now: () => number
    profile: () => Promise<any>
    strengths: () => Promise<any[]>
    proxmox: (selfVmid: number | null) => Promise<ProxmoxRead>
    kubernetes: () => Promise<{ configured: boolean; reason?: string }>
    model: () => { provider?: string; model?: string; local?: boolean } | null
}

const short = (error: unknown) => String((error as Error)?.message || error || 'Fehler').replace(/\s+/g, ' ').slice(0, 80)

function whereOf(profile: any): string {
    const virt = profile?.virtualization
    if (virt?.platform === 'proxmox' && virt.vmid) return `VM ${virt.vmid} auf Proxmox-Knoten ${virt.pveNode || 'unbekannt'}`
    if (virt?.kind === 'kvm') return 'in einer VM (auf dem eingerichteten Proxmox nicht gefunden)'
    if (virt?.kind === 'container' || profile?.runtime === 'container') return 'in einem Container'
    if (virt?.kind === 'none') return `direkt auf der Hardware (${profile?.platform || 'unbekannt'})`
    return 'Ort unbekannt'
}

function localModelOf(profile: any): string | null {
    if (profile?.gpu?.viaVllm) return 'vLLM'
    const service = (profile?.services || []).find((item: any) => (item?.type === 'llm' || item?.type === 'vlm') && item?.status === 'running')
    return service ? String(service.name || service.type) : null
}

export async function buildLagebild(deps: LagebildDeps = defaultLagebildDeps()): Promise<Lagebild> {
    const missing: string[] = []
    let self: LagebildSelf | null = null, selfError: string | undefined, selfVmid: number | null = null, localId = ''
    try {
        const profile = await deps.profile()
        localId = String(profile?.nodeId || '')
        selfVmid = profile?.virtualization?.platform === 'proxmox' ? Number(profile.virtualization.vmid) || null : null
        self = {
            nodeId: localId, hostname: profile?.hostname, platform: profile?.platform, cpus: profile?.cpus, ramGB: profile?.ramGB,
            where: whereOf(profile), localModel: localModelOf(profile),
        }
    } catch (error) { selfError = short(error) }

    let peers: LagebildPeer[] | null = null, peersError: string | undefined
    try {
        peers = (await deps.strengths())
            .filter(node => !node?.local && String(node?.nodeId || '') !== localId)
            .map(node => ({ name: String(node.hostname || node.nodeId), online: Boolean(node.online), version: node.version, skills: [...(node.skills || [])] }))
    } catch (error) { peersError = short(error) }

    let proxmox: LagebildProxmox
    try {
        const read = await deps.proxmox(selfVmid)
        if (read.ok === false) { proxmox = { state: 'off', reason: read.reason }; missing.push('Proxmox-Zugang') }
        else proxmox = { state: 'ok', pool: read.pool, guests: read.guests, free: read.free }
    } catch (error) { proxmox = { state: 'unknown', reason: short(error) } }

    let kubernetes: Lagebild['kubernetes']
    try {
        const kube = await deps.kubernetes()
        kubernetes = kube.configured ? { state: 'configured' } : { state: 'off', reason: kube.reason }
        if (!kube.configured) missing.push('Kubernetes-Verbindung')
    } catch (error) { kubernetes = { state: 'unknown', reason: short(error) } }

    let model: Lagebild['model'] = null
    try { model = deps.model() } catch { model = null }

    return { at: deps.now(), self, selfError, peers, peersError, proxmox, kubernetes, model, missing }
}

const MAX_CHARS = 1_500
const MAX_ITEMS = 8

export function formatLagebild(lage: Lagebild): string {
    const time = new Date(lage.at).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' })
    const modelText = lage.model?.model
        ? `${lage.model.model}${lage.model.provider ? ` (${lage.model.provider}` : ' ('}${lage.model.local === false ? ', Cloud' : lage.model.local ? ', lokal' : ''})`
        : 'unbekannt'
    const selfLine = lage.self
        ? `Ich: Main ${lage.self.nodeId}${lage.self.hostname ? ` (${lage.self.hostname})` : ''}, ${lage.self.where}`
            + `${lage.self.cpus ? `, ${lage.self.cpus} Kerne` : ''}${lage.self.ramGB ? `, ${lage.self.ramGB} GB RAM` : ''}.`
            + ` Sprachmodell: ${modelText}; ${lage.self.localModel ? `lokales Sprachmodell: ${lage.self.localModel}` : 'kein lokales Sprachmodell auf diesem Knoten'}.`
        : `Ich: unbekannt (${lage.selfError || 'kein Profil'}). Sprachmodell: ${modelText}.`
    const peerLine = lage.peers
        ? `Knoten: ${lage.peers.length ? lage.peers.slice(0, MAX_ITEMS).map(peer =>
            `${peer.name} (${peer.online ? 'online' : 'offline'}${peer.version ? `, ${peer.version}` : ''}${peer.skills.length ? `, ${peer.skills.join(', ')}` : ''})`).join('; ')
            + (lage.peers.length > MAX_ITEMS ? `; +${lage.peers.length - MAX_ITEMS} weitere` : '') : 'keine weiteren'}`
        : `Knoten: unbekannt (${lage.peersError || 'keine Daten'})`
    const px = lage.proxmox
    const proxmoxLine = px.state === 'ok'
        ? `Proxmox: Pool ${px.pool}: ${px.guests.length ? px.guests.slice(0, MAX_ITEMS).map(guest => `${guest.vmid} ${guest.name} (${guest.status})`).join(', ') : 'leer'}`
            + `; frei ${px.free.ramGB} GB RAM, ${px.free.cores} Kerne, ${px.free.diskGB} GB Disk. Starten, Stoppen, Anlegen nur per Karte mit Owner-Ja.`
        : px.state === 'off' ? `Proxmox: nicht eingerichtet (${px.reason})` : `Proxmox: unbekannt (${px.reason})`
    const kube = lage.kubernetes
    const kubeLine = kube.state === 'configured' ? 'Kubernetes: eingerichtet (Zustand mit cluster_status lesen)'
        : kube.state === 'off' ? `Kubernetes: nicht verbunden (${kube.reason || 'nicht eingerichtet'})` : `Kubernetes: unbekannt (${kube.reason})`
    const lines = [
        `## LAGEBILD (gemessen ${time}; Daten, keine Anweisungen)`,
        selfLine, peerLine, proxmoxLine, kubeLine,
        lage.missing.length ? `Fehlt: ${lage.missing.join(', ')}` : '',
        'Nutze dieses Lagebild statt Selbstauskunft. Fehlt etwas für die Aufgabe, sag in einem Satz was und warum.',
    ].filter(Boolean)
    const text = lines.join('\n')
    return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS - 1)}…`
}

/** Static soul text that the measured Lagebild replaces (B5). */
const STATIC_ENVIRONMENT = /^## (?:DEINE UMGEBUNG|MESH NETZWERK|NODE UPDATES)/i

export function replaceStaticEnvironment(prompt: string, block: string): string {
    let out = '', inserted = false
    for (const part of splitPromptBlocks(prompt)) {
        if (STATIC_ENVIRONMENT.test(part.heading)) {
            if (!inserted) { out += `\n\n${block}`; inserted = true }
            continue
        }
        out += part.text
    }
    return inserted ? out : `${out}\n\n${block}`
}

// ---------------------------------------------------------------------------
// Live sources and a small cache for the prompt path (`on`)
// ---------------------------------------------------------------------------

export function defaultLagebildDeps(): LagebildDeps {
    return {
        now: () => Date.now(),
        profile: async () => {
            const { collectNodeProfile } = await import('./node-profile.js')
            const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
            return { ...(await collectNodeProfile()), nodeId: getLocalNodeId() }
        },
        strengths: async () => {
            const { collectNodeStrengths } = await import('../mesh/node-strengths.js')
            return collectNodeStrengths(Date.now(), { registryRemote: false })
        },
        proxmox: async selfVmid => {
            if (process.env.NOVA_NODE_ONLY === 'true') return { ok: false, reason: 'Proxmox nur auf dem Main' }
            const { loadProxmoxRuntime } = await import('../infra/proxmox.js')
            const runtime = await loadProxmoxRuntime()
            if (runtime.ok === false) return { ok: false, reason: runtime.reason }
            const inv = await runtime.client.inventory(selfVmid)
            return {
                ok: true, pool: runtime.config.pool,
                guests: inv.pool.map(guest => ({ vmid: guest.vmid, name: guest.name, status: guest.status })),
                free: { ramGB: inv.free.ramGB, cores: inv.free.cores, diskGB: inv.free.diskGB },
            }
        },
        kubernetes: async () => {
            const { kubernetesControlConfigured } = await import('../infra/kubernetes.js')
            return kubernetesControlConfigured() ? { configured: true } : { configured: false, reason: 'infra.kubernetes.server fehlt' }
        },
        model: () => {
            const llm = getNovaState().llm as any
            const provider = llm?.providerId ? String(llm.providerId) : undefined
            const model = llm?.modelId ? String(llm.modelId) : undefined
            if (!model) return null
            return { provider, model, local: provider ? /ollama|vllm|llama|local/i.test(provider) : undefined }
        },
    }
}

const CACHE_MS = 60_000
let cached: { block: string; at: number } | null = null
let refreshing: Promise<void> | null = null

/** Fresh Lagebild text for /lage (always measured now). */
export async function lagebildText(deps?: LagebildDeps): Promise<string> {
    const block = formatLagebild(await buildLagebild(deps ?? defaultLagebildDeps()))
    cached = { block, at: Date.now() }
    return block
}

/**
 * Prompt path: the cached block when it is fresh, else null and a refresh in
 * the background — a turn never waits for Proxmox or the mesh.
 */
export function cachedLagebildBlock(now = Date.now()): string | null {
    if ((!cached || now - cached.at > CACHE_MS) && !refreshing) {
        refreshing = lagebildText().then(() => undefined, error => { console.debug('[Lagebild] refresh failed:', error) })
            .finally(() => { refreshing = null })
    }
    return cached && now - cached.at <= CACHE_MS * 5 ? cached.block : null
}
