/**
 * Kamera anbinden (30.10.2026): one ONVIF still with the owner's login, on the node that found the
 * camera. Rules: only this camera's address (answers naming another host are refused), the password
 * never goes into a URL (WS-UsernameToken digest for SOAP, HTTP Digest/Basic header for the image),
 * no redirects, no second try with other data, no sound, no stream. Errors are fixed sentences and
 * never carry a response body, a header or the password.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface CameraTarget { host: string; port: number }
export interface CameraLogin { benutzer: string; passwort: string }
type FetchFn = typeof fetch
export interface CameraDeps { fetchFn?: FetchFn; now?: () => number }

export class CameraError extends Error {
    constructor(message: string) { super(message); this.name = 'CameraError' }
}

const MAX_IMAGE = 8 * 1024 * 1024
const TIMEOUT_MS = 8000
const md5 = (text: string) => createHash('md5').update(text).digest('hex')

function usernameToken(login: CameraLogin, now: number): string {
    const nonce = randomBytes(16), created = new Date(now).toISOString()
    const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(login.passwort)])).digest('base64')
    const user = login.benutzer.replace(/[<>&"']/g, '')
    return '<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken>'
        + `<wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>`
        + `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created>`
        + '</wsse:UsernameToken></wsse:Security></s:Header>'
}

const envelope = (header: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${header}<s:Body>${body}</s:Body></s:Envelope>`

async function soap(url: string, body: string, login: CameraLogin, deps: CameraDeps): Promise<string> {
    const fetchFn = deps.fetchFn || fetch
    let response: Response
    try {
        response = await fetchFn(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
            body: envelope(usernameToken(login, (deps.now || Date.now)()), body) })
    } catch { throw new CameraError('Die Kamera antwortet nicht.') }
    if (response.status === 401 || response.status === 403) throw new CameraError('Die Kamera hat die Anmeldung abgelehnt.')
    if (!response.ok) throw new CameraError('Die Kamera hat die Anfrage nicht angenommen.')
    return (await response.text()).slice(0, 256 * 1024)
}

/** A camera-supplied address counts only on the camera itself, without credentials. */
function sameCamera(address: string | undefined, target: CameraTarget): URL {
    let url: URL
    try { url = new URL(String(address || '').trim()) } catch { throw new CameraError('Die Kamera nennt keine gültige Adresse.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== target.host || url.username || url.password) {
        throw new CameraError('Die Kamera nennt eine fremde Adresse; ich folge ihr nicht.')
    }
    return url
}

const tag = (xml: string, name: string) => new RegExp(`<(?:[a-z0-9]+:)?${name}(?:\\s[^>]*)?>\\s*([^<\\s][^<]{0,1000})\\s*</(?:[a-z0-9]+:)?${name}>`, 'i').exec(xml)?.[1]?.replace(/&amp;/g, '&')

function digestHeader(challenge: string, login: CameraLogin, method: string, uri: string): string | null {
    const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`, 'i').exec(challenge)?.[1]
    const realm = field('realm'), nonce = field('nonce'), qop = field('qop')
    if (!realm || !nonce) return null
    const cnonce = randomBytes(8).toString('hex'), nc = '00000001'
    const ha1 = md5(`${login.benutzer}:${realm}:${login.passwort}`), ha2 = md5(`${method}:${uri}`)
    const useQop = qop?.split(/[ ,]+/).includes('auth')
    const response = useQop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`)
    return `Digest username="${login.benutzer}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"${useQop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}`
}

async function fetchImage(url: URL, login: CameraLogin, deps: CameraDeps): Promise<Buffer> {
    const fetchFn = deps.fetchFn || fetch
    const get = async (authorization?: string) => {
        try {
            return await fetchFn(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: authorization ? { Authorization: authorization } : {} })
        } catch { throw new CameraError('Die Kamera antwortet nicht.') }
    }
    let response = await get()
    if (response.status === 401) {
        const challenge = response.headers.get('www-authenticate') || ''
        const header = /^digest/i.test(challenge) ? digestHeader(challenge, login, 'GET', url.pathname + url.search)
            : /^basic/i.test(challenge) ? `Basic ${Buffer.from(`${login.benutzer}:${login.passwort}`).toString('base64')}` : null
        if (!header) throw new CameraError('Die Kamera verlangt eine unbekannte Anmeldung.')
        response = await get(header)
    }
    if (response.status === 401 || response.status === 403) throw new CameraError('Die Kamera hat die Anmeldung abgelehnt.')
    if (!response.ok) throw new CameraError('Die Kamera liefert kein Standbild.')
    const bytes = Buffer.from(await response.arrayBuffer())
    const image = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) || bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    if (!image || bytes.length > MAX_IMAGE) throw new CameraError('Die Kamera liefert kein Standbild.')
    return bytes
}

/** One still: capabilities → first media profile → snapshot address on the same camera → image. */
export async function onvifSnapshot(target: CameraTarget, login: CameraLogin, deps: CameraDeps = {}): Promise<Buffer> {
    const device = `http://${target.host}:${target.port}/onvif/device_service`
    const capabilities = await soap(device, '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Media</Category></GetCapabilities>', login, deps)
    const media = sameCamera(tag(capabilities, 'XAddr'), target).href
    const profiles = await soap(media, '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>', login, deps)
    const token = /<(?:[a-z0-9]+:)?Profiles[^>]*\stoken="([^"]{1,64})"/i.exec(profiles)?.[1]
    if (!token) throw new CameraError('Die Kamera nennt kein Bildprofil.')
    const snapshot = await soap(media, `<GetSnapshotUri xmlns="http://www.onvif.org/ver10/media/wsdl"><ProfileToken>${token.replace(/[<>&"']/g, '')}</ProfileToken></GetSnapshotUri>`, login, deps)
    return fetchImage(sameCamera(tag(snapshot, 'Uri'), target), login, deps)
}
