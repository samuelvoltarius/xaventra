/**
 * Standbild bei Wächter-Ereignis über die Panoptes-Kopplung (Besitzer 30.10.2026: „Bilder dürfen zu
 * MiniMax … und ja sie darf es holen“). Schalter Standard aus (`autonomy.panoptes`). Koppeln startet nur
 * der Besitzer, das Recht „Standbild bei Ereignis“ schaltet er in Panoptes selbst ein. Genau ein Bild je
 * ereignisId, höchstens 72 h im privaten Ordner, keine Clips, keine Koordinaten. Der JWT liegt im Tresor.
 */
import { randomInt } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getRuntimeRoot } from '../core/data-root.js'
import { readSecretJson, writeSecretJson } from '../secrets/local-sealed-store.js'
import { erneuereSitzung, holeStandbild, lauscheEreignisse, meldeAb, PanoptesAnfrageAbgewiesen, pollKopplung, starteKopplung, type PanoptesDeps, type PanoptesEreignis } from './panoptes-client.js'

/** `urls`: Tailscale-Adressen des Autos (es kann zwei geben); nie hart im Code, der Rollout setzt sie. */
export interface PanoptesConfig { enabled: boolean; urls: string[] }
export interface Kopplung { jwt: string; kopplungId: string; url: string; pairedAt: number; renewedAt?: number }
export type EreignisDeps = PanoptesDeps & {
    log?: (line: string) => void
    /** path = null: reine Textmeldung. Liefert, ob die Zustellung geklappt hat. */
    notify?: (path: string | null, text: string) => Promise<boolean>
    evaluate?: (path: string) => Promise<string>
}

const MAX_AGE_MS = 72 * 60 * 60_000
const EVENT_MAX_AGE_MS = 15 * 60_000
/** Panoptes erlaubt 10 Abrufe je Minute; wir bleiben deutlich darunter. */
const MAX_PER_MINUTE = 6
const stillDir = () => join(getRuntimeRoot(), '.nova-vision', 'auto')
const kopplungFile = (root: string) => join(root, 'secrets', 'panoptes', 'kopplung.json')
const seenFile = (root: string) => join(root, 'panoptes', 'gesehen.json')
const ART: Record<string, string> = { person: 'Person', bewegung: 'Bewegung' }

let config: PanoptesConfig = { enabled: false, urls: [] }
let dataRoot = ''
let rechtGemeldet = false
const abrufe: number[] = []
const hinweise = new Map<string, number>()

export function parsePanoptesConfig(raw: unknown): PanoptesConfig {
    const value = (raw || {}) as Record<string, unknown>
    const off = { enabled: false, urls: [] }
    if (value.enabled !== true || !Array.isArray(value.urls) || !value.urls.length || value.urls.length > 4) return off
    try {
        const urls = value.urls.map(item => {
            const url = new URL(String(item))
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid')
            return url.href.replace(/\/+$/, '')
        })
        return { enabled: true, urls }
    } catch { return off }
}

export function setPanoptesConfig(next: PanoptesConfig, root: string): void { config = next; dataRoot = root; rechtGemeldet = false; abrufe.length = 0; hinweise.clear() }

/** Offline-Zeiten sind normal (täglicher Neustart, kein Netz): höchstens eine Zeile je Stunde und Art. */
function hinweis(key: string, line: string, deps: EreignisDeps): void {
    const now = (deps.now || Date.now)()
    if (now - (hinweise.get(key) ?? -Infinity) < 60 * 60_000) return
    hinweise.set(key, now)
    ;(deps.log || (text => console.log(`[Panoptes] ${text}`)))(line)
}

/** Die Adressen, zuerst die der Kopplung. */
const adressen = (cfg: PanoptesConfig, kopplung: Kopplung) => [kopplung.url, ...cfg.urls.filter(url => url !== kopplung.url)]

export function readKopplung(root: string): Kopplung | undefined {
    try {
        const value = readSecretJson(kopplungFile(root))
        return typeof value?.jwt === 'string' ? value as Kopplung : undefined
    } catch { return undefined }
}

export function writeKopplung(root: string, kopplung: Kopplung): void {
    mkdirSync(join(root, 'secrets', 'panoptes'), { recursive: true, mode: 0o700 })
    writeSecretJson(kopplungFile(root), kopplung)
}

/** Versiegeln und zurücklesen. Der JWT kommt nur einmal: Erfolg gibt es erst, wenn er wirklich im Tresor liegt. */
export function speichereKopplung(root: string, kopplung: Kopplung): boolean {
    try { writeKopplung(root, kopplung) } catch { return false }
    return readKopplung(root)?.jwt === kopplung.jwt
}

/** Entfernt Standbilder, die älter als 72 h sind; liefert die Anzahl. */
export function pruneAutoStandbilder(now = Date.now()): number {
    const dir = stillDir()
    if (!existsSync(dir)) return 0
    let removed = 0
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        try {
            const stat = lstatSync(path)
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) { rmSync(path, { force: true }); removed++ }
        } catch { /* schon weg */ }
    }
    return removed
}

function readSeen(root: string): string[] {
    try { const value = JSON.parse(readFileSync(seenFile(root), 'utf8')); return Array.isArray(value) ? value : [] } catch { return [] }
}
function markSeen(root: string, id: string): void {
    mkdirSync(join(root, 'panoptes'), { recursive: true })
    writeFileSync(seenFile(root), JSON.stringify([...readSeen(root), id].slice(-256)), { mode: 0o600 })
}

/** Sensing kennt keinen Kanal: der Daemon setzt den Versand. Ohne ihn gilt: nicht zugestellt. */
let notifier: (path: string | null, text: string) => Promise<boolean> = async () => false
export function setPanoptesNotifier(next: typeof notifier): void { notifier = next }
const defaultNotify = (path: string | null, text: string) => notifier(path, text)

async function defaultEvaluate(path: string): Promise<string> {
    const { hasMiniMaxKey, minimaxVisionFile } = await import('../tools/minimax-tools.js')
    if (!hasMiniMaxKey()) return ''
    return minimaxVisionFile(path, 'Was ist auf diesem Bild einer Fahrzeugkamera zu sehen? Ein kurzer Satz auf Deutsch. Keine Ortsangaben, keine Kennzeichen.')
}

export async function verarbeiteEreignis(root: string, cfg: PanoptesConfig, event: PanoptesEreignis, deps: EreignisDeps = {}): Promise<{ status: string }> {
    const log = deps.log || (line => console.log(`[Panoptes] ${line}`))
    const now = (deps.now || Date.now)()
    if ('ohneId' in event) { log('Ereignis ohne ereignisId; nichts geholt, nichts erraten.'); return { status: 'ohne-id' } }
    const kopplung = readKopplung(root)
    if (!kopplung) return { status: 'nicht-gekoppelt' }
    const id = event.ereignisId
    if (readSeen(root).includes(id)) return { status: 'doppelt' }
    if (now - event.zeit > EVENT_MAX_AGE_MS) return { status: 'zu-alt' }
    while (abrufe.length && now - abrufe[0] > 60_000) abrufe.shift()
    if (abrufe.length >= MAX_PER_MINUTE) { log('Eigene Drosselung: Ereignis ohne Abruf übersprungen.'); return { status: 'gedrosselt' } }
    abrufe.push(now)
    // Vor dem Abruf merken: Auch nach einem Absturz gibt es nie ein zweites Bild zu dieser Kennung.
    markSeen(root, id)
    let result: Awaited<ReturnType<typeof holeStandbild>> | null = null
    for (const url of adressen(cfg, kopplung)) {
        try { result = await holeStandbild(url, kopplung.jwt, id, deps); break } catch { /* nächste Adresse */ }
    }
    if (!result) { hinweis('standbild', 'Panoptes nicht erreichbar; Standbild nicht geholt.', deps); return { status: 'nicht-erreichbar' } }
    if (result.ok === false) {
        if (result.grund === 'nicht_erlaubt' && !rechtGemeldet) {
            rechtGemeldet = true
            await (deps.notify || defaultNotify)(null, 'Panoptes gibt mir noch kein Standbild: Bitte unter Gekoppelte Geräte → Xaventra „Standbild bei Ereignis“ einschalten.').catch(() => false)
        }
        return { status: result.grund }
    }
    pruneAutoStandbilder(Date.now())
    const dir = stillDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `panoptes_${id}.jpg`)
    writeFileSync(path, result.bytes, { mode: 0o600, flag: 'wx' })
    const zeit = new Date(event.zeit).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' })
    let satz = ''
    try { satz = await (deps.evaluate || defaultEvaluate)(path) } catch { log('Auswertung nicht möglich; Bild geht ohne Text raus.') }
    const text = [`Wächter: ${ART[event.art]} am Auto, ${zeit} Uhr.`, satz].filter(Boolean).join(' ')
    const delivered = await (deps.notify || defaultNotify)(path, text).catch(() => false)
    return { status: delivered ? 'gemeldet' : 'nicht-zugestellt' }
}

let abort: AbortController | null = null
let renewTimer: ReturnType<typeof setInterval> | null = null

/**
 * Hört auf Ereignisse. Abbrüche sind normal (täglicher Neustart ~22:10, Zeiten ohne Netz): wiederverbinden
 * mit wachsendem Abstand bis 5 min, reihum über die Adressen, keine Flut, keine Meldung an den Besitzer. Nur eine
 * Verbindung, die mindestens eine Minute hielt, setzt den Abstand zurück. 401/403 beendet: neu koppeln.
 */
export async function lauschSchleife(root: string, cfg: PanoptesConfig, deps: EreignisDeps & { signal: AbortSignal }): Promise<'abgelehnt' | 'ohne-kopplung' | 'beendet'> {
    const now = deps.now || Date.now
    const sleep = deps.sleep || (ms => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); (timer as any).unref?.() }))
    let backoffMs = 5000, index = 0
    while (!deps.signal.aborted) {
        const kopplung = readKopplung(root)
        if (!kopplung) return 'ohne-kopplung'
        const liste = adressen(cfg, kopplung)
        const url = liste[index % liste.length], begin = now()
        let status = 0
        try {
            status = (await lauscheEreignisse(url, kopplung.jwt, { ...deps,
                onEreignis: async event => { await verarbeiteEreignis(root, cfg, event, deps).catch(() => hinweis('ereignis', 'Ereignis konnte nicht verarbeitet werden.', deps)) } })).status
        } catch { if (deps.signal.aborted) return 'beendet' }
        if (status === 401 || status === 403) {
            hinweis('strom', `Ereignisstrom abgelehnt (${status}); bitte neu koppeln.`, deps)
            await (deps.notify || defaultNotify)(null, 'Panoptes nimmt die Kopplung nicht mehr an. Bitte mit /panoptes koppeln neu koppeln.').catch(() => false)
            return 'abgelehnt'
        }
        if (status !== 200) { index++; hinweis('offline', 'Panoptes nicht erreichbar; ich versuche es weiter.', deps) }
        if (now() - begin >= 60_000) backoffMs = 5000
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 5 * 60_000)
    }
    return 'beendet'
}

/** Täglich erneuern (frischer JWT, 30 Tage, gleiche Kopplung). Offline bleibt der alte, der nächste Lauf versucht es wieder. */
export async function erneuereFaellig(root: string, cfg: PanoptesConfig, deps: EreignisDeps = {}): Promise<boolean> {
    const kopplung = readKopplung(root)
    const now = (deps.now || Date.now)()
    if (!kopplung || now - (kopplung.renewedAt ?? kopplung.pairedAt) < 24 * 60 * 60_000) return false
    for (const url of adressen(cfg, kopplung)) {
        try {
            const jwt = await erneuereSitzung(url, kopplung.jwt, deps)
            if (jwt) {
                if (speichereKopplung(root, { ...kopplung, jwt, renewedAt: now })) return true
                hinweis('erneuern', 'Neuer Panoptes-Zugang konnte nicht gespeichert werden; der alte bleibt.', deps)
                return false
            }
        } catch { /* nächste Adresse */ }
    }
    hinweis('erneuern', 'Panoptes-Sitzung nicht erneuert; nächster Versuch in einer Stunde.', deps)
    return false
}

function starteLauscher(root: string, cfg: PanoptesConfig, deps: EreignisDeps = {}): void {
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    void lauschSchleife(root, cfg, { ...deps, signal: controller.signal }).catch(() => undefined)
    if (renewTimer) clearInterval(renewTimer)
    // Stündlich prüfen: Das Auto ist nicht immer erreichbar, fällig wird es erst nach 24 h.
    renewTimer = setInterval(() => { void erneuereFaellig(root, cfg, deps).catch(() => undefined) }, 60 * 60_000)
    ;(renewTimer as any).unref?.()
}

/** Beim Daemon-Start, nur am Main. Ohne Schalter oder Kopplung geschieht nichts. */
export function startPanoptes(raw: unknown, root: string, deps: EreignisDeps = {}): { started: boolean; reason: string } {
    setPanoptesConfig(parsePanoptesConfig(raw), root)
    if (!config.enabled) return { started: false, reason: 'autonomy.panoptes aus' }
    pruneAutoStandbilder()
    if (!readKopplung(root)) return { started: false, reason: 'noch nicht gekoppelt' }
    starteLauscher(root, config, deps)
    return { started: true, reason: 'hört auf Wächter-Ereignisse' }
}

export function stopPanoptes(): void {
    abort?.abort(); abort = null
    if (renewTimer) clearInterval(renewTimer)
    renewTimer = null
}

/** /panoptes [status|koppeln|entkoppeln]. Koppeln startet nur der Besitzer; die Prüfzahl vergleicht er am Auto. */
export async function handlePanoptesCommand(args: string, principal: { principalId?: string; permission?: string } | undefined, deps: EreignisDeps & { onFertig?: (text: string) => void } = {}): Promise<string> {
    if (principal?.permission !== 'owner') return '⛔ /panoptes ist nur für den Owner.'
    if (!config.enabled) return 'Panoptes ist aus. Einschalten: autonomy.panoptes { enabled: true, url } in der Konfiguration.'
    const root = dataRoot
    const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || 'status'
    if (sub === 'koppeln') {
        const pruefzahl = String(randomInt(1000, 10000))
        const finish = deps.onFertig || (text => { void (deps.notify || defaultNotify)(null, text).catch(() => false) })
        let start: Awaited<ReturnType<typeof starteKopplung>> | null = null, url = ''
        for (const candidate of config.urls) {
            try { start = await starteKopplung(candidate, pruefzahl, deps); url = candidate; break }
            catch (error) { if (error instanceof PanoptesAnfrageAbgewiesen) return `Panoptes hat die Kopplung abgewiesen (${error.grund}). Nichts gekoppelt.` }
        }
        if (!start) return 'Panoptes antwortet nicht. Nichts gekoppelt.'
        // Kein Wiederholen: Abgelehnt ist abgelehnt, und der JWT kommt nur beim ersten Abruf.
        void pollKopplung(url, start, deps).then(result => {
            if (result.status !== 'erlaubt') return finish('Die Kopplung mit Panoptes kam nicht zustande. Nichts gespeichert.')
            if (!speichereKopplung(root, { jwt: result.jwt, kopplungId: result.kopplungId, url, pairedAt: (deps.now || Date.now)() })) {
                return finish('Panoptes hat erlaubt, aber ich konnte den Zugang nicht sicher speichern. Bitte neu koppeln.')
            }
            starteLauscher(root, config, { ...deps, sleep: undefined })
            finish('Mit Panoptes gekoppelt. Bitte jetzt unter Gekoppelte Geräte → Xaventra „Standbild bei Ereignis“ einschalten.')
        }).catch(() => finish('Die Kopplung mit Panoptes kam nicht zustande. Nichts gespeichert.'))
        return `Prüfzahl ${pruefzahl}. Bitte am Auto vergleichen und dort erlauben.`
    }
    if (sub === 'entkoppeln') {
        const kopplung = readKopplung(root)
        if (!kopplung) return 'Es besteht keine Kopplung.'
        stopPanoptes()
        const gemeldet = await meldeAb(kopplung.url, kopplung.jwt, deps).catch(() => false)
        rmSync(kopplungFile(root), { force: true })
        return gemeldet ? 'Von Panoptes abgemeldet; der Zugang ist gelöscht.' : 'Zugang gelöscht, aber Panoptes war nicht erreichbar: bitte die Kopplung dort auch entfernen.'
    }
    return readKopplung(root) ? 'Mit Panoptes gekoppelt. Standbilder kommen nur bei Wächter-Ereignissen, wenn das Recht in Panoptes an ist.' : 'Noch nicht gekoppelt. /panoptes koppeln zeigt die Prüfzahl.'
}
