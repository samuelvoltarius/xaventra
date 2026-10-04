/** Matter controller policy. The same IP controller works over LAN/WLAN and
 * routed Thread; a Thread border router remains a physical prerequisite. */
import { cleanText } from './ports.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { DirectFunction } from './direct-smart-devices.js'
export function rejectMatterAttestationFindings(): false { return false }
export function matterFunctions(peer: any): DirectFunction[] {
    if (peer?.lifecycle?.isOnline !== true) throw new Error('Matter peer not online')
    const basic = peer.maybeStateOf('basicInformation') || {}
    const text = (v: unknown) => typeof v === 'string' ? cleanText(redactSecrets(v).replace(/\b\d{11}(?:\d{10})?\b/g, '[redacted]'), 80) : undefined
    const out: DirectFunction[] = []
    const visit = (endpoint: any, depth: number) => {
        if (depth > 8 || out.length >= 200) return
        const descriptor = endpoint.maybeStateOf('descriptor')
        if (!Number.isInteger(endpoint.number) || endpoint.number < 0 || endpoint.number > 65535) return
        const types = descriptor?.deviceTypeList
        if (Array.isArray(types)) for (const type of types.slice(0, 16)) {
            const id = Number(type?.deviceType)
            if (!Number.isInteger(id) || id < 0 || id > 0xffffffff || [0x16, 0x11, 0x0e].includes(id)) continue
            const kind: DirectFunction['kind'] = [0x100, 0x101, 0x10c, 0x10d].includes(id) ? 'light'
                : [0x10a, 0x10b].includes(id) ? 'switch' : id === 0x202 ? 'cover' : id === 0x301 ? 'climate'
                    : id === 0x0a ? 'lock' : id === 0x2b ? 'fan' : 'unknown'
            out.push({ id: `endpoint:${endpoint.number}:type:${id}`, kind, name: `Matter Endpoint ${endpoint.number} · Typ 0x${id.toString(16)}`,
                manufacturer: text(basic.vendorName), model: text(basic.productName), available: true })
        }
        for (const part of endpoint.parts || []) visit(part, depth + 1)
    }
    visit(peer, 0)
    return out.slice(0, 200)
}
/** SDK seam for deterministic policy tests; real SDK is created only inside the
 * isolated, private-fabric process. Never decommission/reset other fabrics. */
export async function runMatterController(input: { host: string; port: number; identity: string; pairingCode?: string; peerId?: string; action?: { functionId: string; on: boolean } }, sdk: any, signal: AbortSignal): Promise<{ peerId: string; functions: DirectFunction[]; confirmed?: boolean }> {
    if (signal.aborted || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.identity)) throw new Error('Invalid Matter target')
    const node = await sdk.create({ ble: false, tcp: false, expectedPeerId: input.peerId, commissioningEnabled: false, ota: false })
    try {
        await node.start()
        let peer
        if (input.peerId) {
            peer = node.peers.get(input.peerId)
            if (!peer) throw new Error('Matter fabric state unavailable; no automatic re-pairing')
            await peer.act((agent: any) => { agent.commissioning.addresses = [{ type: 'udp', ip: input.host, port: input.port }] })
            await peer.start()
            // Starting a persisted peer does not refresh cached attributes when
            // autoSubscribe is false. Require an actual authenticated read.
            await sdk.refresh(peer)
        } else {
            if (!/^(?:\d{11}|\d{21})$/.test(input.pairingCode || '')) throw new Error('Private Matter manual pairing code required')
            const certificates = await sdk.certificates(node)
            // Constructor alone is not evidence that the trust store is initialized.
            await certificates.construction
            if (signal.aborted) throw new Error('Stopped')
            peer = await node.peers.forDescriptor({ deviceIdentifier: input.identity, addresses: [{ type: 'udp', ip: input.host, port: input.port }] })
            await peer.commission({ pairingCode: input.pairingCode, abort: signal, autoSubscribe: false, autoStateInitialize: true,
                onAttestationFailure: rejectMatterAttestationFindings, continueCommissioningAfterPase: () => !signal.aborted })
        }
        if (signal.aborted || typeof peer.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(peer.id)) throw new Error('Invalid Matter peer')
        const functions = matterFunctions(peer)
        let confirmed: boolean | undefined
        if (input.action) {
            const a = input.action, match = /^endpoint:(\d{1,5}):type:(\d{1,10})$/.exec(a.functionId)
            if (!input.peerId || input.pairingCode || typeof a.on !== 'boolean' || !match || !functions.some(f => f.id === a.functionId && ['light', 'switch'].includes(f.kind)) || signal.aborted) throw new Error('Matter control not authorized for this function')
            confirmed = await sdk.switch(peer, Number(match[1]), a.on)
            if (confirmed !== true) throw new Error('Matter output not confirmed')
        }
        return { peerId: peer.id, functions, ...(confirmed === undefined ? {} : { confirmed }) }
    } finally { await node.close() }
}
