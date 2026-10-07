/**
 * 2.88 „Proxmox ohne Config“.
 *
 *   1. Owner enters ONE thing in the app („Verbindungen → Proxmox“): the API
 *      token (plus the address, pre-filled from the network discovery).
 *   2. Xaventra reads the host's TLS fingerprint herself (TLS handshake only,
 *      nothing is sent) and shows its first/last characters on ONE card.
 *   3. Owner's Ja = fingerprint confirmed → reading + control in pool `xaventra`
 *      are active at once (loadProxmoxRuntime reads the app setup on every
 *      call; no restart). Missing pool → a card with the steps to create it.
 *
 * The adapter's safety rules (src/infra/proxmox.ts: pool only, never hard
 * stop, every write a card) are unchanged — this only replaces config editing.
 * The token is stored in the existing connection secrets file (0600) and
 * never shown again.
 */
import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    createApprovalCard, getCardExecutor, registerCardExecutor, type CardExecutor, type CardStoreOptions,
} from '../core/approval-cards.js'
import { getNovaDataDir } from '../core/data-root.js'
import { loadProxmoxRuntime, normalizeFingerprint, parseProxmoxToken, type ProxmoxRuntime } from './proxmox.js'
import {
    PROXMOX_APP_POOL, readProxmoxAppSetup, readProxmoxAppToken, writeProxmoxAppSetup, writeProxmoxAppToken, type AppStoreOptions,
} from './proxmox-app-store.js'

// Not „…fingerabdruck“: the word „druck“ would mark the card physical (KARTEN_PHYSISCH, printers).
export const FINGERPRINT_KIND = 'pve-zertifikat'
export const POOL_KIND = 'pve-pool-pruefen'

/** The 3-step guide shown in the app (plain words). */
export const PROXMOX_TOKEN_ANLEITUNG: readonly string[] = Object.freeze([
    'In Proxmox: Rechenzentrum → Berechtigungen → Pools → „Erstellen“, Name xaventra. Dann Rechenzentrum → Berechtigungen → API-Token → „Hinzufügen“: Benutzer wählen (z. B. root@pam), Token-ID xaventra, Haken „Privilegien trennen“ an. Den angezeigten Wert sofort kopieren — er erscheint nur einmal.',
    'Rechenzentrum → Berechtigungen → „Hinzufügen“ → „API-Token-Berechtigung“: Pfad / mit Rolle PVEAuditor (nur sehen) und Pfad /pool/xaventra mit Rolle PVEVMAdmin (nur dort steuern).',
    'Hier einfügen: die ganze Zeile „benutzer@pam!xaventra=…“ und die Adresse. Ich lese dann den Fingerabdruck des Servers und zeige ihn dir einmal zum Bestätigen.',
])

export interface TlsPeer { fingerprint: string | null; issuer?: string; subject?: string }
export type TlsProbe = (host: string, port: number, timeoutMs: number) => Promise<TlsPeer | null>

export interface SetupDeps extends AppStoreOptions {
    cardOpts?: CardStoreOptions
    tlsProbe?: TlsProbe
    runtime?: () => Promise<ProxmoxRuntime>
    devices?: () => Array<{ type?: string; host?: string; port?: number; status?: string }>
    /** Config file view (default: `infra.proxmox` of the main config). */
    configEnabled?: () => boolean
    now?: () => number
    nodeOnly?: boolean
}

const isWorker = (deps: SetupDeps) => deps.nodeOnly ?? process.env.NOVA_NODE_ONLY === 'true'

/** TLS handshake only: read the peer certificate, write nothing, close. */
export const realTlsProbe: TlsProbe = (host, port, timeoutMs) => new Promise(resolve => {
    let done = false
    // Only to READ the self-signed certificate; nothing is sent, the owner confirms the result.
    const socket = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
    const finish = (value: TlsPeer | null) => {
        if (done) return
        done = true
        try { socket.destroy() } catch { /* closed */ }
        resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate()
        const name = (part: any) => part ? [part.O, part.OU, part.CN].flat().filter(Boolean).join(' / ').slice(0, 120) : undefined
        finish({ fingerprint: normalizeFingerprint(cert?.fingerprint256), issuer: name(cert?.issuer), subject: name(cert?.subject) })
    })
    socket.once('error', () => finish(null))
})

/** „192.0.2.10“, „pve.example.com:8006“, „https://…/#v1“ → https://host:port (origin only). */
export function proxmoxAdresse(value: unknown): string | null {
    const raw = String(value ?? '').trim()
    if (!raw || raw.length > 200) return null
    try {
        const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : `https://${raw}`)
        if (url.protocol !== 'https:' || url.username || url.password) return null
        if (!/^[A-Za-z0-9.[\]:-]{1,200}$/.test(url.hostname)) return null
        return `https://${url.hostname}:${url.port || '8006'}`
    } catch { return null }
}

/** First and last characters of a fingerprint for the card (owner compares with Proxmox). */
export function fingerabdruckKurz(fingerprint: string): { anfang: string; ende: string } {
    const parts = fingerprint.split(':')
    return { anfang: parts.slice(0, 4).join(':'), ende: parts.slice(-4).join(':') }
}

/** Addresses the network discovery found (type proxmox or port 8006), owner network only. */
export function vorgeschlageneAdressen(deps: SetupDeps = {}): string[] {
    let devices: Array<{ type?: string; host?: string; port?: number; status?: string }> = []
    try {
        if (deps.devices) devices = deps.devices()
        else {
            const file = join(deps.dataDir || getNovaDataDir(), 'sensing', 'devices.json')
            const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
            devices = Array.isArray(raw?.devices) ? raw.devices : []
        }
    } catch { devices = [] }
    const out = devices.filter(device => device && device.status !== 'abgelehnt' && typeof device.host === 'string' && (device.type === 'proxmox' || Number(device.port) === 8006))
        .sort((a, b) => Number(b.type === 'proxmox') - Number(a.type === 'proxmox'))
        .map(device => proxmoxAdresse(`${device.host}:8006`)).filter(Boolean) as string[]
    return [...new Set(out)].slice(0, 5)
}

export interface ProxmoxAnsicht {
    eingerichtet: boolean
    adresse: string | null
    vorschlaege: string[]
    tokenGespeichert: boolean
    fingerabdruck: { anfang: string; ende: string; bestaetigt: boolean } | null
    /** Set up the old way (`infra.proxmox` + env), not from the app. */
    ausConfig: boolean
    anleitung: readonly string[]
    status?: { ok: boolean; text: string }
}

async function defaultConfigEnabled(): Promise<boolean> {
    const { parseProxmoxConfig, readProxmoxRawConfig } = await import('./proxmox.js')
    return parseProxmoxConfig(readProxmoxRawConfig()).enabled
}

/** What the app shows (never the token). */
export async function proxmoxAnsicht(deps: SetupDeps = {}, options: { pruefen?: boolean } = {}): Promise<ProxmoxAnsicht> {
    const setup = readProxmoxAppSetup(deps)
    const ausConfig = deps.configEnabled ? deps.configEnabled() : await defaultConfigEnabled()
    const tokenGespeichert = Boolean(readProxmoxAppToken(deps))
    const view: ProxmoxAnsicht = {
        eingerichtet: Boolean(setup?.bestaetigt && tokenGespeichert) || ausConfig,
        adresse: setup?.url || null, vorschlaege: vorgeschlageneAdressen(deps), tokenGespeichert,
        fingerabdruck: setup ? { ...fingerabdruckKurz(setup.fingerprint), bestaetigt: setup.bestaetigt } : null, ausConfig, anleitung: PROXMOX_TOKEN_ANLEITUNG,
    }
    if (options.pruefen && view.eingerichtet) view.status = await pruefeProxmox(deps)
    return view
}

/** Read access + pool: one plain sentence. */
export async function pruefeProxmox(deps: SetupDeps = {}): Promise<{ ok: boolean; text: string; poolFehlt?: boolean }> {
    const runtime = await (deps.runtime || (() => loadProxmoxRuntime()))()
    if (runtime.ok === false) return { ok: false, text: `Proxmox ist noch nicht verbunden (${runtime.reason}).` }
    try {
        const guests = await runtime.client.listGuests()
        if (!await runtime.client.poolExists()) return { ok: false, poolFehlt: true, text: `Verbunden: ich sehe ${guests.length} Gäste. Der Pool „${runtime.config.pool}“ fehlt noch — bis dahin steuere ich nichts.` }
        const members = await runtime.client.poolMembers()
        return { ok: true, text: `Verbunden: ich sehe ${guests.length} Gäste, ${members.size} davon im Pool „${runtime.config.pool}“ (nur die steuere ich, immer mit deinem Ja).` }
    } catch (error) {
        return { ok: false, text: runtime.client.safe((error as Error)?.message || error, 200) }
    }
}

export interface SpeichernErgebnis { ok: boolean; meldung: string; feld?: string; fingerabdruck?: { anfang: string; ende: string }; cardId?: string }

/**
 * Owner (app): token + address. Reads the fingerprint itself, stores the token
 * (0600) and puts ONE card „Fingerabdruck bestätigen“. Nothing is usable before the Ja.
 */
export async function speichereProxmoxZugang(input: { adresse?: unknown; token?: unknown }, deps: SetupDeps = {}): Promise<SpeichernErgebnis> {
    if (isWorker(deps)) return { ok: false, meldung: 'Proxmox wird nur am Haupt-Rechner eingerichtet.' }
    const tokenText = typeof input?.token === 'string' ? input.token.trim() : ''
    if (!tokenText && !readProxmoxAppToken(deps)) return { ok: false, feld: 'token', meldung: 'Bitte den API-Token einfügen (Zeile „benutzer@pam!xaventra=…“).' }
    if (tokenText && !parseProxmoxToken(tokenText)) return { ok: false, feld: 'token', meldung: 'Das sieht nicht wie ein Proxmox-API-Token aus. Erwartet: benutzer@pam!name=… (der Wert wird nicht angezeigt).' }
    const adresse = proxmoxAdresse(input?.adresse || vorgeschlageneAdressen(deps)[0] || readProxmoxAppSetup(deps)?.url)
    if (!adresse) return { ok: false, feld: 'adresse', meldung: 'Bitte die Adresse des Proxmox-Servers angeben (z. B. 192.0.2.10).' }
    const url = new URL(adresse)
    const peer = await (deps.tlsProbe || realTlsProbe)(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port), 8000).catch(() => null)
    if (!peer?.fingerprint) return { ok: false, feld: 'adresse', meldung: `Unter ${adresse} antwortet kein Proxmox (keine sichere Verbindung). Adresse prüfen.` }
    if (tokenText) writeProxmoxAppToken(tokenText, deps)
    const previous = readProxmoxAppSetup(deps)
    const same = Boolean(previous && previous.url === adresse && previous.fingerprint === peer.fingerprint && previous.bestaetigt)
    writeProxmoxAppSetup({
        version: 1, url: adresse, fingerprint: peer.fingerprint, bestaetigt: same, ...(same && previous?.bestaetigtAt ? { bestaetigtAt: previous.bestaetigtAt } : {}),
        pool: PROXMOX_APP_POOL, savedAt: new Date((deps.now || Date.now)()).toISOString(),
    }, deps)
    const kurz = fingerabdruckKurz(peer.fingerprint)
    if (same) return { ok: true, meldung: 'Token gespeichert. Der Fingerabdruck ist unverändert und schon bestätigt.', fingerabdruck: kurz }
    registerProxmoxSetupExecutors(deps)
    const card = createApprovalCard({
        art: 'proxmox', titel: 'Proxmox: Fingerabdruck bestätigen',
        beleg: `Server ${adresse}${peer.subject ? ` (${peer.subject})` : ''}. Fingerabdruck beginnt mit ${kurz.anfang} und endet mit ${kurz.ende}. Vergleiche in Proxmox: Knoten → System → Zertifikate → pve-ssl.pem → Fingerabdruck.`,
        vorschlag: 'Ja = stimmt überein; dann sehe ich deine VMs und steuere nur im Pool xaventra (immer mit deinem Ja). Nein = nichts.',
        aktion: { kind: FINGERPRINT_KIND, ref: peer.fingerprint }, wirkung: 'infra', ablaufMs: 24 * 60 * 60_000,
        dedupeKey: `proxmox:fingerabdruck:${peer.fingerprint}`, quelle: 'proxmox',
    }, deps.cardOpts)
    if (card.ok === false) return { ok: false, meldung: `Keine Karte: ${card.reason}` }
    return { ok: true, cardId: card.card.id, fingerabdruck: kurz, meldung: `Token gespeichert. Bitte den Fingerabdruck bestätigen: beginnt mit ${kurz.anfang}, endet mit ${kurz.ende}.` }
}

async function poolKarte(pool: string, deps: SetupDeps): Promise<string | null> {
    registerProxmoxSetupExecutors(deps)
    const card = createApprovalCard({
        art: 'proxmox', titel: `Proxmox: Pool „${pool}“ anlegen`,
        beleg: `Ich steuere nur VMs im Pool „${pool}“ — den gibt es noch nicht. So legst du ihn an: Rechenzentrum → Berechtigungen → Pools → „Erstellen“, Name ${pool}. Danach unter Berechtigungen dem API-Token die Rolle PVEVMAdmin auf /pool/${pool} geben und die VMs, die ich steuern darf, in den Pool legen.`,
        vorschlag: 'Ja = ich habe ihn angelegt, prüf noch einmal. Ich lege ihn nicht selbst an.',
        aktion: { kind: POOL_KIND, ref: pool }, wirkung: 'infra', ablaufMs: 7 * 24 * 60 * 60_000,
        dedupeKey: `proxmox:pool:${pool}`, quelle: 'proxmox',
    }, deps.cardOpts)
    return card.ok ? card.card.id : null
}

export function createProxmoxSetupExecutors(deps: SetupDeps = {}): CardExecutor[] {
    return [{
        kind: FINGERPRINT_KIND, impact: 'infra', allowAlways: () => false,
        async execute(card) {
            if (isWorker(deps)) return { ok: false, message: 'Nur am Haupt-Rechner.' }
            const setup = readProxmoxAppSetup(deps)
            const fp = normalizeFingerprint(card.aktion.ref)
            if (!setup || !fp || setup.fingerprint !== fp) return { ok: false, message: 'Der Fingerabdruck hat sich inzwischen geändert — nichts bestätigt. Bitte den Token neu speichern.' }
            writeProxmoxAppSetup({ ...setup, bestaetigt: true, bestaetigtAt: new Date((deps.now || Date.now)()).toISOString() }, deps)
            const check = await pruefeProxmox(deps)
            if (check.poolFehlt) await poolKarte(setup.pool, deps)
            return { ok: true, message: `Bestätigt. ${check.text}` }
        },
        async reject() { return { ok: true, message: 'Nicht bestätigt — ich verbinde mich nicht mit diesem Server.' } },
        // 2.89: closed once this fingerprint is confirmed, or when the stored setup has another one.
        isStillOpen(card) {
            const setup = readProxmoxAppSetup(deps)
            const fp = normalizeFingerprint(card.aktion.ref)
            return Boolean(setup && fp && setup.fingerprint === fp && !setup.bestaetigt)
        },
    }, {
        kind: POOL_KIND, impact: 'infra', allowAlways: () => false,
        async execute() {
            const check = await pruefeProxmox(deps)
            if (check.poolFehlt) return { ok: false, message: `${check.text} Lege ihn in Proxmox an; danach reicht „prüf Proxmox“.` }
            return { ok: check.ok, message: check.text }
        },
        async reject() { return { ok: true, message: 'Gut, ohne Pool sehe ich nur zu und steuere nichts.' } },
        // 2.89: closed when the Proxmox setup is gone or uses another pool; whether the pool exists
        // is read from Proxmox on the press (it lives there, not here).
        isStillOpen(card) { const setup = readProxmoxAppSetup(deps); return Boolean(setup && setup.pool === card.aktion.ref) },
    }]
}

export function registerProxmoxSetupExecutors(deps: SetupDeps = {}, options: { force?: boolean } = {}): void {
    for (const executor of createProxmoxSetupExecutors(deps)) {
        if (!options.force && getCardExecutor(executor.kind) && !deps.cardOpts) continue
        registerCardExecutor(executor)
    }
}
