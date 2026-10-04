/** Isolated read-only SDK execution. No credentials in argv, environment or output. */
import { parentPort, workerData } from 'node:worker_threads'
import TuyaDevice from 'tuyapi'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { EspHomeClient } from 'esphome-client'
import { cleanText } from './ports.js'

export async function readEspHomeSdk(input: { host: string; port: number; psk: string; identity: string; action?: { functionId: string; on: boolean } }, create: (options: any) => any = options => new EspHomeClient(options), open?: (options: any) => Promise<any>, authorize: () => Promise<boolean> = async () => false): Promise<any[]> {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(input.psk) || Buffer.from(input.psk, 'base64').length !== 32 || !/^[a-zA-Z0-9_-]{1,63}$/.test(input.identity)) throw new Error('Invalid ESPHome access')
    // Pinned 2.0.0 transport integration: the public client offers a factory but
    // does not re-export Transport. No dynamic package names or network imports.
    if (!open) {
        const entry = createRequire(import.meta.url).resolve('esphome-client')
        const { Transport } = await import(new URL('./transport.js', pathToFileURL(entry)).href)
        open = options => Transport.open(options)
    }
    let transports = 0
    const client = create({ host: input.host, port: input.port, psk: input.psk, serverName: input.identity,
        reconnect: false, keepAlive: false, connectTimeoutMs: 5000, handshakeTimeoutMs: 3000,
        maxFrameBytes: 128 * 1024, maxRecvBufferBytes: 512 * 1024,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        // A second transport means plaintext fallback (or reconnect). Neither is
        // authorized by the explicitly encrypted access entered by the owner.
        transportFactory: async (options: any) => { if (++transports !== 1) throw new Error('ESPHome plaintext fallback denied'); return open!(options) },
    })
    try {
        await client.connect()
        if (!client.health().encrypted) throw new Error('ESPHome encrypted session required')
        const info = client.deviceInfo()
        if (!info || info.name !== input.identity) throw new Error('ESPHome identity changed')
        let confirmedOn: boolean | undefined
        if (input.action) {
            const a = input.action, id = /^entity:([a-zA-Z0-9_:.-]{1,80})$/.exec(a.functionId)?.[1]
            const entity = client.getEntitiesWithIds().find((e: any) => e.id === id)
            if (!id || typeof a.on !== 'boolean' || !entity || !['light', 'switch'].includes(entity.type) || !await authorize()) throw new Error('ESPHome control permission missing')
            const event = await client.commandAndAwait(id, { state: a.on }, { timeoutMs: 3000 })
            if (event?.state !== a.on) throw new Error('ESPHome output not confirmed')
            confirmedOn = a.on
        }
        const text = (value: unknown) => typeof value === 'string' ? cleanText(value.replaceAll(input.psk, '[redacted]'), 80) : ''
        return client.getEntitiesWithIds().slice(0, 200).map((entity: any) => ({
            id: `entity:${text(entity.id)}`, kind: ['light', 'switch', 'sensor', 'binary_sensor', 'fan', 'cover', 'climate', 'lock', 'media_player', 'button', 'number', 'select', 'text'].includes(entity.type) ? entity.type : 'unknown',
            name: text(entity.name || entity.objectId), manufacturer: text(info.manufacturer), model: text(info.model), available: true,
            ...(input.action?.functionId === `entity:${text(entity.id)}` && confirmedOn !== undefined ? { confirmedOn } : {}),
        }))
    } finally { client.disconnect() }
}

export async function readTuyaSdk(input: { host: string; identity: string; key: string; version: string }, create: (options: any) => any = options => new TuyaDevice(options)): Promise<Array<{ id: string; kind: 'unknown'; name: string; available: boolean }>> {
    if (!['3.1', '3.3', '3.4', '3.5'].includes(input.version) || Buffer.byteLength(input.key, 'utf8') !== 16 || !/^[a-zA-Z0-9_-]{8,64}$/.test(input.identity)) throw new Error('Invalid Tuya access')
    const device = create({ ip: input.host, id: input.identity, key: input.key, version: input.version,
        issueGetOnConnect: false, issueRefreshOnConnect: false, issueRefreshOnPing: false })
    // TuyAPI may turn failed DP_QUERY into CONTROL with null DPS. A read approval
    // must never authorize this fallback, even if the SDK describes it as a get.
    device.set = async () => { throw new Error('Read-only Tuya access rejects CONTROL') }
    device.on('error', () => {})
    try {
        await device.connect()
        const reply = await device.get({ schema: true })
        const dps = reply?.dps
        if (!dps || typeof dps !== 'object' || Array.isArray(dps)) throw new Error('No verified Tuya datapoints')
        return Object.entries(dps).filter(([id, value]) => /^\d{1,6}$/.test(id) && ['boolean', 'number', 'string'].includes(typeof value))
            .slice(0, 200).map(([id]) => ({ id: `dp:${id}`, kind: 'unknown', name: `Tuya Datenpunkt ${id} (Gerätefunktion noch ungeprüft)`, available: true }))
    } finally { device.disconnect() }
}

if (parentPort && workerData?.protocol === 'tuya') {
    readTuyaSdk(workerData).then(functions => parentPort!.postMessage({ ok: true, functions }),
        () => parentPort!.postMessage({ ok: false }))
}
if (parentPort && workerData?.protocol === 'esphome') {
    const authorize = () => new Promise<boolean>(resolve => {
        parentPort!.once('message', reply => resolve(reply?.kind === 'control-permission' && reply.ok === true))
        parentPort!.postMessage({ kind: 'control-permission' })
    })
    readEspHomeSdk(workerData, undefined, undefined, authorize).then(functions => parentPort!.postMessage({ ok: true, functions }), () => parentPort!.postMessage({ ok: false }))
}
