import { it, expect, vi } from 'vitest'
import { runMatterController, rejectMatterAttestationFindings } from './matter-controller.js'
const input = { host: '192.168.1.21', port: 5540, identity: 'matter-device', pairingCode: '34970112332' }
function fake() {
    const command = vi.fn(), decommission = vi.fn(), close = vi.fn()
    const peer = { id: 'peer-1', lifecycle: { isOnline: true }, number: 0, parts: [{ number: 1, parts: [], maybeStateOf: () => ({ deviceTypeList: [{ deviceType: 0x100 }] }) }],
        maybeStateOf: (name: string) => name === 'basicInformation' ? { vendorName: 'Test vendor', productName: 'Test light' } : {},
        commission: vi.fn(async () => {}), start: vi.fn(async () => {}), act: vi.fn(async fn => fn({ commissioning: {} })), interaction: { read: vi.fn(async function* () { yield {} }) }, command, decommission }
    const certificates = vi.fn(async () => ({ construction: Promise.resolve() }))
    const node = { start: vi.fn(async () => {}), close, peers: { forDescriptor: vi.fn(async () => peer), get: vi.fn(() => peer) } }
    return { peer, node, command, decommission, close, certificates, sdk: { create: vi.fn(async () => node), certificates, refresh: vi.fn(async () => {}) } }
}
it('initializes certificate trust before exact-IP commissioning, rejects all attestation findings, no controls/reset', async () => {
    const f = fake(), result = await runMatterController(input, f.sdk, new AbortController().signal)
    expect(f.sdk.create).toHaveBeenCalledWith(expect.objectContaining({ ble: false, tcp: false, ota: false }))
    expect(f.certificates).toHaveBeenCalledOnce()
    expect(f.node.peers.forDescriptor).toHaveBeenCalledWith({ deviceIdentifier: input.identity, addresses: [{ type: 'udp', ip: input.host, port: input.port }] })
    expect(f.peer.commission).toHaveBeenCalledWith(expect.objectContaining({ autoSubscribe: false, onAttestationFailure: rejectMatterAttestationFindings }))
    expect(rejectMatterAttestationFindings()).toBe(false)
    expect(result.functions).toMatchObject([{ kind: 'light', manufacturer: 'Test vendor', available: true }])
    expect(f.command).not.toHaveBeenCalled(); expect(f.decommission).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
})
it('never commissions without initialized trust or retries an absent persisted peer', async () => {
    const f = fake(); f.certificates.mockResolvedValueOnce({ construction: Promise.reject(new Error('Trust unavailable')) })
    await expect(runMatterController(input, f.sdk, new AbortController().signal)).rejects.toThrow('Trust unavailable')
    expect(f.peer.commission).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
    f.node.peers.get.mockReturnValueOnce(undefined)
    await expect(runMatterController({ ...input, peerId: 'missing' }, f.sdk, new AbortController().signal)).rejects.toThrow('no automatic re-pairing')
    expect(f.peer.commission).not.toHaveBeenCalled()
})
it('resumes only the stored peer, reads actual endpoint types, and rejects stale offline cached metadata', async () => {
    const f = fake()
    await runMatterController({ ...input, peerId: 'peer-1', pairingCode: undefined }, f.sdk, new AbortController().signal)
    expect(f.peer.commission).not.toHaveBeenCalled(); expect(f.peer.start).toHaveBeenCalledOnce()
    f.peer.lifecycle.isOnline = false
    await expect(runMatterController({ ...input, peerId: 'peer-1' }, f.sdk, new AbortController().signal)).rejects.toThrow('not online')
})
it('Matter control targets only a verified light/switch on an existing fabric and requires readback', async () => {
    const f = fake(), control = vi.fn(async () => true), sdk = { ...f.sdk, switch: control }
    const target = { ...input, pairingCode: undefined, peerId: 'peer-1', action: { functionId: 'endpoint:1:type:256', on: true } }
    expect((await runMatterController(target, sdk, new AbortController().signal)).confirmed).toBe(true)
    expect(control).toHaveBeenCalledWith(f.peer, 1, true); expect(f.peer.commission).not.toHaveBeenCalled()
    await expect(runMatterController({ ...target, action: { functionId: 'endpoint:2:type:256', on: true } }, sdk, new AbortController().signal)).rejects.toThrow('not authorized')
    control.mockResolvedValueOnce(false); await expect(runMatterController(target, sdk, new AbortController().signal)).rejects.toThrow('not confirmed')
})
