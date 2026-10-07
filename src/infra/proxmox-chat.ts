/**
 * 2.88: Proxmox per Gespräch („starte meine Test-VM“, „mach einen Snapshot vor
 * dem Update“) instead of only /vms.
 *
 * The model names an action and a VM in plain words; this module resolves the
 * VM by vmid or name (pool guests first) and hands over to the existing path:
 * `proposeProxmoxAction` → read-only checks of the adapter → ONE card → the
 * owner's Ja. Nothing here writes to Proxmox. Hard stop, reset, delete of
 * snapshots, migration, host commands stay refused (PROXMOX_NEVER).
 */
import { PROXMOX_NEVER, SNAPNAME_PATTERN, isValidVmid, loadProxmoxRuntime, type ProxmoxGuest } from './proxmox.js'
import { defaultSnapshotName, proposeProxmoxAction, type VmsDeps } from './proxmox-command.js'

export type ChatAktion = 'status' | 'starten' | 'herunterfahren' | 'snapshot' | 'zuruecksetzen' | 'snapshots'
export const CHAT_AKTIONEN: readonly ChatAktion[] = Object.freeze(['status', 'starten', 'herunterfahren', 'snapshot', 'zuruecksetzen', 'snapshots'])

// Refused outright (PROXMOX_NEVER); removing an own VM stays /vms entfernen (its own card).
const NEVER = /\b(?:hart|kill|reset|force|migrat\w*|stecker)\b|snapshots? (?:loeschen|löschen)|verkleiner/i
const FILLER = new Set(['meine', 'meinen', 'mein', 'die', 'den', 'das', 'vm', 'vms', 'maschine', 'virtuelle', 'container', 'ct', 'gast', 'server'])

const norm = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const compact = (value: string) => norm(value).split(' ').filter(word => word && !FILLER.has(word)).join('')

/** vmid, exact name, or the one guest whose name contains the words — pool guests first. */
export function findeVm(guests: readonly ProxmoxGuest[], members: ReadonlySet<number>, wunsch: string): { guest?: ProxmoxGuest; kandidaten: ProxmoxGuest[] } {
    const text = String(wunsch || '').trim()
    const id = Number((/\b(\d{3,9})\b/.exec(text) || [])[1])
    if (isValidVmid(id)) {
        const guest = guests.find(item => item.vmid === id)
        return { guest, kandidaten: guest ? [guest] : [] }
    }
    const key = compact(text)
    if (!key) return { kandidaten: [] }
    const ordered = [...guests.filter(item => members.has(item.vmid)), ...guests.filter(item => !members.has(item.vmid))].filter(item => !item.template)
    const exact = ordered.filter(item => compact(item.name) === key)
    if (exact.length) return { guest: exact.length === 1 ? exact[0] : undefined, kandidaten: exact }
    const partial = ordered.filter(item => compact(item.name).includes(key) || key.includes(compact(item.name) || '\u0000'))
    const inPool = partial.filter(item => members.has(item.vmid))
    const pick = inPool.length ? inPool : partial
    return { guest: pick.length === 1 ? pick[0] : undefined, kandidaten: pick }
}

/** A snapshot name from plain words („vor dem Update“ → vor-update-20261007-1200). */
export function snapshotName(wunsch: unknown, now: number): string {
    const slug = norm(String(wunsch || '')).split(' ').filter(word => word && !['dem', 'der', 'die', 'das', 'einen', 'ein'].includes(word)).join('-').slice(0, 24).replace(/-+$/, '')
    if (!slug) return defaultSnapshotName(now)
    const name = `${/^[a-z]/.test(slug) ? slug : `s-${slug}`}-${new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`.slice(0, 40)
    return SNAPNAME_PATTERN.test(name) ? name : defaultSnapshotName(now)
}

const NOT_SET_UP = 'Proxmox ist noch nicht verbunden. In der App unter „Verbindungen → Proxmox“ genügt ein Token (3 kurze Schritte stehen dort).'

/** One conversational request → a plain answer (reads) or ONE card (writes). */
export async function proxmoxImGespraech(input: { aktion?: unknown; vm?: unknown; snapshot?: unknown; text?: unknown }, deps: VmsDeps = {}): Promise<{ ok: boolean; text: string; cardId?: string }> {
    const aktion = String(input?.aktion || '').toLowerCase() as ChatAktion
    if (NEVER.test(`${String(input?.text || '')} ${String(input?.aktion || '')}`)) return { ok: false, text: `Das mache ich auf Proxmox nie. Nie: ${PROXMOX_NEVER.join('; ')}.` }
    if (!CHAT_AKTIONEN.includes(aktion)) return { ok: false, text: `Ich kann: ${CHAT_AKTIONEN.join(', ')}.` }
    const runtime = await (deps.runtime || (() => loadProxmoxRuntime()))()
    if (runtime.ok === false) return { ok: false, text: NOT_SET_UP }
    let guests: ProxmoxGuest[]
    let members: Set<number>
    try {
        guests = await runtime.client.listGuests()
        members = await runtime.client.poolMembers()
    } catch (error) { return { ok: false, text: runtime.client.safe((error as Error)?.message || error) } }
    const label = (guest: ProxmoxGuest) => `${guest.name || guest.vmid} (${guest.vmid}, ${guest.status === 'running' ? 'läuft' : guest.status === 'stopped' ? 'aus' : guest.status})`
    if (aktion === 'status' && !String(input?.vm || '').trim()) {
        const pool = guests.filter(guest => members.has(guest.vmid))
        return { ok: true, text: `${guests.length} Gäste auf Proxmox, ${pool.length} im Pool „${runtime.config.pool}“ (die steuere ich mit deinem Ja): ${pool.map(label).join(', ') || 'keine'}.` }
    }
    const found = findeVm(guests, members, String(input?.vm || ''))
    if (!found.guest) {
        return { ok: false, text: found.kandidaten.length > 1
            ? `Welche meinst du? ${found.kandidaten.slice(0, 6).map(label).join(', ')}.`
            : `Diese VM finde ich nicht. Im Pool: ${guests.filter(guest => members.has(guest.vmid)).map(label).join(', ') || 'keine'}.` }
    }
    const guest = found.guest
    if (aktion === 'status') return { ok: true, text: `${label(guest)}${members.has(guest.vmid) ? `, im Pool „${runtime.config.pool}“` : ' — nicht im Pool, nur lesen'}.` }
    if (aktion === 'snapshots') {
        try {
            const snaps = (await runtime.client.listSnapshots(guest)).filter(snap => snap.name !== 'current')
            return { ok: true, text: snaps.length ? `Snapshots von ${guest.name || guest.vmid}: ${snaps.map(snap => snap.name).join(', ')}.` : `${guest.name || guest.vmid} hat keine Snapshots.` }
        } catch (error) { return { ok: false, text: runtime.client.safe((error as Error)?.message || error) } }
    }
    const now = (deps.now || Date.now)()
    let result: { ok: boolean; message: string; card?: { id: string } }
    if (aktion === 'starten') result = await proposeProxmoxAction({ action: 'start', vmid: guest.vmid }, deps)
    else if (aktion === 'herunterfahren') result = await proposeProxmoxAction({ action: 'shutdown', vmid: guest.vmid }, deps)
    else if (aktion === 'snapshot') result = await proposeProxmoxAction({ action: 'snapshot', vmid: guest.vmid, snapname: snapshotName(input?.snapshot, now) }, deps)
    else {
        const wanted = String(input?.snapshot || '').trim()
        if (!wanted || !SNAPNAME_PATTERN.test(wanted)) return { ok: false, text: `Auf welchen Snapshot? Sag „Snapshots von ${guest.name || guest.vmid}“, dann zeige ich sie.` }
        result = await proposeProxmoxAction({ action: 'rollback', vmid: guest.vmid, snapname: wanted }, deps)
    }
    return { ok: result.ok, text: result.message, ...(result.card ? { cardId: result.card.id } : {}) }
}
