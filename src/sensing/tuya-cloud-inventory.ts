/** Fixed Tuya read-only specification API. No account-wide listing, commands,
 * key extraction, user-provided URLs or implicit cloud fallback. */
import { createHash, createHmac } from 'node:crypto'
import { boundedHaJson } from './ha-device-metadata.js'
import { cleanText } from './ports.js'
import type { DirectFunction } from './direct-smart-devices.js'
import type { TuyaCloudAccess } from './smart-device-access.js'
const HOSTS = { eu: 'https://openapi.tuyaeu.com', us: 'https://openapi.tuyaus.com', cn: 'https://openapi.tuyacn.com', in: 'https://openapi.tuyain.com' }
/** Only standard Boolean switch codes from a fresh device schema, never guessed DPS. */
export async function controlTuyaBoolean(deviceId: string, code: string, on: boolean, access: TuyaCloudAccess, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId) || !/^(switch_led|switch(?:_\d+)?)$/.test(code) || typeof on !== 'boolean' || !Object.hasOwn(HOSTS, access.region)) throw new Error('Invalid Tuya control')
    const request = async (path: string, token = '', body?: object): Promise<any> => {
        if (signal.aborted) throw new Error('Stopped')
        const t = String(Date.now()), payload = body ? JSON.stringify(body) : '', method = body ? 'POST' : 'GET'
        const hash = createHash('sha256').update(payload).digest('hex')
        const sign = createHmac('sha256', access.secret).update(access.client + token + t + `${method}\n${hash}\n\n${path}`).digest('hex').toUpperCase()
        const json: any = await boundedHaJson(await fetchFn(HOSTS[access.region] + path, { method, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
            headers: { client_id: access.client, t, sign, sign_method: 'HMAC-SHA256', ...(token ? { access_token: token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: payload } : {}) }))
        if (json?.success !== true || json.result === undefined) throw new Error('Tuya request denied')
        return json.result
    }
    const auth = await request('/v1.0/token?grant_type=1')
    if (!/^[a-zA-Z0-9_-]{8,256}$/.test(auth?.access_token || '')) throw new Error('Invalid Tuya token')
    const spec = await request(`/v1.0/devices/${deviceId}/specifications`, auth.access_token)
    if (!Array.isArray(spec?.functions) || !spec.functions.some(f => f?.code === code && f.type === 'Boolean')) throw new Error('Boolean function not confirmed')
    if (await request(`/v1.0/devices/${deviceId}/commands`, auth.access_token, { commands: [{ code, value: on }] }) !== true) return false
    const state = await request(`/v1.0/devices/${deviceId}/status`, auth.access_token)
    return Array.isArray(state) && state.length <= 200 && state.some(f => f?.code === code && f.value === on)
}
export async function readTuyaCloudFunctions(deviceId: string, signal: AbortSignal, deps: { access?: TuyaCloudAccess; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {}): Promise<DirectFunction[]> {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId)) throw new Error('Invalid Tuya ID')
    const env = deps.env || process.env, region = deps.access?.region || env.TUYA_API_REGION
    const client = deps.access?.client || env.TUYA_ACCESS_ID, secret = deps.access?.secret || env.TUYA_ACCESS_SECRET
    if (!client || !secret || !Object.hasOwn(HOSTS, region || '')) throw new Error('Tuya cloud access required')
    const request = async (path: string, token = '') => {
        if (signal.aborted) throw new Error('Stopped')
        const t = String((deps.now || Date.now)()), bodyHash = createHash('sha256').update('').digest('hex')
        const sign = createHmac('sha256', secret).update(client + token + t + `GET\n${bodyHash}\n\n${path}`).digest('hex').toUpperCase()
        const response = await (deps.fetch || fetch)(HOSTS[region] + path, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
            headers: { client_id: client, t, sign, sign_method: 'HMAC-SHA256', ...(token ? { access_token: token } : {}) } })
        const json: any = await boundedHaJson(response)
        if (json?.success !== true || !json.result) throw new Error('Tuya cloud read denied')
        return json.result
    }
    const auth = await request('/v1.0/token?grant_type=1')
    if (typeof auth.access_token !== 'string' || !/^[a-zA-Z0-9_-]{8,256}$/.test(auth.access_token)) throw new Error('Invalid cloud token')
    const spec = await request(`/v1.0/devices/${deviceId}/specifications`, auth.access_token)
    if (!Array.isArray(spec.functions) || spec.functions.length > 200) throw new Error('Invalid specifications')
    return spec.functions.filter((v: any) => v && /^[a-z][a-z0-9_]{0,63}$/.test(v.code) && ['Boolean', 'Integer', 'Enum', 'String', 'Json', 'Raw'].includes(v.type)).map((v: any) => ({
        id: v.code, kind: /^(?:switch_led|bright_value(?:_v2)?|colour_data(?:_v2)?|temp_value(?:_v2)?)$/.test(v.code) ? 'light' : /^switch(?:_\d+)?$/.test(v.code) ? 'switch' : 'unknown',
        name: `Tuya ${cleanText(v.code, 64)} (${cleanText(v.type, 12)})`,
    }))
}
