/**
 * Proxmox als Wahrnehmungsquelle (Phase 6c, nur lesend): Gast gestartet /
 * gestoppt und Host-RAM knapp. Der erste Lauf merkt nur die Ausgangslage.
 * Ausgabe wie jeder Adapter nur über den Bus → ThoughtSink (Gedanken-Hub);
 * keine Knöpfe, keine Aktion — Aktionen gibt es nur über /vms und Karten.
 */
import type { AdapterContext, RawEvent, SensingAdapter } from '../event-bus.js'
import { buildInventory, type ProxmoxClient, type ProxmoxGuest, type ProxmoxLimits, type ProxmoxNode } from '../../infra/proxmox.js'

export function proxmoxEvents(
    previous: Record<string, string> | undefined,
    guests: readonly ProxmoxGuest[],
    nodes: readonly ProxmoxNode[],
    options: { ramWarnPercent: number; now: number; poolMembers?: ReadonlySet<number>; limits?: ProxmoxLimits },
): { events: RawEvent[]; statuses: Record<string, string> } {
    const statuses: Record<string, string> = {}
    const events: RawEvent[] = []
    const minute = new Date(options.now).toISOString().slice(0, 16)
    for (const guest of guests) {
        if (guest.template) continue
        const key = String(guest.vmid)
        statuses[key] = guest.status
        const before = previous?.[key]
        if (!previous || !before || before === guest.status) continue
        const pool = options.poolMembers?.has(guest.vmid) === true
        const label = `${guest.type === 'qemu' ? 'VM' : 'CT'} ${guest.vmid} ${guest.name || ''}`.trim()
        const evidence = { vmid: guest.vmid, name: guest.name, knoten: guest.node, vorher: before, jetzt: guest.status, pool }
        if (guest.status === 'stopped' && before === 'running') {
            events.push({
                kind: 'proxmox.guest-stopped', subject: `pve:${guest.vmid}`, severity: 'warning',
                summary: `Proxmox: ${label} wurde gestoppt (war ${before}).`, evidence,
                dedupeKey: `pve:${guest.vmid}:stopped:${minute}`, dedupeWindowMs: 60_000,
                hint: { importance: pool ? 'hoch' : 'normal', title: `${label} gestoppt` },
            })
        } else if (guest.status === 'running') {
            events.push({
                kind: 'proxmox.guest-started', subject: `pve:${guest.vmid}`, severity: 'info',
                summary: `Proxmox: ${label} läuft wieder (war ${before}).`, evidence,
                dedupeKey: `pve:${guest.vmid}:running:${minute}`, dedupeWindowMs: 60_000,
                hint: { importance: 'niedrig', title: `${label} gestartet` },
            })
        }
    }
    for (const node of nodes) {
        if (!node.maxmem) continue
        const percent = Math.round(node.mem / node.maxmem * 100)
        if (percent < options.ramWarnPercent) continue
        const urgent = percent >= 97
        events.push({
            kind: 'proxmox.host-ram', subject: `pve-host:${node.node}`, severity: urgent ? 'urgent' : 'warning',
            summary: `Proxmox-Host ${node.node}: RAM ${percent} % belegt (${Math.round(node.mem / 1024 ** 3)} von ${Math.round(node.maxmem / 1024 ** 3)} GB).`,
            evidence: { knoten: node.node, prozent: percent, belegtGB: Math.round(node.mem / 1024 ** 3), gesamtGB: Math.round(node.maxmem / 1024 ** 3), schwelle: options.ramWarnPercent },
            dedupeKey: `pve:ram:${node.node}:${urgent ? 'kritisch' : 'knapp'}`,
            hint: { importance: urgent ? 'dringend' : 'hoch', title: `Proxmox-Host ${node.node}: RAM knapp` },
        })
    }
    if (options.limits && options.poolMembers) {
        // Self-recognition: own guests (pool + tag) against the resource cap.
        const inv = buildInventory(guests, options.poolMembers, options.limits, null)
        const share = (used: number, limit: number) => limit > 0 ? used / limit : 0
        const worst = Math.max(share(inv.usage.ramGB, inv.limits.ramGB), share(inv.usage.cores, inv.limits.cores), share(inv.usage.diskGB, inv.limits.diskGB))
        if (worst >= 0.9) {
            events.push({
                kind: 'proxmox.cap', subject: 'pve-deckel', severity: 'info',
                summary: `Eigene VMs nutzen ${Math.round(worst * 100)} % des Deckels (RAM ${inv.usage.ramGB}/${inv.limits.ramGB} GB, Kerne ${inv.usage.cores}/${inv.limits.cores}, Disk ${inv.usage.diskGB}/${inv.limits.diskGB} GB).`,
                evidence: { meineVms: inv.mine.length, ramGB: inv.usage.ramGB, kerne: inv.usage.cores, diskGB: inv.usage.diskGB },
                dedupeKey: `pve:deckel:${Math.round(worst * 10)}`,
                hint: { importance: 'normal', title: 'Proxmox-Deckel fast voll', proposal: 'Nicht mehr gebrauchte Wegwerf-VMs per /vms entfernen <vmid> vorschlagen.' },
            })
        }
    }
    return { events, statuses }
}

export function createProxmoxAdapter(deps: { client: () => Promise<ProxmoxClient | null>; ramWarnPercent: number; limits?: ProxmoxLimits; intervalMs?: number; timeoutMs?: number }): SensingAdapter {
    return {
        id: 'proxmox',
        source: 'proxmox',
        intervalMs: deps.intervalMs ?? 60_000,
        timeoutMs: deps.timeoutMs ?? 30_000,
        async poll(ctx: AdapterContext): Promise<RawEvent[]> {
            const client = await deps.client()
            if (!client) return []
            const [guests, nodes, poolMembers] = await Promise.all([
                client.listGuests(), client.listNodes(), client.poolMembers().catch(() => new Set<number>()),
            ])
            const previous = ctx.state.statuses && typeof ctx.state.statuses === 'object' ? ctx.state.statuses as Record<string, string> : undefined
            const { events, statuses } = proxmoxEvents(previous, guests, nodes, { ramWarnPercent: deps.ramWarnPercent, now: ctx.now, poolMembers, limits: deps.limits ?? client.config.limits })
            ctx.state.statuses = statuses
            return events
        },
    }
}
