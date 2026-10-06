import type { DeviceRecord } from './device-registry.js'
import type { SwitchAction } from './smart-control.js'
import { ownSubnets, scanTargetAllowed, type InterfaceMap } from './net-scope.js'
import { verifyHardwareConnection } from './hardware-recognition.js'
import { boundedHaJson } from './ha-device-metadata.js'
import { hueKey } from './direct-smart-devices.js'
import { approvedSmartRoute } from './smart-device-route.js'
import { getEspHomeAccess, getMatterAccess, getTuyaCloudAccess, getShellyCloudAccess, matterFabricPath } from './smart-device-access.js'
import { readLocalEspHome } from './smart-native-client.js'
import { readMatterPeer } from './matter-client.js'
import { controlTuyaBoolean } from './tuya-cloud-inventory.js'
import { controlShellyCloudBoolean } from './shelly-cloud-inventory.js'

/**
 * 2.86 Paket N: the on/off state a device reported right before switching
 * (Hue light state, Tasmota POWER). `undefined` = not readable → no „Rückgängig“.
 */
export function vorherZustand(connector: string | undefined, functionId: string, body: any): boolean | undefined {
    if (connector === 'hue-readonly') return typeof body?.state?.on === 'boolean' ? body.state.on : undefined
    if (connector === 'tasmota-readonly') { const v = body?.StatusSTS?.[functionId]; return v === 'ON' ? true : v === 'OFF' ? false : undefined }
    return undefined
}

/** Fixed typed operations, followed by independent state read. No free commands. */
export async function executeSmartSwitch(root: string, d: DeviceRecord, action: SwitchAction, signal: AbortSignal, authorize: () => boolean,
    deps: { fetch?: typeof fetch; interfaces?: InterfaceMap; onBefore?: (on: boolean) => void } = {}): Promise<boolean> {
    if (typeof action.on !== 'boolean' || !authorize() || signal.aborted) throw new Error('No current control permission')
    const fetchFn: typeof fetch = async (url, options) => {
        if (!authorize() || signal.aborted) throw new Error('Control authority changed')
        return (deps.fetch || fetch)(url, { ...options, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) })
    }
    if (approvedSmartRoute(root, d) === 'cloud') {
        if (d.hardware?.connector === 'tuya-announcements') {
            const access = getTuyaCloudAccess(root, d); if (!access) throw new Error('Missing private cloud access')
            return controlTuyaBoolean(d.hardware.identity!, action.functionId, action.on, access, signal, fetchFn)
        }
        if (d.hardware?.connector === 'shelly-readonly') {
            const access = getShellyCloudAccess(root, d); if (!access) throw new Error('Missing private cloud access')
            return controlShellyCloudBoolean(d.hardware.identity!, action.functionId, action.on, access, signal, fetchFn)
        }
        throw new Error('Unsupported cloud control')
    }
    if (d.hardware?.connector === 'matter-ip') {
        const access = getMatterAccess(root, d)
        if (access?.state !== 'connected' || !access.peerId) throw new Error('Missing private Matter fabric')
        const result = await readMatterPeer({ host: d.host, port: d.port, identity: d.hardware.identity!, peerId: access.peerId,
            action: { functionId: action.functionId, on: action.on } }, matterFabricPath(root, d, access.revision), signal, authorize, deps.interfaces)
        return result.confirmed === true
    }
    if (d.hardware?.connector === 'esphome-native') {
        const access = getEspHomeAccess(root, d); if (!access) throw new Error('Missing private ESPHome access')
        const functions = await readLocalEspHome({ host: d.host, port: d.port, identity: d.hardware.identity!, ...access,
            action: { functionId: action.functionId, on: action.on } }, signal, deps.interfaces, authorize)
        return functions.some(f => f.id === action.functionId && f.confirmedOn === action.on)
    }
    if (d.port !== 80 || !scanTargetAllowed(d.host, ownSubnets(deps.interfaces)).allowed) throw new Error('Outside own LAN')
    const verified = await verifyHardwareConnection(d, { interfaces: deps.interfaces, httpProbe: async url => {
        const r = await fetchFn(url, { method: 'GET' }); return { status: r.status, body: JSON.stringify(await boundedHaJson(r)) }
    } }, signal)
    if (!verified || !authorize()) throw new Error('Identity not verified')
    const base = `http://${d.host}:80`
    const request = async (path: string, method = 'GET', body?: object): Promise<any> => boundedHaJson(await fetchFn(base + path, { method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }))
    if (d.hardware?.connector === 'hue-readonly') {
        const id = /^light:(\d{1,8})$/.exec(action.functionId)?.[1], key = hueKey(root, d.id)
        if (!id || !key) throw new Error('Invalid Hue function/access')
        const before = await request(`/api/${key}/lights/${id}`)
        if (!before?.state || typeof before.state.on !== 'boolean' || before.state.reachable !== true) throw new Error('Hue light not currently reachable')
        // 2.86 Paket N: the state read right before switching is what „Rückgängig“ restores.
        deps.onBefore?.(vorherZustand('hue-readonly', action.functionId, before)!)
        const reply = await request(`/api/${key}/lights/${id}/state`, 'PUT', { on: action.on })
        if (!Array.isArray(reply) || reply.length !== 1 || reply[0]?.success?.[`/lights/${id}/state/on`] !== action.on) return false
        const after = await request(`/api/${key}/lights/${id}`)
        return after?.state?.reachable === true && after.state.on === action.on
    }
    if (d.hardware?.connector === 'tasmota-readonly') {
        if (!/^POWER\d{0,3}$/.test(action.functionId)) throw new Error('Invalid Tasmota function')
        const before = await request('/cm?cmnd=Status%200')
        if (!['ON', 'OFF'].includes(before?.StatusSTS?.[action.functionId])) throw new Error('Function no longer confirmed')
        deps.onBefore?.(vorherZustand('tasmota-readonly', action.functionId, before)!)
        await request(`/cm?cmnd=${encodeURIComponent(action.functionId + ' ' + (action.on ? 'ON' : 'OFF'))}`)
        const after = await request('/cm?cmnd=Status%200')
        return after?.StatusSTS?.[action.functionId] === (action.on ? 'ON' : 'OFF')
    }
    if (d.hardware?.connector === 'shelly-readonly') {
        const m = /^(switch|light|rgb|rgbw|relays|lights):(\d{1,3})$/.exec(action.functionId)
        if (!m) throw new Error('Invalid Shelly function')
        const [_, kind, channel] = m, gen1 = ['relays', 'lights'].includes(kind)
        if (gen1 !== (d.hardware.probe === 'shelly-gen1')) throw new Error('Shelly generation mismatch')
        const path = gen1 ? '/status' : '/rpc/Shelly.GetStatus'
        const state = (body: any) => gen1 ? body?.[kind]?.[Number(channel)]?.ison : body?.[action.functionId]?.output
        const vorher = state(await request(path))
        if (typeof vorher !== 'boolean') throw new Error('Shelly function no longer confirmed')
        deps.onBefore?.(vorher)
        if (gen1) await request(`/${kind === 'relays' ? 'relay' : 'light'}/${Number(channel)}?turn=${action.on ? 'on' : 'off'}`)
        else await request(`/rpc/${{ switch: 'Switch', light: 'Light', rgb: 'RGB', rgbw: 'RGBW' }[kind]}.Set`, 'POST', { id: Number(channel), on: action.on })
        return state(await request(path)) === action.on
    }
    throw new Error('Unsupported device control')
}
