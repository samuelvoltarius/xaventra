/**
 * /vms (Owner) and the Proxmox Knopf-Karten (Phase 6c).
 *
 * - `/vms` lists every guest (read only), marks this VM, the pool and
 *   "meine VMs" (pool + tag xaventra-created) with the free resource cap.
 * - Every write (`snapshot`, `start`, `stop`, `rollback`, `neu`, `wegwerf`,
 *   `vergroessern`, `entfernen`) never acts here: the adapter's read-only
 *   check runs first (pool, tag, protection, cap, host reserve) and only then
 *   a Knopf-Karte is created. The Main delivers it; the action runs only after
 *   the owner's Ja via the registered executor, which checks everything again.
 * - Workers (NOVA_NODE_ONLY=true) create no cards and execute nothing; they
 *   never talk to the owner directly.
 * - Card impact is the own kind `infra` (never "Immer erlauben"). Levels:
 *   snapshot = L1; start/shutdown/rollback/create/configure/destroy = L2.
 */
import {
    createApprovalCard, getCardExecutor, registerCardExecutor, type ApprovalCard, type CardExecutor, type CardStoreOptions,
} from '../core/approval-cards.js'
import {
    CREATED_TAG, PROXMOX_ACTIONS, PROXMOX_NEVER, SNAPNAME_PATTERN, actionForKind, decodeActionRef, encodeActionRef,
    isOwnCreated, isValidVmid, loadProxmoxRuntime, renderOwnVmCloudInit,
    type CreateSpec, type ProxmoxActionInput, type ProxmoxGuest, type ProxmoxInventory, type ProxmoxNode, type ProxmoxRuntime, type ProxmoxWriteAction, type ResizeSpec,
} from './proxmox.js'

export interface VmsDeps {
    runtime?: () => Promise<ProxmoxRuntime>
    cardOpts?: CardStoreOptions
    /** vmid of this node if it runs on the configured Proxmox (node profile). */
    selfVmid?: () => Promise<number | null>
    nodeOnly?: boolean
    now?: () => number
}

const isWorker = (deps: VmsDeps) => deps.nodeOnly ?? process.env.NOVA_NODE_ONLY === 'true'
const runtimeOf = (deps: VmsDeps) => (deps.runtime || (() => loadProxmoxRuntime()))()
const selfOf = (deps: VmsDeps) => (deps.selfVmid || defaultSelfVmid)().catch(() => null)

async function defaultSelfVmid(): Promise<number | null> {
    try {
        const { collectNodeProfile } = await import('../core/node-profile.js')
        const profile = await collectNodeProfile()
        return profile.virtualization?.platform === 'proxmox' ? profile.virtualization.vmid ?? null : null
    } catch { return null }
}

// ---------------------------------------------------------------------------
// Overview (read only)
// ---------------------------------------------------------------------------

export interface VmsInventoryView {
    ok: boolean
    reason?: string
    pool?: string
    usage?: ProxmoxInventory['usage']
    free?: ProxmoxInventory['free']
    limits?: ProxmoxInventory['limits']
    nodes?: Array<{ node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; uptime: number }>
    guests?: Array<{ vmid: number; name: string; type: string; node: string; status: string; maxcpu: number; maxmem: number; maxdisk: number; uptime: number; template: boolean; eigene: boolean; selbst: boolean }>
}

/** Same read path as `/vms` for the Desktop app: typed, no token, no host fingerprint, no write. */
export async function readVmsInventory(deps: VmsDeps = {}): Promise<VmsInventoryView> {
    if (isWorker(deps)) return { ok: false, reason: 'Proxmox nur auf dem Main' }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return { ok: false, reason: runtime.reason }
    try {
        const selfVmid = await selfOf(deps)
        const inv = await runtime.client.inventory(selfVmid)
        const mine = new Set(inv.mine.map(guest => guest.vmid))
        return {
            ok: true, pool: runtime.config.pool, usage: inv.usage, free: inv.free, limits: inv.limits,
            nodes: inv.nodes.map(node => ({ node: node.node, status: node.status, cpu: node.cpu, maxcpu: node.maxcpu, mem: node.mem, maxmem: node.maxmem, uptime: node.uptime })),
            guests: inv.guests.map(guest => ({
                vmid: guest.vmid, name: guest.name, type: guest.type, node: guest.node, status: guest.status,
                maxcpu: guest.maxcpu, maxmem: guest.maxmem, maxdisk: guest.maxdisk, uptime: guest.uptime, template: guest.template,
                eigene: mine.has(guest.vmid), selbst: selfVmid !== null && guest.vmid === selfVmid,
            })),
        }
    } catch (error) {
        return { ok: false, reason: runtime.client.safe((error as Error)?.message || error) }
    }
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)
const STATUS_ICON: Record<string, string> = { running: '🟢', stopped: '⚫', paused: '⏸️' }

export function formatInventoryLine(inv: Pick<ProxmoxInventory, 'usage' | 'limits' | 'free' | 'mine' | 'self'>): string {
    return `Meine VMs (Pool + Tag ${CREATED_TAG}): ${inv.mine.length}${inv.mine.length ? ` (${inv.mine.map(g => g.vmid).join(', ')})` : ''} · Deckel RAM ${inv.usage.ramGB}/${inv.limits.ramGB} GB, Kerne ${inv.usage.cores}/${inv.limits.cores}, Disk ${inv.usage.diskGB}/${inv.limits.diskGB} GB · frei: ${inv.free.ramGB} GB RAM, ${inv.free.cores} Kerne, ${inv.free.diskGB} GB Disk${inv.self ? ` · diese VM: ${inv.self.vmid} ${inv.self.name}` : ''}`
}

export function formatVmsOverview(input: { guests: ProxmoxGuest[]; nodes: ProxmoxNode[]; poolMembers: Set<number>; pool: string; selfVmid: number | null; inventory?: ProxmoxInventory }): string {
    const lines = [`*Proxmox-Gäste* (nur lesend; Aktionen nur im Pool „${input.pool}“ und nur per Karte)`]
    for (const node of input.nodes) {
        const ram = node.maxmem ? Math.round(node.mem / node.maxmem * 100) : 0
        lines.push(`Host *${node.node}*: ${node.status}, CPU ${Math.round(node.cpu * 100)} % von ${node.maxcpu} Kernen, RAM ${gb(node.mem)}/${gb(node.maxmem)} GB (${ram} %)`)
    }
    if (input.inventory) lines.push(formatInventoryLine(input.inventory))
    if (!input.guests.length) lines.push('', 'Keine Gäste sichtbar (VM.Audit fehlt?).')
    for (const guest of input.guests) {
        const marks = [
            input.poolMembers.has(guest.vmid) ? `Pool ${input.pool}` : 'fremd, nur lesen',
            isOwnCreated(guest, input.poolMembers) ? 'meine' : '',
            guest.vmid === input.selfVmid ? '← diese VM (Xaventra)' : '',
            guest.template ? 'Vorlage' : '',
        ].filter(Boolean).join(' · ')
        const res = guest.status === 'running'
            ? `CPU ${Math.round(guest.cpu * 100)} %/${guest.maxcpu}, RAM ${gb(guest.mem)}/${gb(guest.maxmem)} GB`
            : `RAM max ${gb(guest.maxmem)} GB`
        const disk = guest.maxdisk ? `, Disk ${guest.disk ? `${gb(guest.disk)}/` : ''}${gb(guest.maxdisk)} GB` : ''
        lines.push(`${STATUS_ICON[guest.status] || '❔'} *${guest.vmid}* ${guest.name || '—'} (${guest.type === 'qemu' ? 'VM' : 'CT'}, ${guest.node}) ${guest.status} — ${res}${disk} — ${marks}`)
    }
    lines.push('', 'Karten: /vms snapshot|start|stop <vmid> · /vms rollback <vmid> <snap> · /vms neu <name> [kerne] [ramGB] [diskGB] [vorlage <vmid>] · /vms wegwerf <zweck> · /vms vergroessern <vmid> kerne=N ram=GB disk=GB · /vms entfernen <vmid> · /vms hilfe')
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export function defaultSnapshotName(now: number): string {
    return `xv-${new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`
}

/** Input as typed by the owner; create may leave vmid open (next free id). */
export type ProposeInput =
    | { action: 'start' | 'shutdown' | 'destroy'; vmid: number }
    | { action: 'snapshot'; vmid: number; snapname?: string }
    | { action: 'rollback'; vmid: number; snapname: string }
    | { action: 'create'; vmid?: number; spec: CreateSpec; titel?: string; zweck?: string }
    | { action: 'configure'; vmid: number; spec: ResizeSpec }

export async function proposeProxmoxAction(input: ProposeInput, deps: VmsDeps = {}): Promise<{ ok: boolean; message: string; card?: ApprovalCard }> {
    if (isWorker(deps)) return { ok: false, message: 'Proxmox-Karten gibt es nur am Main (Worker senden nichts an den Owner).' }
    const cls = PROXMOX_ACTIONS[input?.action as ProxmoxWriteAction]
    if (!cls) return { ok: false, message: 'Unbekannte Aktion.' }
    if (input.action !== 'create' && !isValidVmid(input.vmid)) return { ok: false, message: 'Ungültige vmid (Zahl ab 100).' }
    if (input.action === 'snapshot' || input.action === 'rollback') {
        const snapname = input.action === 'snapshot' ? (input.snapname || defaultSnapshotName((deps.now || Date.now)())) : input.snapname
        if (!snapname || !SNAPNAME_PATTERN.test(snapname)) return { ok: false, message: 'Snapshot-Name: Buchstabe am Anfang, dann Buchstaben/Ziffern/_/-, 2–40 Zeichen.' }
        input = { ...input, snapname } as ProposeInput
    }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return { ok: false, message: `Proxmox aus: ${runtime.reason}` }
    const selfVmid = await selfOf(deps)
    let action: ProxmoxActionInput
    try {
        action = input.action === 'create'
            ? { action: 'create', vmid: input.vmid ?? await runtime.client.nextId(), spec: input.spec }
            : input as ProxmoxActionInput
    } catch (error) { return { ok: false, message: runtime.client.safe((error as Error)?.message || error) } }
    let check: Awaited<ReturnType<typeof runtime.client.checkAction>>
    try { check = await runtime.client.checkAction(action, { selfVmid }) } catch (error) { return { ok: false, message: runtime.client.safe((error as Error)?.message || error) } }
    if (check.ok === false) return { ok: false, message: `${check.message} Keine Karte.` }
    registerProxmoxCardExecutors(deps)
    const ref = encodeActionRef(action)
    const guest = check.guest
    const subject = action.action === 'create' ? `${action.vmid} ${action.spec.name}` : `${action.vmid} ${guest?.name || ''}`.trim()
    const titel = input.action === 'create' && input.titel ? input.titel : `${cls.label}: ${subject}`
    const result = createApprovalCard({
        art: 'proxmox',
        titel,
        beleg: [
            guest ? `Gast ${guest.vmid} (${guest.type === 'qemu' ? 'VM' : 'CT'} ${guest.name || '—'}) auf ${guest.node}, Status ${guest.status}, Pool ${runtime.config.pool}, Tags ${guest.tags.join(',') || '—'}.` : `Neue VM ${action.vmid} auf ${check.node?.node || '?'}.`,
            input.action === 'create' && input.zweck ? `Zweck: ${input.zweck}.` : '',
            check.detail,
            `Stufe ${cls.level}, Wirkung ${cls.effect}.`,
        ].filter(Boolean).join(' '),
        vorschlag: `${cls.label}. Rückweg: ${cls.rueckweg}`,
        aktion: { kind: cls.kind, ref },
        wirkung: 'infra',
        effects: [cls.effect],
        ablaufMs: 2 * 60 * 60_000,
        dedupeKey: `proxmox:${action.action}:${action.action === 'create' ? action.spec.name : ref}`,
        quelle: 'proxmox',
    }, deps.cardOpts)
    if (result.ok === false) return { ok: false, message: `Keine Karte: ${result.reason}` }
    return {
        ok: true, card: result.card,
        message: result.created
            ? `🔘 Karte erstellt (${cls.label}, ${subject}, Stufe ${cls.level}). Ausgeführt wird erst nach deinem Ja.`
            : `🔘 Diese Karte liegt schon offen (${subject}).`,
    }
}

/** Self-recognition → proposal: "Wegwerf-VM für Test X anlegen?" (L2 card). */
export async function suggestThrowawayVm(zweck: string, deps: VmsDeps = {}, size: Partial<Omit<CreateSpec, 'name'>> = {}): Promise<{ ok: boolean; message: string; card?: ApprovalCard }> {
    const clean = String(zweck || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80)
    if (!clean) return { ok: false, message: 'Bitte einen Zweck angeben, z. B. /vms wegwerf Test Mailserver' }
    const slug = clean.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'test'
    return proposeProxmoxAction({
        action: 'create', titel: `Wegwerf-VM für „${clean}“ anlegen?`, zweck: clean,
        spec: { name: `wegwerf-${slug}`.slice(0, 40).replace(/-+$/, ''), cores: size.cores ?? 2, memoryMB: size.memoryMB ?? 4096, diskGB: size.diskGB ?? 32, ...(size.template ? { template: size.template } : {}) },
    }, deps)
}

/** Executors for the Proxmox kinds. Registered once (idempotent). */
export function createProxmoxCardExecutor(action: ProxmoxWriteAction, deps: VmsDeps = {}): CardExecutor {
    return {
        kind: PROXMOX_ACTIONS[action].kind,
        impact: 'infra',
        allowAlways: () => false,
        async execute(card) {
            if (isWorker(deps)) return { ok: false, message: 'Worker führen keine Proxmox-Aktionen aus.' }
            if (actionForKind(card.aktion.kind) !== action) return { ok: false, message: 'Aktionsart passt nicht — nichts ausgeführt.' }
            const input = decodeActionRef(action, card.aktion.ref)
            if (!input) return { ok: false, message: 'Ungültige Karten-Referenz — nichts ausgeführt.' }
            const runtime = await runtimeOf(deps)
            if (runtime.ok === false) return { ok: false, message: `Proxmox aus: ${runtime.reason} — nichts ausgeführt.` }
            const result = await runtime.client.executeAction({ ...input, note: card.id }, { selfVmid: await selfOf(deps) })
            return { ok: result.ok, message: result.message }
        },
        async reject() { return { ok: true, message: 'Abgelehnt — an Proxmox wurde nichts gesendet.' } },
        // 2.89: closed when the reference no longer decodes. The guest itself lives on the Proxmox
        // host; pool/tag/protection/cap are re-read before the single write (never from the card).
        isStillOpen(card) { return actionForKind(card.aktion.kind) === action && decodeActionRef(action, card.aktion.ref) !== null },
    }
}

export function registerProxmoxCardExecutors(deps: VmsDeps = {}, options: { force?: boolean } = {}): void {
    for (const action of Object.keys(PROXMOX_ACTIONS) as ProxmoxWriteAction[]) {
        if (!options.force && getCardExecutor(PROXMOX_ACTIONS[action].kind)) continue
        registerCardExecutor(createProxmoxCardExecutor(action, deps))
    }
}

// ---------------------------------------------------------------------------
// /vms
// ---------------------------------------------------------------------------

const SIMPLE_WORDS: Record<string, 'start' | 'shutdown' | 'destroy'> = {
    start: 'start', starten: 'start',
    stop: 'shutdown', stoppen: 'shutdown', shutdown: 'shutdown', herunterfahren: 'shutdown',
    entfernen: 'destroy', loeschen: 'destroy', 'löschen': 'destroy', delete: 'destroy', destroy: 'destroy',
}
const NEVER_WORDS = /^(reset|kill|hart|migrate|migrieren|exec|shell|host|firewall|netz|bridge|snapshot-delete|delsnapshot|verkleinern|shrink)$/

function parseResize(parts: string[]): ResizeSpec | null {
    const spec: ResizeSpec = {}
    for (const part of parts) {
        const match = /^(kerne|cores|cpu|ram|memory|disk)=(\d{1,5})$/i.exec(part)
        if (!match) return null
        const n = Number(match[2])
        const key = match[1].toLowerCase()
        if (key === 'kerne' || key === 'cores' || key === 'cpu') spec.cores = n
        else if (key === 'ram' || key === 'memory') spec.memoryMB = n * 1024
        else spec.diskGB = n
    }
    return spec
}

export async function handleVmsCommand(args: string, deps: VmsDeps = {}): Promise<string> {
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] || '').toLowerCase()
    const answer = (result: { ok: boolean; message: string }) => result.ok ? result.message : `❌ ${result.message}`
    if (sub && NEVER_WORDS.test(sub)) return `⛔ „${sub}“ macht Xaventra auf Proxmox nie.\nNie: ${PROXMOX_NEVER.join('; ')}.`
    if (sub === 'hilfe' || sub === 'help') {
        return ['/vms — alle Gäste (lesend) · /vms meine — eigene VMs und freier Deckel · /vms snapshots <vmid>',
            '/vms snapshot <vmid> [name] — Karte (L1)', '/vms start|stop <vmid> · /vms rollback <vmid> <snap> — Karte (L2)',
            '/vms neu <name> [kerne] [ramGB] [diskGB] [vorlage <vmid>] · /vms wegwerf <zweck> — Karte (L2), Pool + Tag xaventra-created, Netz vmbr0',
            '/vms vergroessern <vmid> kerne=N ram=GB disk=GB — Karte (L2), nur größer, mit Deckel',
            '/vms entfernen <vmid> — Karte (L2), nur Tag xaventra-created, nie protection=1, nie diese VM',
            '/vms cloudinit — cloud-init-Snippet für eigene VMs (Benutzer nova, sudo ohne Passwort) zum Ablegen auf dem Host',
            `Nie: ${PROXMOX_NEVER.join('; ')}.`].join('\n')
    }
    if (SIMPLE_WORDS[sub]) {
        const vmid = Number(parts[1])
        if (!isValidVmid(vmid)) return `Bitte vmid angeben, z. B. /vms ${sub} 150`
        return answer(await proposeProxmoxAction({ action: SIMPLE_WORDS[sub], vmid }, deps))
    }
    if (sub === 'snapshot' || sub === 'rollback' || sub === 'zurueckrollen') {
        const vmid = Number(parts[1])
        if (!isValidVmid(vmid)) return `Bitte vmid angeben, z. B. /vms ${sub} 150`
        if (sub === 'snapshot') return answer(await proposeProxmoxAction({ action: 'snapshot', vmid, snapname: parts[2] }, deps))
        if (!parts[2]) return 'Bitte Snapshot-Namen angeben (/vms snapshots <vmid> zeigt sie).'
        return answer(await proposeProxmoxAction({ action: 'rollback', vmid, snapname: parts[2] }, deps))
    }
    if (sub === 'neu' || sub === 'anlegen' || sub === 'create') {
        const name = String(parts[1] || '').toLowerCase()
        const rest = parts.slice(2)
        const templateIndex = rest.findIndex(part => /^(vorlage|template|klon)$/i.test(part))
        const template = templateIndex >= 0 ? Number(rest[templateIndex + 1]) : undefined
        const numbers = (templateIndex >= 0 ? rest.slice(0, templateIndex) : rest).map(Number)
        if (numbers.some(n => !Number.isInteger(n))) return 'Format: /vms neu <name> [kerne] [ramGB] [diskGB] [vorlage <vmid>]'
        const spec: CreateSpec = { name, cores: numbers[0] ?? 2, memoryMB: (numbers[1] ?? 4) * 1024, diskGB: numbers[2] ?? 32, ...(template !== undefined ? { template } : {}) }
        return answer(await proposeProxmoxAction({ action: 'create', spec }, deps))
    }
    if (sub === 'wegwerf') return answer(await suggestThrowawayVm(parts.slice(1).join(' '), deps))
    if (sub === 'vergroessern' || sub === 'vergrößern' || sub === 'resize') {
        const vmid = Number(parts[1])
        const spec = parseResize(parts.slice(2))
        if (!isValidVmid(vmid) || !spec) return 'Format: /vms vergroessern <vmid> kerne=4 ram=8 disk=64'
        return answer(await proposeProxmoxAction({ action: 'configure', vmid, spec }, deps))
    }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return `Proxmox ist aus: ${runtime.reason}. Einrichtung: docs/PROXMOX.md`
    try {
        if (sub === 'snapshots') {
            const vmid = Number(parts[1])
            if (!isValidVmid(vmid)) return 'Bitte vmid angeben, z. B. /vms snapshots 150'
            const guest = (await runtime.client.listGuests()).find(item => item.vmid === vmid)
            if (!guest) return `Gast ${vmid} nicht gefunden.`
            const snaps = await runtime.client.listSnapshots(guest)
            if (!snaps.length) return `Gast ${vmid}: keine Snapshots.`
            return [`*Snapshots von ${vmid}* (${guest.name || guest.type})`, ...snaps.map(snap =>
                `• ${snap.name}${snap.snaptime ? ` — ${new Date(snap.snaptime * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}${snap.description ? ` — ${snap.description}` : ''}`)].join('\n')
        }
        if (sub === 'cloudinit') {
            if (!runtime.config.create.sshKeys) return 'infra.proxmox.create.sshKeys ist leer — erst den Owner-SSH-Schlüssel (öffentlich) eintragen.'
            return [
                'Snippet für eigene VMs (Benutzer nova, sudo ohne Passwort, Gruppen sudo/docker, Europe/Vienna). Nur öffentliche Schlüssel.',
                'Einmal auf dem Proxmox-Host ablegen als /var/lib/vz/snippets/xaventra-nova.yaml (Storage local mit Inhaltstyp snippets),',
                'dann infra.proxmox.create.cicustom = "user=local:snippets/xaventra-nova.yaml". Xaventra legt die Datei NICHT selbst ab (kein Host-Zugriff).',
                '', renderOwnVmCloudInit(runtime.config.create.sshKeys),
            ].join('\n')
        }
        if (sub && !['status', 'liste', 'list', 'meine', 'mine'].includes(sub)) return `Unbekannt: /vms ${sub}. /vms hilfe zeigt alles.`
        const selfVmid = await selfOf(deps)
        const inv = await runtime.client.inventory(selfVmid)
        if (sub === 'meine' || sub === 'mine') {
            return [formatInventoryLine(inv), ...inv.mine.map(guest => `• ${guest.vmid} ${guest.name} — ${guest.status}, ${guest.maxcpu} Kerne, ${gb(guest.maxmem)} GB RAM, ${gb(guest.maxdisk)} GB Disk`)].join('\n')
        }
        return formatVmsOverview({ guests: inv.guests, nodes: inv.nodes, poolMembers: inv.members, pool: runtime.config.pool, selfVmid, inventory: inv })
    } catch (error) {
        return `❌ ${runtime.client.safe((error as Error)?.message || error)}`
    }
}

