/**
 * Client für Panoptes (Auto), Vertrag SICHERHEIT_0130 „Für Xaventra“. Hart begrenzt: nur die Pfade der
 * Erlaubnisliste, keine Weiterleitungen, kein Clip, keine Aufnahmenliste, keine Fahrzeug-Endpunkte. Aus
 * Ereignissen werden nur `art`, `zeit` und `ereignisId` gelesen; Koordinaten gibt es hier nicht.
 * Der JWT steht nie in einem Log oder einer Fehlermeldung.
 */
type FetchFn = typeof fetch
export interface PanoptesDeps { fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void>; now?: () => number }

const MAX_IMAGE = 8 * 1024 * 1024
const ERLAUBT: ReadonlyArray<readonly [string, RegExp]> = [
    ['POST', /^\/auth\/kopplung\/anfrage$/],
    ['GET', /^\/auth\/kopplung\/anfrage\/[A-Za-z0-9_-]{1,100}$/],
    ['GET', /^\/api\/ha\/v1\/ereignisse$/],
    ['GET', /^\/api\/waechter\/standbild\/[a-f0-9]{32}$/],
    ['GET', /^\/api\/surveillance\/status$/],
    ['POST', /^\/api\/sitzung\/(?:erneuern|abmelden)$/],
]

export class PanoptesPfadVerweigert extends Error {
    constructor() { super('Panoptes-Pfad nicht erlaubt; nichts gesendet.'); this.name = 'PanoptesPfadVerweigert' }
}

export function assertPanoptesPfad(method: string, path: string): void {
    if (!ERLAUBT.some(([allowed, pattern]) => allowed === method && pattern.test(path))) throw new PanoptesPfadVerweigert()
}

function anfrage(base: string, method: string, path: string, deps: PanoptesDeps, options: { jwt?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response> {
    assertPanoptesPfad(method, path)
    return (deps.fetchFn || fetch)(`${base.replace(/\/+$/, '')}${path}`, {
        method, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
        headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.jwt ? { Authorization: `Bearer ${options.jwt}` } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
}

export interface KopplungsAnfrage { id: string; abfrageAlleMs: number }

export async function starteKopplung(base: string, pruefzahl: string, deps: PanoptesDeps = {}): Promise<KopplungsAnfrage> {
    const response = await anfrage(base, 'POST', '/auth/kopplung/anfrage', deps, { body: { geraet: 'Xaventra', pruefzahl, art: 'dienst' } })
    const answer = await response.json().catch(() => ({})) as any
    if (answer?.ok !== true || typeof answer.id !== 'string') throw new Error('Panoptes hat die Kopplungsanfrage nicht angenommen.')
    return { id: answer.id, abfrageAlleMs: Number.isFinite(answer.abfrageAlleMs) ? answer.abfrageAlleMs : 2000 }
}

export type KopplungsErgebnis = { status: 'erlaubt'; jwt: string; kopplungId: string } | { status: 'abgelehnt' | 'zeitlimit' }

/** Fragt ab, bis Alfred erlaubt hat. Jeder andere Zustand als `wartet` beendet die Anfrage. */
export async function pollKopplung(base: string, start: KopplungsAnfrage, deps: PanoptesDeps & { maxMs?: number } = {}): Promise<KopplungsErgebnis> {
    const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    const begin = now(), maxMs = deps.maxMs ?? 5 * 60_000
    while (now() - begin < maxMs) {
        await sleep(Math.max(1, start.abfrageAlleMs))
        const answer = await (await anfrage(base, 'GET', `/auth/kopplung/anfrage/${start.id}`, deps)).json().catch(() => ({})) as any
        if (answer?.status === 'erlaubt' && typeof answer.jwt === 'string') return { status: 'erlaubt', jwt: answer.jwt, kopplungId: String(answer.kopplungId ?? '') }
        if (answer?.status !== 'wartet') return { status: 'abgelehnt' }
    }
    return { status: 'zeitlimit' }
}

export async function erneuereSitzung(base: string, jwt: string, deps: PanoptesDeps = {}): Promise<string | null> {
    const response = await anfrage(base, 'POST', '/api/sitzung/erneuern', deps, { jwt, body: {} })
    if (!response.ok) return null
    const answer = await response.json().catch(() => ({})) as any
    return typeof answer?.jwt === 'string' ? answer.jwt : null
}

export async function meldeAb(base: string, jwt: string, deps: PanoptesDeps = {}): Promise<boolean> {
    return (await anfrage(base, 'POST', '/api/sitzung/abmelden', deps, { jwt, body: {} })).ok
}

export type PanoptesEreignis = { art: 'person' | 'bewegung'; zeit: number; ereignisId: string } | { art: 'person' | 'bewegung'; zeit: number; ohneId: true }

/** Nur `event: ereignis`; andere Arten im selben Strom (zustand, ankunft …) zählen nicht. */
export function parseEreignis(event: string, data: string): PanoptesEreignis | null {
    if (event !== 'ereignis') return null
    let value: any
    try { value = JSON.parse(data) } catch { return null }
    if ((value?.art !== 'person' && value?.art !== 'bewegung') || !Number.isFinite(value?.zeit)) return null
    return typeof value.ereignisId === 'string' && /^[a-f0-9]{32}$/.test(value.ereignisId)
        ? { art: value.art, zeit: value.zeit, ereignisId: value.ereignisId }
        : { art: value.art, zeit: value.zeit, ohneId: true }
}

/** Liest den SSE-Strom bis zum Ende oder Abbruch. Liefert den HTTP-Status zurück. */
export async function lauscheEreignisse(base: string, jwt: string, options: PanoptesDeps & { signal: AbortSignal; onEreignis: (event: PanoptesEreignis) => void | Promise<void> }): Promise<{ status: number }> {
    const response = await anfrage(base, 'GET', '/api/ha/v1/ereignisse', options, { jwt, signal: options.signal })
    if (!response.ok || !response.body) return { status: response.status }
    const decoder = new TextDecoder()
    let buffer = '', name = '', data = ''
    const reader = response.body.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > 256 * 1024) buffer = buffer.slice(-64 * 1024)
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).replace(/\r$/, '')
            buffer = buffer.slice(end + 1)
            if (line === '') {
                const event = data ? parseEreignis(name, data) : null
                name = ''; data = ''
                if (event) await options.onEreignis(event)
            } else if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
    }
    return { status: response.status }
}

export type StandbildErgebnis = { ok: true; bytes: Buffer } | { ok: false; grund: 'noch_nicht' | 'nicht_erlaubt' | 'nicht_gefunden' | 'zu_alt' | 'zu_oft' | 'kein_bild' }
const GRUND: Record<number, 'nicht_erlaubt' | 'nicht_gefunden' | 'zu_alt' | 'zu_oft'> = { 403: 'nicht_erlaubt', 404: 'nicht_gefunden', 410: 'zu_alt', 429: 'zu_oft' }

/** Ein Bild zu einer ereignisId. 202 = noch nicht fertig: warten wie verlangt, höchstens rund zwei Minuten. */
export async function holeStandbild(base: string, jwt: string, ereignisId: string, deps: PanoptesDeps = {}): Promise<StandbildErgebnis> {
    const path = `/api/waechter/standbild/${ereignisId}`
    assertPanoptesPfad('GET', path)
    const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    const begin = now()
    for (;;) {
        const response = await anfrage(base, 'GET', path, deps, { jwt })
        if (response.status === 202) {
            const answer = await response.json().catch(() => ({})) as any
            const waitMs = Math.max(1, Math.min(30, Number(answer?.erneutInSekunden) || 3)) * 1000
            if (now() - begin + waitMs > 120_000) return { ok: false, grund: 'noch_nicht' }
            await sleep(waitMs)
            continue
        }
        if (GRUND[response.status]) return { ok: false, grund: GRUND[response.status] }
        if (response.status !== 200) return { ok: false, grund: 'kein_bild' }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > MAX_IMAGE || !bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return { ok: false, grund: 'kein_bild' }
        return { ok: true, bytes }
    }
}
