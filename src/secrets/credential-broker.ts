/**
 * 2.88 Paket „Verbinden ohne Technik“, Punkt 2 — Passwort-Tresor als Secret-Broker.
 *
 * The model NEVER sees a password or token. It only knows a `credential_id`
 * (e.g. „github-main“). A tool asks the broker; the broker
 *   1. checks the owner's release for exactly this entry AND this service (host),
 *   2. reads the value from the backend (exchangeable: Datei 0600, Bitwarden /
 *      Vaultwarden CLI `bw`, 1Password CLI `op`; later Vault/KMS),
 *   3. registers it for redaction (logs, thoughts, cards, memory, model context),
 *   4. hands it to the injecting code ONLY for the duration of one call
 *      (browser field fill, Authorization header of one request) — the tool
 *      keeps nothing.
 *
 * Fixed rules (code, not config):
 * - Entries and releases are written only by the owner (desktop app) or by the
 *   owner's Ja on a „Freigabe“ card. A model can only ASK for a release (card).
 * - Changing a password is never done here (Nie-Liste „Zugangsdaten ändern“):
 *   there is no write path into Bitwarden/1Password at all.
 * - No shell: the CLIs are started with execFile and a fixed argument array; the
 *   entry reference is validated first.
 * - Files: `<data>/secrets/tresor/eintraege.json` (metadata, no values) and
 *   `<data>/secrets/tresor/werte.json` (backend „datei“), both 0600 in a 0700 dir.
 */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getNovaDataDir } from '../core/data-root.js'
import { registerSecretValue } from '../security/secret-redaction.js'

export type TresorQuelle = 'datei' | 'bitwarden' | '1password'
export const TRESOR_QUELLEN: readonly TresorQuelle[] = Object.freeze(['datei', 'bitwarden', '1password'])

export interface ZugangsEintrag {
    /** What the model sees, e.g. „github-main“. */
    id: string
    /** Plain name for the owner („GitHub (Arbeit)“). */
    label: string
    quelle: TresorQuelle
    /** Bitwarden item id / 1Password `op://Tresor/Eintrag/Feld`. Not a secret. */
    ref?: string
    /** 1Password: optional reference of the user name field. */
    refBenutzer?: string
    /** Services (host or host:port) the owner released this entry for. */
    dienste: string[]
    createdAt: string
    updatedAt: string
}

/** What a tool/the model may see about an entry. */
export interface ZugangsSicht { id: string; label: string; quelle: TresorQuelle; dienste: string[] }

export interface ZugangsWert { benutzer?: string; geheim: string }

export type ExecLike = (file: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; stdout: string }>

export interface TresorDeps {
    dataDir?: string
    env?: NodeJS.ProcessEnv
    exec?: ExecLike
    now?: () => number
}

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/
const BW_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const OP_REF = /^op:\/\/[^\s'"`$;&|<>\\]{3,200}$/
const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/

const dirOf = (deps: TresorDeps) => join(deps.dataDir || getNovaDataDir(), 'secrets', 'tresor')
const eintraegeFile = (deps: TresorDeps) => join(dirOf(deps), 'eintraege.json')
const werteFile = (deps: TresorDeps) => join(dirOf(deps), 'werte.json')

export function isZugangsId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) }

/** host or host:port of a URL or a plain host; lower case; null when invalid. */
export function dienstVon(value: unknown): string | null {
    const raw = String(value ?? '').trim().toLowerCase()
    if (!raw) return null
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`)
        if (url.username || url.password) return null
        const host = url.hostname.replace(/^\[|\]$/g, '')
        const out = url.port ? `${host}:${url.port}` : host
        return HOST.test(out) ? out : null
    } catch { return null }
}

/** A release for `github.com` covers every port of github.com; one for `host:8006` only that port. */
export function dienstPasst(freigaben: readonly string[], ziel: string): boolean {
    const host = ziel.split(':')[0]
    return freigaben.some(item => item === ziel || (!item.includes(':') && item === host))
}

function writePrivate(path: string, data: unknown, deps: TresorDeps): void {
    const dir = dirOf(deps)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch { /* not supported on this filesystem */ }
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* not supported on this filesystem */ }
    renameSync(tmp, path)
}

function readJson(path: string): any {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}

export function listeEintraege(deps: TresorDeps = {}): ZugangsEintrag[] {
    const raw = readJson(eintraegeFile(deps))
    return (Array.isArray(raw?.eintraege) ? raw.eintraege : []).filter((item: any) => item && ID.test(String(item.id)) && TRESOR_QUELLEN.includes(item.quelle))
        .map((item: any) => ({ ...item, dienste: (Array.isArray(item.dienste) ? item.dienste : []).filter((host: unknown) => typeof host === 'string' && HOST.test(host)) }))
}

/** For the model and tools: ids, names, released services — never values or references. */
export function zugaengeSicht(deps: TresorDeps = {}): ZugangsSicht[] {
    return listeEintraege(deps).map(item => ({ id: item.id, label: item.label, quelle: item.quelle, dienste: [...item.dienste] }))
}

function saveEintraege(list: ZugangsEintrag[], deps: TresorDeps): void {
    writePrivate(eintraegeFile(deps), { version: 1, eintraege: list.slice(0, 200) }, deps)
}

export interface EintragEingabe { id: unknown; label?: unknown; quelle: unknown; ref?: unknown; refBenutzer?: unknown; dienste?: unknown; benutzer?: unknown; geheim?: unknown }
export type EintragErgebnis = { ok: true; eintrag: ZugangsSicht } | { ok: false; feld: string; meldung: string }

/** Owner (desktop app): add or update an entry. A „datei“ value goes only into werte.json (0600). */
export function speichereEintrag(input: EintragEingabe, deps: TresorDeps = {}): EintragErgebnis {
    const id = String(input?.id ?? '').trim().toLowerCase()
    if (!ID.test(id)) return { ok: false, feld: 'id', meldung: 'Kurzname: Kleinbuchstaben, Ziffern, Bindestrich (z. B. github-main).' }
    const quelle = String(input?.quelle ?? '') as TresorQuelle
    if (!TRESOR_QUELLEN.includes(quelle)) return { ok: false, feld: 'quelle', meldung: 'Quelle: Datei, Bitwarden oder 1Password.' }
    const label = String(input?.label ?? id).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60) || id
    const dienste = [...new Set((Array.isArray(input?.dienste) ? input.dienste : String(input?.dienste ?? '').split(/[,\s]+/)).map(dienstVon).filter(Boolean) as string[])].slice(0, 20)
    if (!dienste.length) return { ok: false, feld: 'dienste', meldung: 'Mindestens einen Dienst angeben (z. B. github.com).' }
    const now = new Date((deps.now || Date.now)()).toISOString()
    const existing = listeEintraege(deps).find(item => item.id === id)
    const eintrag: ZugangsEintrag = { id, label, quelle, dienste, createdAt: existing?.createdAt || now, updatedAt: now }
    if (quelle === 'bitwarden') {
        const ref = String(input?.ref ?? '').trim()
        if (!BW_REF.test(ref)) return { ok: false, feld: 'ref', meldung: 'Bitwarden: die Eintrags-ID (aus „bw list items“ oder der Web-Ansicht).' }
        eintrag.ref = ref
    } else if (quelle === '1password') {
        const ref = String(input?.ref ?? '').trim()
        if (!OP_REF.test(ref)) return { ok: false, feld: 'ref', meldung: '1Password: Verweis wie op://Tresor/Eintrag/password.' }
        eintrag.ref = ref
        const refBenutzer = String(input?.refBenutzer ?? '').trim()
        if (refBenutzer) {
            if (!OP_REF.test(refBenutzer)) return { ok: false, feld: 'refBenutzer', meldung: '1Password: Verweis wie op://Tresor/Eintrag/username.' }
            eintrag.refBenutzer = refBenutzer
        }
    } else {
        const geheim = typeof input?.geheim === 'string' ? input.geheim : ''
        const werte = readJson(werteFile(deps))?.werte || {}
        if (!geheim && !werte[id]?.geheim) return { ok: false, feld: 'geheim', meldung: 'Passwort oder Token fehlt.' }
        if (geheim.length > 4096 || /[\u0000\r\n]/.test(geheim)) return { ok: false, feld: 'geheim', meldung: 'Ungültiger Wert.' }
        const benutzer = typeof input?.benutzer === 'string' ? input.benutzer.trim().slice(0, 200) : werte[id]?.benutzer
        writePrivate(werteFile(deps), { version: 1, werte: { ...werte, [id]: { ...(benutzer ? { benutzer } : {}), geheim: geheim || werte[id].geheim } } }, deps)
    }
    saveEintraege([...listeEintraege(deps).filter(item => item.id !== id), eintrag], deps)
    return { ok: true, eintrag: { id, label, quelle, dienste } }
}

/** Owner: remove an entry (and its „datei“ value). The password manager itself is never touched. */
export function entferneEintrag(id: string, deps: TresorDeps = {}): boolean {
    if (!ID.test(String(id || ''))) return false
    const list = listeEintraege(deps)
    if (!list.some(item => item.id === id)) return false
    saveEintraege(list.filter(item => item.id !== id), deps)
    const werte = readJson(werteFile(deps))?.werte
    if (werte && werte[id]) { delete werte[id]; writePrivate(werteFile(deps), { version: 1, werte }, deps) }
    return true
}

/** Owner's Ja on a release card: this entry may now be used for this service. */
export function gibFrei(id: string, dienst: string, deps: TresorDeps = {}): boolean {
    const ziel = dienstVon(dienst)
    const list = listeEintraege(deps)
    const eintrag = list.find(item => item.id === id)
    if (!eintrag || !ziel) return false
    if (!dienstPasst(eintrag.dienste, ziel)) eintrag.dienste = [...eintrag.dienste, ziel].slice(0, 20)
    eintrag.updatedAt = new Date((deps.now || Date.now)()).toISOString()
    saveEintraege(list, deps)
    return true
}

// ---------------------------------------------------------------------------
// Backends (exchangeable). Only reading; there is no write path.
// ---------------------------------------------------------------------------

export interface TresorBackend { quelle: TresorQuelle; lese(eintrag: ZugangsEintrag, deps: TresorDeps): Promise<ZugangsWert | null> }

const defaultExec: ExecLike = (file, args, options) => new Promise(resolve => {
    execFile(file, args, { timeout: options.timeoutMs, env: options.env, windowsHide: true, maxBuffer: 64 * 1024, shell: false }, (error, stdout) => {
        resolve({ ok: !error, stdout: String(stdout ?? '') })
    })
})

const dateiBackend: TresorBackend = {
    quelle: 'datei',
    async lese(eintrag, deps) {
        const wert = readJson(werteFile(deps))?.werte?.[eintrag.id]
        return typeof wert?.geheim === 'string' && wert.geheim ? { ...(typeof wert.benutzer === 'string' && wert.benutzer ? { benutzer: wert.benutzer } : {}), geheim: wert.geheim } : null
    },
}

/** Bitwarden / Vaultwarden (`bw`, server set with `bw config server`). Needs the owner's unlocked session (BW_SESSION). */
const bitwardenBackend: TresorBackend = {
    quelle: 'bitwarden',
    async lese(eintrag, deps) {
        const env = deps.env || process.env
        if (!eintrag.ref || !BW_REF.test(eintrag.ref) || !env.BW_SESSION) return null
        const run = deps.exec || defaultExec
        const geheim = await run('bw', ['get', 'password', eintrag.ref, '--nointeraction'], { timeoutMs: 15_000, env })
        if (!geheim.ok || !geheim.stdout.trim()) return null
        const benutzer = await run('bw', ['get', 'username', eintrag.ref, '--nointeraction'], { timeoutMs: 15_000, env })
        return { ...(benutzer.ok && benutzer.stdout.trim() ? { benutzer: benutzer.stdout.trim() } : {}), geheim: geheim.stdout.replace(/\r?\n$/, '') }
    },
}

/** 1Password CLI (`op read`), signed in by the owner (desktop integration or service account). */
const onePasswordBackend: TresorBackend = {
    quelle: '1password',
    async lese(eintrag, deps) {
        const env = deps.env || process.env
        if (!eintrag.ref || !OP_REF.test(eintrag.ref)) return null
        const run = deps.exec || defaultExec
        const geheim = await run('op', ['read', '--no-newline', eintrag.ref], { timeoutMs: 15_000, env })
        if (!geheim.ok || !geheim.stdout) return null
        const benutzer = eintrag.refBenutzer && OP_REF.test(eintrag.refBenutzer) ? await run('op', ['read', '--no-newline', eintrag.refBenutzer], { timeoutMs: 15_000, env }) : null
        return { ...(benutzer?.ok && benutzer.stdout ? { benutzer: benutzer.stdout } : {}), geheim: geheim.stdout }
    },
}

const backends = new Map<TresorQuelle, TresorBackend>([[dateiBackend.quelle, dateiBackend], [bitwardenBackend.quelle, bitwardenBackend], [onePasswordBackend.quelle, onePasswordBackend]])

/** Exchange a backend (tests; later Vault/KMS). */
export function registerTresorBackend(backend: TresorBackend): () => void {
    const previous = backends.get(backend.quelle)
    backends.set(backend.quelle, backend)
    return () => { if (previous) backends.set(backend.quelle, previous); else backends.delete(backend.quelle) }
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export type BrokerErgebnis<T> =
    | { ok: true; ergebnis: T }
    | { ok: false; grund: 'unbekannt' | 'freigabe-fehlt' | 'gesperrt' | 'fehler'; meldung: string }

/**
 * The one way to a value: `nutzen` gets it for this one call (inject into the
 * target service), the result goes back. The value is registered for redaction
 * before `nutzen` runs, so nothing that `nutzen` logs or returns carries it.
 */
export async function mitZugang<T>(id: string, ziel: string, nutzen: (wert: ZugangsWert) => Promise<T>, deps: TresorDeps = {}): Promise<BrokerErgebnis<T>> {
    if (!ID.test(String(id || ''))) return { ok: false, grund: 'unbekannt', meldung: 'Diesen Zugang kenne ich nicht.' }
    const eintrag = listeEintraege(deps).find(item => item.id === id)
    if (!eintrag) return { ok: false, grund: 'unbekannt', meldung: `Den Zugang „${id}“ gibt es im Tresor nicht.` }
    const dienst = dienstVon(ziel)
    if (!dienst || !dienstPasst(eintrag.dienste, dienst)) {
        return { ok: false, grund: 'freigabe-fehlt', meldung: `„${eintrag.label}“ ist für ${dienst || 'diesen Dienst'} nicht freigegeben.` }
    }
    const backend = backends.get(eintrag.quelle)
    let wert: ZugangsWert | null = null
    try { wert = backend ? await backend.lese(eintrag, deps) : null } catch { wert = null }
    if (!wert?.geheim) {
        return { ok: false, grund: 'gesperrt', meldung: eintrag.quelle === 'datei' ? `„${eintrag.label}“ hat keinen gespeicherten Wert.` : `Der Passwortmanager (${eintrag.quelle === 'bitwarden' ? 'Bitwarden' : '1Password'}) ist gesperrt oder der Eintrag fehlt — bitte einmal entsperren.` }
    }
    registerSecretValue(wert.geheim, eintrag.id)
    // User names are not secret, but private: they never reach the model either.
    if (wert.benutzer) registerSecretValue(wert.benutzer, `${eintrag.id}-benutzer`)
    try {
        return { ok: true, ergebnis: await nutzen(wert) }
    } catch {
        return { ok: false, grund: 'fehler', meldung: `Einsetzen von „${eintrag.label}“ hat nicht geklappt; der Wert wurde nicht angezeigt.` }
    } finally {
        wert = null
    }
}

/** A `fetch` that adds `Authorization: Bearer <value>` per request (connector token from the vault, never in a config file). */
export function tresorBearerFetch(id: string, deps: TresorDeps = {}, base: typeof fetch = fetch): typeof fetch {
    return (async (input: any, init?: any) => {
        const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url || '')
        const result = await mitZugang(id, url, async wert => {
            const headers = new Headers(init?.headers || (typeof input === 'object' && input?.headers) || undefined)
            headers.set('Authorization', `Bearer ${wert.geheim}`)
            return base(input, { ...(init || {}), headers })
        }, deps)
        if (result.ok === false) throw new Error(`Tresor: ${result.meldung}`)
        return result.ergebnis
    }) as typeof fetch
}

/** The part of the browser the login fill needs (tools/browser.ts BrowserAdapter). */
export interface LoginBrowser { isRunning(): boolean; getCurrentUrl(): string; type(selector: string, text: string): Promise<void> }

const PASSWORD_FIELD = 'input[type="password"] >> nth=0'
const USER_FIELD = 'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[name="email"] >> nth=0'

/** Fill user name + password of the login form on the current page. Returns only what was filled. */
export async function fuelleLogin(id: string, browser: LoginBrowser, deps: TresorDeps = {}): Promise<BrokerErgebnis<{ benutzer: boolean; passwort: boolean; dienst: string }>> {
    if (!browser.isRunning()) return { ok: false, grund: 'fehler', meldung: 'Es ist keine Seite offen — erst die Anmeldeseite öffnen.' }
    const url = browser.getCurrentUrl()
    if (!/^https:\/\//i.test(url) && !/^http:\/\/(?:localhost|127\.|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url)) {
        return { ok: false, grund: 'fehler', meldung: 'Ich setze Zugangsdaten nur auf https-Seiten (oder im eigenen Netz) ein.' }
    }
    const dienst = dienstVon(url) || ''
    return mitZugang(id, url, async wert => {
        let benutzer = false
        if (wert.benutzer) {
            try { await browser.type(USER_FIELD, wert.benutzer); benutzer = true } catch { benutzer = false }
        }
        await browser.type(PASSWORD_FIELD, wert.geheim)
        return { benutzer, passwort: true, dienst }
    }, deps)
}

/** Requests that would change a password: always refused here (owner only, in the password manager). */
export const PASSWORT_AENDERN_TEXT = 'Passwörter ändere ich nie — das machst du selbst im Passwortmanager. Danach nutze ich automatisch den neuen Wert.'
