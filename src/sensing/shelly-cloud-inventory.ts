/** Shelly Cloud v2 selected-device read. Never account enumeration or control. */
import { createHash } from 'node:crypto'
import { boundedHaJson } from './ha-device-metadata.js'
import { validShellyCloudHost, type ShellyCloudAccess } from './smart-device-access.js'
import { parseDirectFunctions, type DirectFunction } from './direct-smart-devices.js'
// Serialize by credential digest without retaining the credential as a map key.
const gates = new Map<string, { tail: Promise<void>; next: number; users: number }>()
function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('Stopped'))
        const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new Error('Stopped')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
        signal.addEventListener('abort', stop, { once: true })
    })
}
async function shellyRequest(access: ShellyCloudAccess, signal: AbortSignal, fetchFn: typeof fetch, endpoint: 'get' | 'set/switch' | 'set/light', body: object): Promise<Response> {
    if (!validShellyCloudHost(access.host) || typeof access.key !== 'string' || !/^[a-zA-Z0-9_-]{8,512}$/.test(access.key)) throw new Error('Invalid Shelly cloud access')
    const hash = createHash('sha256').update(access.host + '\0' + access.key).digest('hex')
    let gate = gates.get(hash)
    if (!gate) { gate = { tail: Promise.resolve(), next: 0, users: 0 }; gates.set(hash, gate) }
    gate.users++
    const prior = gate.tail
    let release: () => void
    gate.tail = new Promise<void>(resolve => { release = resolve })
    try {
        await prior
        if (signal.aborted) throw new Error('Stopped')
        if (gate.next > Date.now()) await wait(gate.next - Date.now(), signal)
        gate.next = Date.now() + 1000
        return await fetchFn(`https://${access.host}/v2/devices/api/${endpoint}?auth_key=${encodeURIComponent(access.key)}`, {
            method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            // Status only: do not download Wi-Fi or account settings.
            body: JSON.stringify(body),
        })
    } catch { throw new Error('Shelly cloud read failed') }
    finally {
        release!(); gate.users--
        // Retain cooldown for sequential polls, then forget unused credential hashes.
        const saved = gate
        setTimeout(() => { if (!saved.users && gates.get(hash) === saved && saved.next <= Date.now()) gates.delete(hash) }, 1100).unref()
    }
}
export async function readShellyCloudFunctions(identity: string, access: ShellyCloudAccess, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<DirectFunction[]> {
    const id = /(?:^|-)([a-f0-9]{12})$/i.exec(identity)?.[1]?.toLowerCase()
    if (!id) throw new Error('Invalid Shelly identity')
    let body: any
    try { body = await boundedHaJson(await shellyRequest(access, signal, fetchFn, 'get', { ids: [id], select: ['status'] })) }
    catch { throw new Error('Shelly cloud read failed') }
    if (!Array.isArray(body) || body.length !== 1 || typeof body[0]?.id !== 'string' || body[0].id.toLowerCase() !== id || ![0, 1].includes(body[0].online)) throw new Error('Shelly cloud read failed: identity not confirmed')
    const status = body[0].status, mac = status?.sys?.mac || status?.mac
    if (typeof mac === 'string' && mac.replace(/:/g, '').toLowerCase() !== id) throw new Error('Shelly cloud identity changed')
    return parseDirectFunctions('shelly', status).map(f => ({ ...f, available: body[0].online === 1 }))
}

/** One selected output, no groups, timers or fallback. State read is independent. */
export async function controlShellyCloudBoolean(identity: string, functionId: string, on: boolean, access: ShellyCloudAccess, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<boolean> {
    const id = /(?:^|-)([a-f0-9]{12})$/i.exec(identity)?.[1]?.toLowerCase()
    const m = /^(switch|light|rgb|rgbw|relays|lights):(\d{1,3})$/.exec(functionId)
    if (!id || !m || typeof on !== 'boolean' || !validShellyCloudHost(access.host) || !/^[a-zA-Z0-9_-]{8,512}$/.test(access.key)) throw new Error('Invalid Shelly control')
    // Reuse serialized credential gate for the fresh read before the command.
    const functions = await readShellyCloudFunctions(identity, access, signal, fetchFn)
    if (!functions.some(f => f.id === functionId && f.available === true && ['light', 'switch'].includes(f.kind))) throw new Error('Shelly function not online')
    const kind = ['switch', 'relays'].includes(m[1]) ? 'switch' : 'light'
    const response = await shellyRequest(access, signal, fetchFn, kind === 'switch' ? 'set/switch' : 'set/light', { id, channel: Number(m[2]), on })
    // HTTP success is not evidence of the output state. Never retry a write.
    if (response.status !== 200) { await response.body?.cancel(); return false }
    await response.body?.cancel()
    const stateResponse = await shellyRequest(access, signal, fetchFn, 'get', { ids: [id], select: ['status'] })
    const data: any = await boundedHaJson(stateResponse)
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.id?.toLowerCase() !== id || data[0]?.online !== 1) return false
    const status = data[0].status
    const mac = status?.sys?.mac || status?.mac
    if (typeof mac === 'string' && mac.replace(/:/g, '').toLowerCase() !== id) return false
    if (!['relays', 'lights'].includes(m[1]) && status?.[functionId]?.id !== Number(m[2])) return false
    return (['relays', 'lights'].includes(m[1]) ? status?.[m[1]]?.[Number(m[2])]?.ison : status?.[functionId]?.output) === on
}
