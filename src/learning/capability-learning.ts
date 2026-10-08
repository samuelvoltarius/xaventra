/**
 * 2.88 „Was ich nicht kann, lerne ich“ (Owner-Wunsch 07.10.2026).
 *
 * 1. Ehrliche Fähigkeitsprüfung. Fragt jemand „Kannst du X?“ oder bittet um X,
 *    entscheidet `assessCapability` ohne Modell gegen das echte Inventar
 *    (Werkzeug-Register inkl. Schmiede-Werkzeuge, verbundene Dienste,
 *    gelernte Fähigkeiten):
 *      kann        → nichts abgefangen, der normale Weg antwortet;
 *      kann-nicht  → „Nein, das kann ich noch nicht. Soll ich es lernen?“ +
 *                    EINE Karte Ja/Nein (Owner, direkte Antwort);
 *      unklar      → das Modell antwortet, mit fester Ehrlichkeitsregel im
 *                    Prompt; nutzt es die Formel, folgt dieselbe Karte
 *                    (`offerLearningAfterReply`).
 * 2. Bei Ja ein Lernauftrag im Hintergrund (sichtbar als Gedanke „Lernt: …“):
 *    vorhandenes Werkzeug? → geprüfter Connector-Katalog + MCP-Verzeichnis →
 *    Websuche (bestehende Suchkette inkl. SearXNG). Quellen werden bewertet
 *    (https, Projekt-/Doku-Quelle, Pflege, Lizenz, Sicherheit); Anleitungen mit
 *    `curl | sh` & Co. werden verworfen — aus dem Netz wird nie etwas ausgeführt.
 * 3. Umsetzen, erster passender Weg in fester Reihenfolge:
 *    (a) Rezept aus vorhandenen Werkzeugen = Werkzeug-Schmiede (Sandbox, Tests,
 *        statische Prüfung; lesend → selbst aktiv, mit Wirkung → Karte) — nur,
 *        wenn das Feld keinen Dienst und keine Software braucht;
 *    (b) geprüfter Connector → die bestehende „Verbinden“-Karte;
 *    (c) Software → Werkzeugkasten/Install-Katalog → Installationskarte
 *        (signiertes Ticket, Rückweg, Nie-Liste);
 *    (d) sonst, wenn seriöse Quellen da sind: nur ein notierter
 *        Code-Erweiterungs-Vorschlag für PATCH_GATE — nie angewendet.
 * 4. Selbsttest mit einem echten Beispiel (lesendes Werkzeug: ein Lauf in der
 *    Sandbox; mit Wirkung: der erste echte Erfolg; Verbindung: verbunden und
 *    getestet; Paket: läuft), dann „Gelernt: X. Probier mal: …“. Scheitert es:
 *    ehrlich, was fehlt; gemerkt; höchstens 2 Versuche, 7 Tage Pause, ein
 *    Owner-Nein gilt 30 Tage. Infrastrukturfehler zählen nie als Versuch.
 * 5. Nach der Übernahme wird weiter gemessen (Fehlerrate, Laufzeit gegen den
 *    Stand bei der Übernahme). Verschlechtert es sich: automatisch zurückrollen
 *    (Werkzeug aus) und kurz melden. Fehlschläge gehen in die Failure-Memory
 *    (correction-detector; Infrastrukturfehler zählen dort nicht).
 *
 * Datei: <data>/lernen/faehigkeiten.json. Keine Geheimnisse, Themen gekürzt
 * und ohne Geheimnis-Muster.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { ApprovalCard, CardExecutor, NewCardInput } from '../core/approval-cards.js'
import { isNieAktionsart } from '../core/action-policy.js'
import { getNovaDataDir } from '../core/data-root.js'
import { topicSimilarity, topicTokens } from '../core/decisions.js'
import { isInfrastructureFailure } from '../core/infrastructure-failure.js'
import { sideEffectsDisabled } from '../core/side-effects.js'
import type { SoftwareCapability } from '../install/software-candidates.js'
import type { Skill } from '../mesh/node-strengths.js'
import type { CapabilityInventory, LearnedCapability } from './capability-inventory.js'
import type { SearchHit, WebSearchPort } from '../install/software-freshness.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { connectedConnectorIds } from '../connections/connection-state.js'

// ---------------------------------------------------------------------------
// Felder, für die „kann ich / kann ich nicht“ ohne Modell belastbar ist
// ---------------------------------------------------------------------------

export interface CapabilityDomain {
    id: string
    /** Kurz, für Meldungen: „Gelernt: <label>“. */
    label: string
    /** Worauf eine Bitte passt (ganze Wörter, Deutsch). */
    words: RegExp
    /** Welche Werkzeuge (Register-Namen) das Feld abdecken. */
    tools: RegExp
    /** Geprüfte Connectoren, die das Feld abdecken (src/connections). */
    connectors?: readonly string[]
    /** Werkzeuge, die nur über die Verbindung eines Connectors laufen (ohne Verbindung zählen sie nicht). */
    connectorTools?: RegExp
    /** Was ein Knoten im Mesh können muss, damit das Feld geht (node-strengths). */
    meshSkill?: Skill
    /** Software-Fähigkeit des Werkzeugkastens (src/install). */
    software?: SoftwareCapability
    /** Ein Satz zum Ausprobieren nach dem Lernen. */
    beispiel: string
}

const W = (body: string) => new RegExp(body, 'iu')

/** Reihenfolge zählt: das erste passende Feld gilt (z. B. Mail senden vor Mail lesen). */
export const CAPABILITY_DOMAINS: readonly CapabilityDomain[] = Object.freeze([
    { id: 'fax', label: 'Faxe senden', words: W('(?<![\\p{L}])fax\\p{L}*'), tools: /^(fax[_-]|send_fax)/, beispiel: 'Schick ein Fax an …' },
    { id: 'sms', label: 'SMS senden', words: W('(?<![\\p{L}])(sms|simse\\p{L}*|kurznachricht\\p{L}*)(?![\\p{L}])'), tools: /^(sms[_-]|send_sms)/, beispiel: 'Schick eine SMS an …' },
    { id: 'musik', label: 'Musik abspielen', words: W('(?<![\\p{L}])spotify(?![\\p{L}])|(?<![\\p{L}])(abspiel|spiel)\\p{L}*[^.?!]{0,40}(musik|lied|song|playlist|radio)|(musik|lied|song|playlist)\\p{L}*[^.?!]{0,40}(abspiel|spiel)'), tools: /^(spotify[_-]|music[_-]|media_play|sonos[_-]|hass_service$)/, beispiel: 'Spiel meine Lieblings-Playlist' },
    { id: 'mail-senden', label: 'E-Mails senden', words: W('(?<![\\p{L}])(schick|send|verschick)\\p{L}*[^.?!]{0,50}(?<![\\p{L}])(e-?mail|mail)s?(?![\\p{L}])|(?<![\\p{L}])(e-?mail|mail)s?(?![\\p{L}])[^.?!]{0,50}(schick|send|verschick)'), tools: /^(send_email|email_send|mail_send|gmail_send|smtp[_-])/, beispiel: 'Schick eine Mail an …' },
    { id: 'mail-lesen', label: 'Mails lesen', words: W('(?<![\\p{L}])(e-?mails?|mails?|postfach|posteingang)(?![\\p{L}])'), tools: /^(gmail|mail_|email_|imap[_-])/, connectors: ['gmail'], connectorTools: /^gmail/, beispiel: 'Was ist heute an Mails gekommen?' },
    { id: 'kalender', label: 'Kalender lesen', words: W('(?<![\\p{L}])kalender\\p{L}*|(?<![\\p{L}])(meine|welche|nächsten|naechsten|heutigen|morgigen)\\s+(termine?|besprechungen)(?![\\p{L}])'), tools: /^(calendar|kalender)/, connectors: ['google-calendar'], connectorTools: /^(calendar|kalender)/, beispiel: 'Was steht morgen im Kalender?' },
    { id: 'bild', label: 'Bilder erzeugen', words: W('(?<![\\p{L}])(bild|foto|logo|grafik|illustration)\\p{L}*[^.?!]{0,40}(erzeug|generier|erstell|mal|zeichn)|(?<![\\p{L}])(mal|zeichne)\\p{L}*[^.?!]{0,30}(bild|logo)'), tools: /^(generate_image|minimax_image_gen|image_gen)/, meshSkill: 'bilder', beispiel: 'Mal mir ein Bild von einem Leuchtturm' },
    { id: 'video', label: 'Videos erzeugen', words: W('(?<![\\p{L}])video\\p{L}*[^.?!]{0,40}(erzeug|generier|erstell)'), tools: /^(minimax_video_start|generate_video|video_gen)/, beispiel: 'Erzeug ein kurzes Video von …' },
    { id: 'stt', label: 'Sprachnachrichten abschreiben', words: W('(?<![\\p{L}])(sprachnachricht|sprachmemo|audio|aufnahme)\\p{L}*[^.?!]{0,40}(abschreib|transkrib|verschrift|als text)|transkrib'), tools: /^(transcribe_audio|stt[_-]|whisper)/, software: 'stt', meshSkill: 'stt', beispiel: 'Schreib mir die Sprachnachricht ab' },
    { id: 'tts', label: 'Vorlesen', words: W('(?<![\\p{L}])(vorlesen|vorles|laut vor)|(?<![\\p{L}])lies\\p{L}*[^.?!]{0,30}(?<![\\p{L}])vor(?![\\p{L}])'), tools: /^(speak|minimax_tts|tts[_-])/, software: 'tts', meshSkill: 'tts', beispiel: 'Lies mir die Nachricht vor' },
    { id: 'vision', label: 'Bilder lesen', words: W('(?<![\\p{L}])(text|schrift)(?![\\p{L}])[^.?!]{0,30}(bild|foto|scan|screenshot)|(?<![\\p{L}])ocr(?![\\p{L}])|(erkenn|beschreib)\\p{L}*[^.?!]{0,30}(bild|foto)'), tools: /^(analyze_image|screen_analyze|minimax_vision|ocr[_-]|vision[_-])/, software: 'vision', meshSkill: 'vision', beispiel: 'Was steht auf diesem Foto?' },
    { id: 'github', label: 'GitHub lesen', words: W('(?<![\\p{L}])(github|issues?|pull requests?)(?![\\p{L}])'), tools: /^(github|gh_)/, connectors: ['github'], connectorTools: /^(github|gh_)/, beispiel: 'Welche Issues sind offen?' },
    { id: 'fotos', label: 'Fotos durchsuchen', words: W('(?<![\\p{L}])(meine|unsere)\\s+(fotos|bilder|alben)(?![\\p{L}])|(?<![\\p{L}])immich(?![\\p{L}])'), tools: /^immich/, connectors: ['immich'], connectorTools: /^immich/, beispiel: 'Zeig mir Fotos vom Urlaub' },
    { id: 'dokumente', label: 'Dokumente suchen', words: W('(?<![\\p{L}])paperless(?![\\p{L}])|(?<![\\p{L}])(meine|die)\\s+(rechnung|rechnungen|dokumente)(?![\\p{L}])'), tools: /^paperless/, connectors: ['paperless'], connectorTools: /^paperless/, beispiel: 'Such die Stromrechnung vom März' },
] satisfies CapabilityDomain[])

export function findDomain(text: string): CapabilityDomain | undefined {
    const value = String(text || '').slice(0, 600)
    return CAPABILITY_DOMAINS.find(domain => domain.words.test(value))
}

// ---------------------------------------------------------------------------
// Frage / Bitte erkennen
// ---------------------------------------------------------------------------

export interface CapabilityRequest { question: boolean; topic: string }

const ASK = /^\s*(?:(?:hey|hallo|hi)\s+\p{L}+[,!]?\s*)?(?:kannst|könntest|koenntest|kannste)\s+du\s+((?:(?:mir|uns|bitte|eigentlich|auch|schon|denn|jetzt)\s+)*)(.+?)\s*[?.!]*\s*$/isu
const ABLE = /^\s*bist\s+du\s+(?:in\s+der\s+lage|fähig|faehig)[,]?\s+(?:zu\s+)?(.+?)\s*[?.!]*\s*$/isu
const IMPERATIVE = /^\s*(?:bitte\s+)?(?:schick|send|verschick|ruf\s|spiel|erstell|erzeug|generier|zeig|lies|schreib|transkribier|mal\s|zeichne|such|trag|buch|bestell|fax)\p{L}*/iu
const PLEASE = /(?<![\p{L}])bitte(?![\p{L}])/iu

/** „Kannst du …?“, „Bist du in der Lage …“ oder eine Bitte („Schick bitte …“). Wissensfragen und Erzählungen nicht. */
export function detectCapabilityRequest(text: unknown): CapabilityRequest | null {
    const value = String(text ?? '').trim()
    if (!value || value.startsWith('/') || value.length > 400) return null
    const ask = ASK.exec(value)
    if (ask) return { question: true, topic: clip(ask[2], 160) }
    const able = ABLE.exec(value)
    if (able) return { question: true, topic: clip(able[1], 160) }
    if (IMPERATIVE.test(value) || (PLEASE.test(value) && !value.trim().endsWith('?'))) {
        return { question: false, topic: clip(value.replace(/(?<![\p{L}])bitte(?![\p{L}])\s*/giu, '').replace(/[?.!]+\s*$/, ''), 160) }
    }
    return null
}

// ---------------------------------------------------------------------------
// Inventar und Urteil
// ---------------------------------------------------------------------------

// 2.89: the inventory is built in ONE place (capability-inventory.ts); the gate only judges.
export type { CapabilityInventory, LearnedCapability } from './capability-inventory.js'

export type CapabilityVerdict =
    | { status: 'kann'; via: string[] }
    | { status: 'kann-nicht'; domain: CapabilityDomain; topic: string; broken?: string[] }
    /** The tool is registered, but the connection behind it is not connected (not a thing to learn). */
    | { status: 'kann-nicht-verbunden'; domain: CapabilityDomain; topic: string; connector: string }
    | { status: 'unklar'; topic: string }

const SAME_TOPIC = 0.75

export function assessCapability(text: string, inventory: CapabilityInventory): CapabilityVerdict {
    const topic = detectCapabilityRequest(text)?.topic ?? clip(text, 160)
    const domain = findDomain(topic) || findDomain(text)
    const tokens = topicTokens(topic)
    const learned = inventory.learned.find(item => (domain && item.domainId === domain.id) || topicSimilarity(tokens, topicTokens(item.topic)) >= SAME_TOPIC)
    if (learned) return { status: 'kann', via: learned.tools.length ? [...learned.tools] : [`gelernt:${learned.signature}`] }
    if (!domain) return { status: 'unklar', topic }
    const connectors = domain.connectors || []
    const connected = connectors.filter(id => inventory.connected.has(id))
    const registered = inventory.tools.filter(name => domain.tools.test(name))
    // A registered tool counts only if it works here (one tool-health store) and, when it runs
    // through a connector, only while that connection is connected.
    const broken = registered.filter(name => inventory.brokenTools?.has(name))
    const needsConnection = (name: string) => Boolean(domain.connectorTools?.test(name)) && connectors.length > 0 && !connected.length
    const working = registered.filter(name => !inventory.brokenTools?.has(name) && !needsConnection(name))
    if (working.length) return { status: 'kann', via: working.slice(0, 5) }
    // Another node can do it (Whisper on a different machine is "can": stt).
    const nodes = domain.meshSkill ? inventory.mesh?.get(domain.meshSkill) || [] : []
    if (nodes.length) return { status: 'kann', via: nodes.slice(0, 5).map(id => `knoten:${id}`) }
    if (connected.length) return { status: 'kann', via: connected.map(id => `verbindung:${id}`) }
    const unconnected = registered.find(name => !inventory.brokenTools?.has(name) && needsConnection(name))
    if (unconnected) return { status: 'kann-nicht-verbunden', domain, topic, connector: connectors[0] }
    return { status: 'kann-nicht', domain, topic, ...(broken.length ? { broken: broken.slice(0, 5) } : {}) }
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

export const HONEST_NO = 'Nein, das kann ich noch nicht. Soll ich es lernen?'
const PLAIN_NO = 'Nein, das kann ich noch nicht.'
const NEVER_NO = 'Nein, das kann ich nicht — und das lerne ich nicht selbst (steht auf meiner Nie-Liste).'
const RUNNING_NO = 'Nein, noch nicht — das lerne ich gerade. Ich melde mich, sobald es geht.'
const CODE_NO = 'Nein, das kann ich noch nicht. Dafür braucht es eine Code-Erweiterung; der Vorschlag liegt bei dir.'

/** Feste Regel für den Prompt (Modell-Weg, wenn kein Feld passt). */
export function capabilityHonestyPrompt(): string {
    return '## Ehrlich bei Fähigkeiten\n'
        + 'Hast du für eine Bitte kein passendes Werkzeug und kannst sie auch nicht allein mit Wissen oder Text erledigen, '
        + `dann erfinde nichts und such keine Ausrede. Antworte genau: „${HONEST_NO}“`
}

/** Hat die Modell-Antwort die Ehrlichkeitsformel benutzt? */
export function replyOffersLearning(text: unknown): boolean {
    const value = String(text ?? '')
    return /das\s+kann\s+ich\s+noch\s+nicht/i.test(value) && /soll\s+ich\s+(es|das)\s+lernen\s*\?/i.test(value)
}

// ---------------------------------------------------------------------------
// Quellen prüfen
// ---------------------------------------------------------------------------

export interface RatedSource { url: string; title: string; score: number; notes: string[]; unsicher: boolean }

const TRUSTED_HOST = /(^|\.)(github\.com|gitlab\.com|codeberg\.org|pypi\.org|npmjs\.com|registry\.modelcontextprotocol\.io|readthedocs\.io)$/i
const DOC_HOST = /^(docs|developer|developers|api|dev)\./i
const LOW_HOST = /(^|\.)(pinterest\.[a-z.]+|quora\.com|medium\.com|reddit\.com|youtube\.com|facebook\.com|tiktok\.com)$/i
const LICENSE = /(?<![\p{L}])(MIT|Apache[- ]?2(?:\.0)?|BSD|MPL|LGPL|AGPL|GPL)(?![\p{L}])/u
const STALE = /archived|deprecated|unmaintained|abandoned|no longer maintained|veraltet|eingestellt/i
/** Internet-Anleitungen, die nie ausgeführt werden (Owner 07.10.: curl | bash direkt/als root strikt verboten). */
const UNSAFE = /(curl|wget)\s[^|\n]{0,200}\|\s*(sudo\s+)?(ba|z|k)?sh(?![\p{L}])|iex\s*\(|invoke-expression|chmod\s+777|disable\s+(the\s+)?firewall|setenforce\s+0/iu

export function rateSource(hit: SearchHit, now = Date.now()): RatedSource {
    const url = String(hit?.url || '')
    const title = clip(redactSecrets(String(hit?.title || '')), 120)
    let parsed: URL | null = null
    try { parsed = new URL(url) } catch { parsed = null }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) return { url, title, score: -5, notes: ['nicht https'], unsicher: false }
    const text = `${hit.title || ''} ${hit.snippet || ''}`
    const notes: string[] = []
    let score = 0
    if (TRUSTED_HOST.test(parsed.hostname) || DOC_HOST.test(parsed.hostname)) { score += 2; notes.push('Projekt-/Doku-Quelle') }
    if (LOW_HOST.test(parsed.hostname)) { score -= 1; notes.push('Forum/Blog') }
    const license = LICENSE.exec(text)
    if (license) { score += 1; notes.push(`Lizenz ${license[1]}`) }
    const year = new Date(now).getUTCFullYear()
    const years = [...text.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map(match => Number(match[1])).filter(value => value <= year + 1)
    const newest = years.length ? Math.max(...years) : null
    if (newest !== null && newest >= year - 1) { score += 1; notes.push(`gepflegt (${newest})`) }
    else if (newest !== null && newest <= year - 3) { score -= 1; notes.push(`alt (${newest})`) }
    if (STALE.test(text)) { score -= 2; notes.push('nicht mehr gepflegt') }
    const unsicher = UNSAFE.test(text)
    if (unsicher) { score -= 5; notes.push('Anleitung mit curl|sh o. ä. — wird nie ausgeführt') }
    return { url: url.slice(0, 300), title, score, notes, unsicher }
}

/** Suchanfrage ohne Nummern, Adressen und Links aus der Nachricht (Privatsphäre). */
export function searchQueryFor(topic: string, domain: CapabilityDomain | undefined): string {
    const base = domain ? domain.label : String(topic || '')
    const cleaned = redactSecrets(base)
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\S+@\S+/g, ' ')
        .replace(/\+?\d[\d\s/().-]{2,}\d/g, ' ')
        .replace(/\d{3,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100)
    return `${cleaned} API OR MCP server OR CLI open source`
}

// ---------------------------------------------------------------------------
// Lernaufträge (Datei)
// ---------------------------------------------------------------------------

export type LearnStatus = 'angeboten' | 'abgelehnt' | 'recherche' | 'umsetzung' | 'wartet-auf-freigabe' | 'selbsttest' | 'gelernt' | 'gescheitert' | 'code-vorschlag' | 'zurueckgerollt'
export type LearnWay = 'vorhanden' | 'rezept' | 'verbindung' | 'paket' | 'code'
export interface ForgeHealth { status: string; calls: number; failures: number; totalMs?: number }

export interface LearnJob {
    id: string
    signature: string
    topic: string
    domainId?: string
    ownerId: string
    status: LearnStatus
    createdAt: string
    updatedAt: string
    /** Zählende Lernversuche (Infrastrukturfehler nie). */
    attempts: number
    weg?: LearnWay
    /** Schmiede-Id, Connector-Id, Katalog-Id oder Gedanken-Id. */
    ref?: string
    /** Register-Name des Werkzeugs (Schmiede: forge_<name>). */
    tool?: string
    quellen: RatedSource[]
    fehlt?: string
    infrastruktur?: boolean
    cardId?: string
    thoughtId?: string
    wartetSeit?: string
    learnedAt?: string
    baseline?: { calls: number; failures: number; totalMs?: number }
    grund?: string
    history: Array<{ at: string; status: LearnStatus; detail?: string }>
}

interface LearnFile { version: 1; jobs: LearnJob[] }

export const LEARN_CARD_KIND = 'faehigkeit-lernen'
export const JOB_ID_PATTERN = /^lrn-[a-f0-9]{12}$/
export const MAX_ATTEMPTS = 2
export const RETRY_PAUSE_MS = 7 * 24 * 60 * 60_000
export const NO_MUTE_MS = 30 * 24 * 60 * 60_000
export const WAIT_LIMIT_MS = 7 * 24 * 60 * 60_000
const OFFER_TTL_MS = 24 * 60 * 60_000
const MAX_JOBS = 200
const MAX_HISTORY = 20
const RUNNING: ReadonlySet<LearnStatus> = new Set(['recherche', 'umsetzung', 'wartet-auf-freigabe', 'selbsttest'])
/** Messung nach der Übernahme. */
export const MONITOR_MIN_CALLS = 3

// ---------------------------------------------------------------------------
// Ports (Produktion: defaultLearnDeps; Tests: eigene)
// ---------------------------------------------------------------------------

export type RecipeResult = { status: 'aktiv' | 'wartet' | 'spaeter' | 'fehlgeschlagen'; ref?: string; tool?: string; detail: string }
export type ProbeResult = { result: 'ok' | 'warten' | 'fehler'; detail?: string }

export interface LearnDeps {
    dataDir?: string
    now?: () => number
    inventory(): Promise<CapabilityInventory>
    /**
     * 2.89: the latest inventory without waiting (card maintenance is synchronous): a
     * „Soll ich es lernen?“ card closes itself once the ability is there. null = not known yet.
     */
    inventoryNow?(): CapabilityInventory | null
    search: WebSearchPort | null
    /** MCP-Verzeichnis (Community, ungeprüft; nur gelesen). */
    directory(query: string): Array<{ name: string; title?: string }>
    /** Geprüfte Connectoren für dieses Thema, die noch nicht verbunden sind. */
    connectors(topic: string, domain: CapabilityDomain | undefined): string[]
    hasRecipeBuilder(): boolean
    /** (a) Werkzeug-Schmiede: bauen, testen, aktivieren (lesend) oder Karte. */
    recipe(input: { topic: string; label: string; quellen: RatedSource[]; ownerId: string; signature: string }): Promise<RecipeResult>
    /** (b) die bestehende „Verbinden“-Karte. */
    connect(connectorId: string): Promise<{ ok: boolean; message: string }>
    /** (c) Werkzeugkasten/Install-Katalog → Installationskarte. */
    softwareInstall(capability: SoftwareCapability): Promise<{ ok: boolean; message: string; ref?: string } | null>
    /** (d) Code-Erweiterung nur als Vorschlag notieren; liefert eine Gedanken-Id. */
    proposeCode(job: LearnJob): Promise<string | null>
    /** Selbsttest bzw. „ist es inzwischen da?“. */
    probe(job: LearnJob): Promise<ProbeResult>
    forgeHealth(ref: string): ForgeHealth | null
    rollback(job: LearnJob, reason: string): Promise<boolean>
    /** Kurze Meldung an den Owner. */
    notify(text: string): void
    /** Sichtbarkeit (Gedanke „Lernt: …“). */
    activity(job: LearnJob): void
    rememberFailure(topic: string, reason: string): void
    offerCard(input: NewCardInput): { ok: boolean; card?: ApprovalCard }
    /** Hintergrund-Ausführung. */
    schedule(task: () => Promise<unknown>): void
}

const nowOf = (deps: Pick<LearnDeps, 'now'>) => (deps.now || Date.now)()
const iso = (ms: number) => new Date(ms).toISOString()
const fileOf = (deps: Pick<LearnDeps, 'dataDir'>) => join(deps.dataDir || getNovaDataDir(), 'lernen', 'faehigkeiten.json')

function readFile(deps: Pick<LearnDeps, 'dataDir'>): LearnFile {
    try {
        const path = fileOf(deps)
        if (!existsSync(path)) return { version: 1, jobs: [] }
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        return raw?.version === 1 && Array.isArray(raw.jobs) ? { version: 1, jobs: raw.jobs.filter((job: LearnJob) => JOB_ID_PATTERN.test(String(job?.id))) } : { version: 1, jobs: [] }
    } catch { return { version: 1, jobs: [] } }
}

function writeFile(deps: Pick<LearnDeps, 'dataDir'>, file: LearnFile): void {
    atomicWriteJsonSync(fileOf(deps), { version: 1, jobs: file.jobs.slice(-MAX_JOBS) })
}

/** Neueste zuerst. */
export function listLearnJobs(deps: Pick<LearnDeps, 'dataDir'> = {}): LearnJob[] {
    return readFile(deps).jobs.slice().reverse()
}

export function getLearnJob(id: string, deps: Pick<LearnDeps, 'dataDir'> = {}): LearnJob | null {
    return readFile(deps).jobs.find(job => job.id === id) || null
}

function mutate(deps: Pick<LearnDeps, 'dataDir' | 'now'>, id: string, change: (job: LearnJob) => void, detail?: string): LearnJob | null {
    const file = readFile(deps)
    const job = file.jobs.find(item => item.id === id)
    if (!job) return null
    const before = job.status
    change(job)
    job.updatedAt = iso(nowOf(deps))
    if (job.status !== before || detail) job.history = [...(job.history || []), { at: job.updatedAt, status: job.status, ...(detail ? { detail: clip(detail, 200) } : {}) }].slice(-MAX_HISTORY)
    writeFile(deps, file)
    return job
}

/** Gelernte Fähigkeiten für das Inventar. */
export function learnedCapabilities(deps: Pick<LearnDeps, 'dataDir'> = {}): LearnedCapability[] {
    return readFile(deps).jobs.filter(job => job.status === 'gelernt')
        .map(job => ({ signature: job.signature, topic: job.topic, ...(job.domainId ? { domainId: job.domainId } : {}), tools: job.tool ? [job.tool] : [] }))
}

export function signatureFor(topic: string, domain: CapabilityDomain | undefined): string {
    const key = domain ? `d:${domain.id}` : `t:${topicTokens(topic).sort().slice(0, 8).join(' ')}`
    return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

const domainOf = (job: Pick<LearnJob, 'domainId'>) => CAPABILITY_DOMAINS.find(domain => domain.id === job.domainId)
const labelOf = (job: LearnJob) => domainOf(job)?.label || clip(job.topic, 60)
const exampleOf = (job: LearnJob) => domainOf(job)?.beispiel || `Kannst du ${clip(job.topic, 80)}?`
const dayOf = (at: string) => new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Vienna' })

// ---------------------------------------------------------------------------
// Angebot (ehrliches Nein + Karte)
// ---------------------------------------------------------------------------

export interface LearnContext { principalId: string; permission?: string }

async function offerFor(topic: string, domain: CapabilityDomain | undefined, ctx: LearnContext, deps: LearnDeps): Promise<string> {
    if (isNieAktionsart(topic)) return NEVER_NO
    if (ctx.permission !== 'owner') return PLAIN_NO
    const now = nowOf(deps)
    const signature = signatureFor(topic, domain)
    const previous = readFile(deps).jobs.filter(job => job.signature === signature).at(-1)
    if (previous) {
        const age = now - Date.parse(previous.updatedAt)
        if (RUNNING.has(previous.status)) return RUNNING_NO
        if (previous.status === 'abgelehnt' && age < NO_MUTE_MS) return PLAIN_NO
        if (previous.status === 'code-vorschlag' && age < NO_MUTE_MS) return CODE_NO
        if ((previous.status === 'gescheitert' || previous.status === 'zurueckgerollt') && !previous.infrastruktur
            && (previous.attempts >= MAX_ATTEMPTS || age < RETRY_PAUSE_MS)) {
            const what = previous.status === 'zurueckgerollt' ? `wurde zurückgerollt: ${previous.grund || 'es lief schlechter'}` : `ist gescheitert, es fehlt: ${previous.fehlt || 'ein sicherer Weg'}`
            return `${PLAIN_NO} Mein Lernversuch am ${dayOf(previous.updatedAt)} ${what}.`
        }
    }
    const reuse = previous && previous.status === 'angeboten' ? previous : null
    const file = readFile(deps)
    const job: LearnJob = reuse || {
        id: `lrn-${randomBytes(6).toString('hex')}`,
        signature, topic: clip(redactSecrets(topic), 160), ...(domain ? { domainId: domain.id } : {}), ownerId: clip(ctx.principalId, 80),
        status: 'angeboten', createdAt: iso(now), updatedAt: iso(now), attempts: previous?.attempts ?? 0, quellen: [],
        history: [{ at: iso(now), status: 'angeboten' }],
    }
    if (!reuse) { file.jobs.push(job); writeFile(deps, file) }
    const label = domain?.label || clip(job.topic, 60)
    const offered = deps.offerCard({
        art: LEARN_CARD_KIND,
        titel: `Lernen: ${label}?`,
        beleg: 'Dafür habe ich noch kein Werkzeug, keine Verbindung und keinen Skill.',
        vorschlag: 'Ja = ich suche im Hintergrund einen sicheren Weg und probiere ihn aus. Installationen, Anmeldungen und alles mit Wirkung frage ich extra.',
        aktion: { kind: LEARN_CARD_KIND, ref: job.id },
        wirkung: 'intern',
        ablaufMs: OFFER_TTL_MS,
        quelle: 'lernen',
        dedupeKey: `lernen:${signature}`,
        direkteAntwort: true,
    })
    if (!offered.ok || !offered.card) return PLAIN_NO
    mutate(deps, job.id, item => { item.cardId = offered.card!.id })
    return HONEST_NO
}

/** The tool is there but its connection is not: say that (no "Soll ich es lernen?" - nothing to learn). */
async function notConnectedReply(connector: string, ctx: LearnContext): Promise<string> {
    let title = connector
    try { title = (await import('../connections/connector-catalog.js')).findConnector(connector)?.title || connector } catch { /* title stays the id */ }
    return ctx.permission === 'owner'
        ? `Das Werkzeug dafür habe ich, aber die Verbindung zu ${title} steht noch nicht. Sag „Verbinde dich mit ${title}“, dann richte ich sie ein.`
        : `Dafür ist die Verbindung zu ${title} noch nicht eingerichtet.`
}

/**
 * Pipeline-Eingang (vor dem Modell): eine Fähigkeitsfrage/Bitte, für die belastbar
 * kein Werkzeug da ist, bekommt sofort die ehrliche Antwort. Sonst `handled: false`.
 */
export async function handleCapabilityRequest(text: string, ctx: LearnContext, deps: LearnDeps): Promise<{ handled: boolean; reply?: string }> {
    const request = detectCapabilityRequest(text)
    if (!request) return { handled: false }
    const verdict = assessCapability(text, await deps.inventory())
    console.log(`[Lernen] Fähigkeits-Frage „${request.topic.slice(0, 60)}“ → ${verdict.status}`)
    if (verdict.status === 'kann-nicht-verbunden') return { handled: true, reply: await notConnectedReply(verdict.connector, ctx) }
    if (verdict.status !== 'kann-nicht') return { handled: false }
    return { handled: true, reply: await offerFor(verdict.topic, verdict.domain, ctx, deps) }
}

/** Modell-Weg: die Antwort nutzte die Ehrlichkeitsformel → dieselbe Karte (oder der ehrliche Stand). */
export async function offerLearningAfterReply(request: string, ctx: LearnContext, deps: LearnDeps): Promise<{ reply: string }> {
    const topic = detectCapabilityRequest(request)?.topic ?? clip(request, 160)
    return { reply: await offerFor(topic, findDomain(topic) || findDomain(request), ctx, deps) }
}


// ---------------------------------------------------------------------------
// 2.89.3 Werkzeuglücke mitten im Auftrag
// ---------------------------------------------------------------------------
// Live 08.10.2026: „Wie spät ist es und wie ist das Wetter in Wien?“ — für einen Teil fehlte das Werkzeug, das Modell
// wich auf Websuche/Shell aus und lief ins Budget. Owner: sie soll erkennen, dass ihr das Werkzeug fehlt. Ein Teilauftrag
// ohne Fähigkeit wird ehrlich abgeschlossen („dafür habe ich kein eigenes Werkzeug“), der Rest läuft normal, und die
// vorhandene Lernfrage (dieselbe Karte wie bei „Kannst du ein Fax senden?“) wird angeboten. Nie autonomes Bauen:
// nur Angebot + Eintrag, nach „Ja“ greift der bestehende Lern-Ablauf (Schmiede/PATCH_GATE).

const CLAUSE_SPLIT = /\s+(?:und|sowie)\s+|[;\n]+|(?<=[.!?])\s+/iu
const REQUESTISH = /(?<![\p{L}])(?:kannst|könntest|koenntest|kannste)\s+du(?![\p{L}])|(?<![\p{L}])bitte(?![\p{L}])|(?<![\p{L}])(?:schick|send|verschick|ruf|spiel|erstell|erzeug|generier|zeig|lies|schreib|transkribier|zeichne|such|trag|buch|bestell)\p{L}*/iu

export interface CompoundGap { clause: string; topic: string; domain: CapabilityDomain }

/**
 * Teilaufträge einer zusammengesetzten Bitte, für die das Inventar belastbar kein Werkzeug hat.
 * `rest` ist der Auftrag ohne diese Teile (null, wenn nichts Eigenes übrig bleibt — dann gilt der Einzel-Weg).
 */
export function findCompoundGaps(text: string, inventory: CapabilityInventory): { rest: string; gaps: CompoundGap[] } | null {
    const value = String(text ?? '').trim()
    if (!value || value.startsWith('/') || value.length > 600) return null
    const clauses = value.split(CLAUSE_SPLIT).map(part => part.trim()).filter(Boolean)
    if (clauses.length < 2) return null
    const kept: string[] = []
    const gaps: CompoundGap[] = []
    for (const clause of clauses) {
        const domain = findDomain(clause)
        if (domain && REQUESTISH.test(clause)) {
            const verdict = assessCapability(clause, inventory)
            if (verdict.status === 'kann-nicht') { gaps.push({ clause: clip(clause, 160), topic: verdict.topic, domain }); continue }
        }
        kept.push(clause)
    }
    const rest = kept.join(' und ').replace(/[\s,]+$/, '')
    if (!gaps.length || rest.length < 4 || !/\p{L}{2}/u.test(rest)) return null
    return { rest, gaps }
}

/** One honest sentence + the one learn question (or the honest state of an earlier try). */
async function gapSentence(label: string, topic: string, domain: CapabilityDomain | undefined, ctx: LearnContext, deps: LearnDeps): Promise<string> {
    const reply = await offerFor(topic, domain, ctx, deps)
    const lead = label ? `Für ${label} habe ich kein eigenes Werkzeug.` : 'Dafür habe ich kein eigenes Werkzeug.'
    return reply === HONEST_NO
        ? `${lead} Soll ich es lernen? Dann suche ich mir einen sicheren Weg und baue das Werkzeug dafür.`
        : `${lead} ${reply}`
}

/**
 * Pipeline-Eingang vor dem Modell: zusammengesetzte Bitte mit einem Teil ohne Fähigkeit →
 * `rest` (was das Modell bearbeitet) und `note` (ehrlicher Satz + Lernfrage, wird der Antwort angehängt).
 */
export async function compoundGapGate(text: string, ctx: LearnContext & { isGroup?: boolean; systemAuthored?: boolean }, deps?: LearnDeps): Promise<{ rest: string; note: string } | null> {
    if (ctx.isGroup || ctx.systemAuthored) return null
    if (!deps && sideEffectsDisabled()) return null
    const live = deps || await prepareLearnDeps()
    const found = findCompoundGaps(text, await live.inventory())
    if (!found) return null
    console.log(`[Lernen] Teilauftrag ohne Werkzeug: ${found.gaps.map(gap => gap.domain.id).join(', ')}`)
    const notes: string[] = []
    for (const gap of found.gaps) notes.push(await gapSentence(`„${gap.domain.label}“`, gap.topic, gap.domain, ctx, live))
    return { rest: found.rest, note: notes.join('\n') }
}

/**
 * Lauf an einer Grenze (Werkzeug-Budget, Zeitdeckel, wiederholtes Ausweichen auf Behelfe): ehrlicher Satz + dieselbe
 * Lernfrage zum Auftrag. Leer, wenn nichts angeboten werden kann (Gruppe, System, Tests ohne Ports).
 */
export async function runLimitGapNote(request: string, ctx: LearnContext & { isGroup?: boolean; systemAuthored?: boolean }, deps?: LearnDeps): Promise<string> {
    if (ctx.isGroup || ctx.systemAuthored) return ''
    if (!deps && sideEffectsDisabled()) return ''
    const topic = clip(redactSecrets(request), 160)
    if (!topic) return ''
    try { return await gapSentence('', topic, findDomain(topic), ctx, deps || await prepareLearnDeps()) } catch { return '' }
}

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

export function createLearnCardExecutor(getDeps: () => LearnDeps): CardExecutor {
    return {
        kind: LEARN_CARD_KIND,
        impact: 'intern',
        allowAlways: () => false,
        async execute(card) {
            const deps = getDeps()
            const job = getLearnJob(card.aktion.ref, deps)
            if (!job || job.status !== 'angeboten') return { ok: false, message: 'Dieser Lernauftrag ist nicht mehr offen.' }
            mutate(deps, job.id, item => { item.status = 'recherche' }, 'Owner: Ja')
            deps.schedule(() => runLearningJob(job.id, deps))
            return { ok: true, message: 'Okay, ich lerne das jetzt im Hintergrund. Ich melde mich, sobald es geht — oder sage ehrlich, was fehlt.' }
        },
        async reject(card) {
            const deps = getDeps()
            const job = mutate(deps, card.aktion.ref, item => { if (item.status === 'angeboten') item.status = 'abgelehnt' }, 'Owner: Nein')
            return { ok: Boolean(job), message: 'Okay, ich lerne es nicht.' }
        },
        isStillOpen(card) {
            const deps = getDeps()
            const job = getLearnJob(card.aktion.ref, deps)
            if (job?.status !== 'angeboten') return false
            // 2.89: closed when the ability is there by now (connected, a tool, learned elsewhere).
            const inventory = deps.inventoryNow?.() ?? null
            return !(inventory && assessCapability(`Kannst du ${job.topic}?`, inventory).status === 'kann')
        },
    }
}

// ---------------------------------------------------------------------------
// Lernauftrag
// ---------------------------------------------------------------------------

const errorText = (error: unknown) => clip(redactSecrets(String((error as Error)?.message || error || 'Fehler')), 200)

function fail(deps: LearnDeps, id: string, fehlt: string, infrastructure: boolean): LearnJob | null {
    const job = mutate(deps, id, item => {
        item.status = 'gescheitert'
        item.fehlt = clip(fehlt, 300)
        item.infrastruktur = infrastructure || undefined
        if (!infrastructure) item.attempts = (item.attempts || 0) + 1
    }, fehlt)
    if (!job) return null
    deps.notify(`Nicht gelernt: ${labelOf(job)}. Es fehlt: ${job.fehlt}.${infrastructure ? ' Das lag an der Umgebung — frag mich später noch einmal.' : ' Ich versuche es nicht von selbst noch einmal.'}`)
    if (!infrastructure) deps.rememberFailure(job.topic, job.fehlt || fehlt)
    deps.activity(job)
    return job
}

function learn(deps: LearnDeps, id: string, detail?: string): LearnJob | null {
    const now = nowOf(deps)
    const current = getLearnJob(id, deps)
    const health = current?.weg === 'rezept' && current.ref ? deps.forgeHealth(current.ref) : null
    const job = mutate(deps, id, item => {
        item.status = 'gelernt'
        item.learnedAt = iso(now)
        item.fehlt = undefined
        item.wartetSeit = undefined
        if (health) item.baseline = { calls: health.calls, failures: health.failures, ...(typeof health.totalMs === 'number' ? { totalMs: health.totalMs } : {}) }
    }, detail || 'Selbsttest bestanden')
    if (!job) return null
    deps.notify(`Gelernt: ${labelOf(job)}. Probier mal: „${exampleOf(job)}“`)
    deps.activity(job)
    return job
}

function waitFor(deps: LearnDeps, id: string, change: (job: LearnJob) => void, detail: string): LearnJob | null {
    const job = mutate(deps, id, item => { change(item); item.status = 'wartet-auf-freigabe'; item.wartetSeit = iso(nowOf(deps)) }, detail)
    if (job) deps.activity(job)
    return job
}

async function selfTest(deps: LearnDeps, id: string): Promise<LearnJob | null> {
    const job = mutate(deps, id, item => { item.status = 'selbsttest'; item.wartetSeit = iso(nowOf(deps)) })
    if (!job) return null
    let probe: ProbeResult
    try { probe = await deps.probe(job) } catch (error) { probe = { result: 'fehler', detail: errorText(error) } }
    if (probe.result === 'ok') return learn(deps, id, probe.detail)
    if (probe.result === 'fehler') return fail(deps, id, `Selbsttest: ${probe.detail || 'fehlgeschlagen'}`, isInfrastructureFailure(probe.detail || ''))
    return job
}

/** Recherche → (a)…(d) → Selbsttest. Läuft im Hintergrund; wirft nie. */
export async function runLearningJob(id: string, deps: LearnDeps): Promise<LearnJob | null> {
    try {
        let job = mutate(deps, id, item => { item.status = 'recherche'; item.fehlt = undefined; item.infrastruktur = undefined })
        if (!job) return null
        deps.activity(job)
        const domain = domainOf(job)
        const label = labelOf(job)
        const missing: string[] = []
        let infrastructure = false

        // 1. Gibt es inzwischen schon ein Werkzeug?
        const verdict = assessCapability(`Kannst du ${job.topic}?`, await deps.inventory())
        if (verdict.status === 'kann') {
            mutate(deps, id, item => { item.weg = 'vorhanden'; item.tool = verdict.via[0] })
            return learn(deps, id, 'war schon vorhanden')
        }

        // 2. Geprüfter Katalog, MCP-Verzeichnis, Web/Doku/GitHub
        const query = searchQueryFor(job.topic, domain)
        const connectorIds = deps.connectors(job.topic, domain)
        let community: Array<{ name: string; title?: string }> = []
        try { community = deps.directory(domain?.label || job.topic).slice(0, 3) } catch { community = [] }
        let quellen: RatedSource[] = []
        let unsafe = 0
        if (deps.search) {
            try {
                const found = await deps.search.search(query)
                const rated = (found?.hits || []).slice(0, 20).map(hit => rateSource(hit, nowOf(deps)))
                unsafe = rated.filter(item => item.unsicher).length
                quellen = rated.filter(item => !item.unsicher && item.score >= 1).sort((a, b) => b.score - a.score).slice(0, 5)
            } catch (error) {
                const text = errorText(error)
                if (isInfrastructureFailure(text)) infrastructure = true
                missing.push(`eine erreichbare Websuche (${text})`)
            }
        }
        job = mutate(deps, id, item => { item.status = 'umsetzung'; item.quellen = quellen }, `${quellen.length} Quelle(n)${unsafe ? `, ${unsafe} unsicher verworfen` : ''}`)
        if (!job) return null

        // (a) Rezept aus vorhandenen Werkzeugen — nur, wenn kein Dienst/keine Software nötig ist.
        if (!domain?.connectors?.length && !domain?.software) {
            if (deps.hasRecipeBuilder()) {
                let recipe: RecipeResult
                try { recipe = await deps.recipe({ topic: job.topic, label, quellen, ownerId: job.ownerId, signature: job.signature }) } catch (error) { recipe = { status: 'fehlgeschlagen', detail: errorText(error) } }
                if (recipe.status === 'aktiv' && recipe.ref) {
                    mutate(deps, id, item => { item.weg = 'rezept'; item.ref = recipe.ref; item.tool = recipe.tool })
                    return selfTest(deps, id)
                }
                if (recipe.status === 'wartet' && recipe.ref) return waitFor(deps, id, item => { item.weg = 'rezept'; item.ref = recipe.ref; item.tool = recipe.tool }, recipe.detail)
                if (recipe.status === 'spaeter') infrastructure = true
                missing.push(`ein funktionierendes Werkzeug (${clip(recipe.detail, 160)})`)
            } else {
                missing.push('ein lokales Lern-Modell, das Werkzeuge baut')
            }
        }

        // (b) Geprüfter Connector
        for (const connectorId of connectorIds.slice(0, 2)) {
            let result: { ok: boolean; message: string }
            try { result = await deps.connect(connectorId) } catch (error) { result = { ok: false, message: errorText(error) } }
            if (result.ok) return waitFor(deps, id, item => { item.weg = 'verbindung'; item.ref = connectorId }, result.message)
            missing.push(`die Verbindung ${connectorId} (${clip(result.message, 120)})`)
        }
        if (domain?.connectors?.length && !connectorIds.length) missing.push('eine geprüfte Verbindung dafür')

        // (c) Software über den Install-Katalog
        if (domain?.software) {
            let result: { ok: boolean; message: string; ref?: string } | null
            try { result = await deps.softwareInstall(domain.software) } catch (error) { result = { ok: false, message: errorText(error) } }
            if (result?.ok) return waitFor(deps, id, item => { item.weg = 'paket'; item.ref = result!.ref || domain.software }, result.message)
            missing.push(result?.message ? clip(result.message, 160) : 'ein passendes Paket im geprüften Katalog')
        }

        if (community.length) missing.push(`nur ungeprüfte Einträge im MCP-Verzeichnis (${community.map(item => clip(item.title || item.name, 40)).join(', ')}) — ansehen unter Verbindungen`)

        // (d) Code-Erweiterung: nur als Vorschlag (PATCH_GATE), nie angewendet.
        const solid = quellen.filter(item => item.score >= 2)
        if (solid.length && !infrastructure) {
            const current = getLearnJob(id, deps)!
            let thoughtId: string | null = null
            try { thoughtId = await deps.proposeCode(current) } catch { thoughtId = null }
            if (thoughtId) {
                const proposed = mutate(deps, id, item => { item.status = 'code-vorschlag'; item.weg = 'code'; item.ref = thoughtId!; item.fehlt = clip(missing.join('; '), 300) }, 'Code-Erweiterung vorgeschlagen')
                if (proposed) {
                    deps.notify(`Für „${label}“ bräuchte ich eine Code-Erweiterung. Vorschlag mit ${solid.length} geprüften Quelle(n) notiert — nichts angewendet, das entscheidest du.`)
                    deps.activity(proposed)
                }
                return proposed
            }
        }
        if (unsafe && !quellen.length) missing.push('eine sichere Anleitung (gefundene wollten curl|sh o. ä.)')
        return fail(deps, id, missing.join('; ') || 'ein sicherer Weg', infrastructure)
    } catch (error) {
        const text = errorText(error)
        return fail(deps, id, `ein fehlerfreier Lernlauf (${text})`, isInfrastructureFailure(text))
    }
}

// ---------------------------------------------------------------------------
// Takt: Warten auflösen, nach der Übernahme messen und zurückrollen
// ---------------------------------------------------------------------------

export function degradation(baseline: NonNullable<LearnJob['baseline']>, health: ForgeHealth): string | null {
    const calls = health.calls - baseline.calls
    if (calls < MONITOR_MIN_CALLS) return null
    const failures = Math.max(0, health.failures - baseline.failures)
    const rate = failures / calls
    const baseRate = baseline.calls > 0 ? baseline.failures / baseline.calls : 0
    if (rate >= 0.34 && rate > baseRate + 0.2) return `Fehlerrate ${Math.round(rate * 100)} % statt ${Math.round(baseRate * 100)} %`
    if (typeof health.totalMs === 'number' && typeof baseline.totalMs === 'number' && baseline.calls > 0) {
        const baseAvg = baseline.totalMs / baseline.calls
        const avg = (health.totalMs - baseline.totalMs) / calls
        if (avg > Math.max(baseAvg * 2, baseAvg + 2000)) return `Laufzeit ${(avg / 1000).toFixed(1)} s statt ${(baseAvg / 1000).toFixed(1)} s`
    }
    return null
}

export async function capabilityLearningTick(deps: LearnDeps): Promise<{ learned: string[]; failed: string[]; rolledBack: string[] }> {
    const out = { learned: [] as string[], failed: [] as string[], rolledBack: [] as string[] }
    const now = nowOf(deps)
    for (const job of readFile(deps).jobs) {
        try {
            if (job.status === 'wartet-auf-freigabe' || job.status === 'selbsttest') {
                const since = Date.parse(job.wartetSeit || job.updatedAt)
                if (now - since > WAIT_LIMIT_MS) {
                    fail(deps, job.id, 'eine Freigabe innerhalb von 7 Tagen', false)
                    out.failed.push(job.id)
                    continue
                }
                let probe: ProbeResult
                try { probe = await deps.probe(job) } catch (error) { probe = { result: 'warten', detail: errorText(error) } }
                if (probe.result === 'ok') { learn(deps, job.id, probe.detail); out.learned.push(job.id) }
                else if (probe.result === 'fehler') { fail(deps, job.id, `Selbsttest: ${probe.detail || 'fehlgeschlagen'}`, isInfrastructureFailure(probe.detail || '')); out.failed.push(job.id) }
                continue
            }
            if (job.status === 'gelernt' && job.weg === 'rezept' && job.ref) {
                const health = deps.forgeHealth(job.ref)
                if (!health) continue
                if (health.status === 'disabled' || health.status === 'rejected') {
                    // Die Schmiede hat es selbst abgeschaltet und gemeldet — hier nur der Stand.
                    mutate(deps, job.id, item => { item.status = 'zurueckgerollt'; item.grund = 'Werkzeug abgeschaltet' }, 'von der Werkzeug-Schmiede abgeschaltet')
                    continue
                }
                if (!job.baseline) continue
                const reason = degradation(job.baseline, health)
                if (!reason) continue
                const done = await deps.rollback(job, reason).catch(() => false)
                const rolled = mutate(deps, job.id, item => { item.status = 'zurueckgerollt'; item.grund = reason }, `${reason}${done ? '' : ' (Abschalten fehlgeschlagen)'}`)
                if (!rolled) continue
                deps.notify(`Zurückgerollt: ${labelOf(rolled)} — ${reason}. Ich nutze es nicht mehr; frag mich, wenn ich es neu lernen soll.`)
                deps.rememberFailure(rolled.topic, `Zurückgerollt: ${reason}`)
                deps.activity(rolled)
                out.rolledBack.push(job.id)
            }
        } catch (error) {
            console.debug(`[Lernen] Takt für ${job.id}: ${errorText(error)}`)
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Produktion
// ---------------------------------------------------------------------------

/** 2.89: the last collected inventory for the synchronous card check. */
let lastInventory: CapabilityInventory | null = null

/** The latest inventory: everything as last collected, connections and learned abilities read now. */
function inventoryNow(dataDir?: string): CapabilityInventory | null {
    if (!lastInventory) return null
    let connected = lastInventory.connected
    // The one connection truth (Paket B), read fresh: a card closes as soon as the service is connected.
    try { connected = connectedConnectorIds(dataDir) } catch { /* keep the last */ }
    const toolSet = new Set(lastInventory.tools)
    let learned = lastInventory.learned
    try { learned = learnedCapabilities({ dataDir }).filter(item => !item.tools.length || item.tools.some(name => toolSet.has(name))) } catch { /* keep the last */ }
    return { ...lastInventory, connected, learned }
}

// 2.89: no own inventory here any more - capabilityInventory() is the one source.
async function collectInventory(dataDir?: string): Promise<CapabilityInventory> {
    const { capabilityInventory } = await import('./capability-inventory.js')
    lastInventory = await capabilityInventory({ dataDir })
    return lastInventory
}

async function defaultProbe(job: LearnJob, dataDir?: string): Promise<ProbeResult> {
    if (job.weg === 'rezept' && job.ref) {
        const { getForgeTool, selfTestForgeTool } = await import('../tools/skill-builder.js')
        const tool = getForgeTool(job.ref)
        if (!tool || tool.status === 'rejected') return { result: 'fehler', detail: 'Werkzeug abgelehnt' }
        if (tool.status === 'disabled') return { result: 'fehler', detail: tool.disabledReason || 'Werkzeug aus' }
        if (tool.status !== 'active') return { result: 'warten' }
        if (tool.manifest.wirkung === 'lesend') {
            const test = await selfTestForgeTool(tool.id)
            return test.ok ? { result: 'ok', detail: test.detail } : { result: 'fehler', detail: test.detail }
        }
        // Mit Wirkung: kein eigener Probelauf (das hätte Wirkung) — der erste echte Erfolg zählt.
        return tool.counters.successes > 0 ? { result: 'ok', detail: 'erster echter Aufruf erfolgreich' } : { result: 'warten' }
    }
    if (job.weg === 'verbindung' && job.ref) {
        const [{ connectionState }, { loadConnections }] = await Promise.all([import('../connections/connection-state.js'), import('../connections/connection-store.js')])
        const stand = connectionState(dataDir || (await import('../core/data-root.js')).getNovaDataDir(), { connectorId: job.ref })
        if (stand.zustand === 'verbunden') return { result: 'ok', detail: stand.grund }
        const record = loadConnections(dataDir ? { dataDir } : {}).find(item => item.connectorId === job.ref)
        if (record?.status === 'fehler') return { result: 'fehler', detail: record.letzterTest?.fehler || 'Verbindung fehlgeschlagen' }
        return { result: 'warten' }
    }
    if (job.weg === 'paket') {
        const software = domainOf(job)?.software
        if (!software) return { result: 'warten' }
        const { collectToolbox } = await import('../install/toolbox.js')
        const toolbox = await collectToolbox()
        const group = toolbox.gruppen.find(item => item.faehigkeit === software)
        return group?.eintraege.some(entry => entry.status === 'laeuft' || entry.status === 'installiert') ? { result: 'ok', detail: 'läuft' } : { result: 'warten' }
    }
    return { result: 'warten' }
}

export function defaultLearnDeps(): LearnDeps {
    return {
        inventory: () => collectInventory(),
        inventoryNow: () => inventoryNow(),
        search: { async search(query) { const { createGovernedWebSearch } = await import('../install/software-freshness.js'); return createGovernedWebSearch().search(query) } },
        // Nur der Cache des MCP-Verzeichnisses, nie das Netz.
        directory: query => { try { return directorySearch?.(query) ?? [] } catch { return [] } },
        connectors: (topic, domain) => connectorCandidates?.(topic, domain) ?? [...(domain?.connectors || [])],
        hasRecipeBuilder: () => recipeBuilderReady?.() ?? false,
        async recipe(input) {
            const { buildToolForLearning, forgeToolName } = await import('../tools/skill-builder.js')
            const sources = input.quellen.slice(0, 3).map(item => `- ${item.url} (${item.notes.join(', ')})`).join('\n')
            const result = await buildToolForLearning({
                request: `Baue ein Werkzeug für: ${input.topic}\nNur lesende Quellen/offizielle APIs; nichts installieren.${sources ? `\nGeprüfte Quellen:\n${sources}` : ''}`,
                why: `Owner wollte, dass ich „${input.label}“ lerne`, ownerId: input.ownerId, signature: `lernen:${input.signature}`,
            })
            if (result.deferred) return { status: 'spaeter', detail: result.message }
            const proposal = result.proposal
            if (proposal?.status === 'active') return { status: 'aktiv', ref: proposal.id, tool: forgeToolName(proposal), detail: result.message }
            if (proposal?.status === 'awaiting-approval') return { status: 'wartet', ref: proposal.id, tool: forgeToolName(proposal), detail: result.message }
            return { status: 'fehlgeschlagen', detail: result.message }
        },
        async connect(connectorId) {
            const { requestConnect } = await import('../connections/connect-flow.js')
            const result = await requestConnect({ connectorId, quelle: 'lernen' })
            return { ok: result.ok, message: result.message }
        },
        async softwareInstall(capability) {
            const { collectToolbox } = await import('../install/toolbox.js')
            const toolbox = await collectToolbox()
            const group = toolbox.gruppen.find(item => item.faehigkeit === capability)
            const running = group?.eintraege.find(entry => entry.status === 'laeuft' || entry.status === 'installiert')
            if (running) return { ok: true, message: `${running.name} ist schon da`, ref: running.katalogId || running.id }
            const entry = group?.eintraege.find(item => item.knopf?.art === 'installieren')
            if (!entry || entry.knopf?.art !== 'installieren') return { ok: false, message: group?.eintraege[0]?.hinweis || 'kein passendes Paket im geprüften Katalog' }
            const { defaultToolboxActionDeps, requestToolboxInstall } = await import('../install/toolbox-actions.js')
            const result = await requestToolboxInstall(entry.knopf.katalogId, await defaultToolboxActionDeps())
            return { ok: result.ok, message: result.message, ref: entry.knopf.katalogId }
        },
        async proposeCode(job) {
            const { addThought } = await import('../planner/index.js')
            const { thought } = addThought({
                source: 'lernen', kind: 'idee', permission: 'selbst',
                title: clip(`Code-Erweiterung nötig: ${labelOf(job)}`, 160),
                evidence: clip(`Quellen: ${job.quellen.slice(0, 3).map(item => item.url).join(' · ')} · fehlt: ${job.fehlt || '—'}`, 600),
                proposal: 'Nur über PATCH_GATE: ein konkreter self_evolve-Vorschlag, Freigabe durch den Owner. Nichts wird von selbst angewendet.',
                signature: `lernen-code-${job.signature}`,
            })
            return thought.id
        },
        probe: job => defaultProbe(job),
        forgeHealth: ref => forgeHealthOf?.(ref) ?? null,
        async rollback(job, reason) {
            if (job.weg !== 'rezept' || !job.ref) return false
            const { setForgeToolEnabled } = await import('../tools/skill-builder.js')
            return Boolean(await setForgeToolEnabled(job.ref, false, `lernen-messung: ${clip(reason, 60)}`))
        },
        notify: text => {
            void import('../planner/index.js').then(({ addThought }) => {
                addThought({ source: 'lernen', kind: 'ereignis', severity: 'warning', permission: 'selbst', title: clip(text, 160), signature: `lernen-meldung-${createHash('sha256').update(text).digest('hex').slice(0, 12)}` })
            }).catch(() => { /* Meldung optional */ })
        },
        activity: job => {
            void import('../planner/index.js').then(({ addThought, setThoughtStatus }) => {
                const terminal = job.status === 'gelernt' || job.status === 'gescheitert' || job.status === 'zurueckgerollt' || job.status === 'code-vorschlag'
                const { thought } = addThought({ source: 'lernen', kind: 'ereignis', permission: 'selbst', title: clip(`Lernt: ${labelOf(job)}`, 160), evidence: `Stand: ${job.status}${job.weg ? ` · Weg: ${job.weg}` : ''}`, signature: `lernen-${job.id}` })
                if (terminal) setThoughtStatus(thought.id, 'erledigt', 'selbst')
            }).catch(() => { /* Sichtbarkeit optional */ })
        },
        rememberFailure: (topic, reason) => {
            void import('../core/correction-detector.js').then(({ recordFailedApproach }) => {
                recordFailedApproach('faehigkeit_lernen', { thema: clip(topic, 80) }, reason, topic)
            }).catch(() => { /* Gedächtnis optional */ })
        },
        offerCard: input => offerCardSync?.(input) ?? { ok: false },
        schedule: task => { void task().catch(error => console.debug(`[Lernen] Hintergrund: ${errorText(error)}`)) },
    }
}

// Synchrone Zugriffe der Produktions-Ports werden einmal geladen (`prepareLearnDeps`).
let directorySearch: ((query: string) => Array<{ name: string; title?: string }>) | null = null
let connectorCandidates: ((topic: string, domain: CapabilityDomain | undefined) => string[]) | null = null
let recipeBuilderReady: (() => boolean) | null = null
let forgeHealthOf: ((ref: string) => ForgeHealth | null) | null = null
let offerCardSync: ((input: NewCardInput) => { ok: boolean; card?: ApprovalCard }) | null = null

/** Lädt die Module der Produktions-Ports (einmal, idempotent). */
export async function prepareLearnDeps(): Promise<LearnDeps> {
    if (!offerCardSync) {
        const [{ searchDirectory }, { matchRequestWords }, { findConnector }, { connectedConnectorIds }, forge, cards] = await Promise.all([
            import('../connections/registry-directory.js'), import('../connections/connection-demand.js'), import('../connections/connector-catalog.js'),
            import('../connections/connection-state.js'), import('../tools/skill-builder.js'), import('../core/approval-card-sources.js'),
        ])
        directorySearch = query => searchDirectory(query, { limit: 3 }).map(entry => ({ name: entry.name, title: entry.title }))
        connectorCandidates = (topic, domain) => {
            const ids = new Set([...(domain?.connectors || []), ...matchRequestWords(topic)])
            const connected = connectedConnectorIds()
            return [...ids].filter(id => findConnector(id) && !connected.has(id))
        }
        recipeBuilderReady = () => forge.hasForgeModel()
        forgeHealthOf = ref => {
            const tool = forge.getForgeTool(ref)
            return tool ? { status: tool.status, calls: tool.counters.calls, failures: tool.counters.failures, ...(typeof tool.counters.totalMs === 'number' ? { totalMs: tool.counters.totalMs } : {}) } : null
        }
        await cards.ensureBuiltinCardExecutors()
        offerCardSync = input => {
            const offered = cards.offerCard(input)
            return offered.ok ? { ok: true, card: offered.card } : { ok: false }
        }
    }
    return defaultLearnDeps()
}

let registered = false
/** Registriert den Karten-Ausführer (ensureBuiltinCardExecutors ruft das). */
export async function registerLearnCardExecutor(): Promise<void> {
    if (registered) return
    const { getCardExecutor, registerCardExecutor } = await import('../core/approval-cards.js')
    if (!getCardExecutor(LEARN_CARD_KIND)) {
        let deps: LearnDeps | null = null
        registerCardExecutor(createLearnCardExecutor(() => deps ||= defaultLearnDeps()))
        void prepareLearnDeps().then(ready => { deps = ready }).catch(() => undefined)
    }
    registered = true
}

/**
 * Pipeline-Eingang. In Tests/CI (`sideEffectsDisabled`) nur mit eigenen Ports.
 */
export async function capabilityGate(text: string, ctx: LearnContext & { isGroup?: boolean; systemAuthored?: boolean }, deps?: LearnDeps): Promise<{ handled: boolean; reply?: string }> {
    if (ctx.isGroup || ctx.systemAuthored) return { handled: false }
    if (!deps && sideEffectsDisabled()) return { handled: false }
    return handleCapabilityRequest(text, ctx, deps || await prepareLearnDeps())
}

/** Nach der Modell-Antwort: Ehrlichkeitsformel → Karte. Liefert den Text, der gesendet wird. */
export async function capabilityReplyGate(request: string, reply: string, ctx: LearnContext & { isGroup?: boolean; systemAuthored?: boolean }, deps?: LearnDeps): Promise<string> {
    if (ctx.isGroup || ctx.systemAuthored || !replyOffersLearning(reply)) return reply
    if (!deps && sideEffectsDisabled()) return reply
    try { return (await offerLearningAfterReply(request, ctx, deps || await prepareLearnDeps())).reply } catch { return reply }
}

/** Autonomie-Takt (nur Main). */
export async function runCapabilityLearningPhase(): Promise<void> {
    if (sideEffectsDisabled()) return
    const result = await capabilityLearningTick(await prepareLearnDeps())
    if (result.learned.length || result.failed.length || result.rolledBack.length) {
        console.log(`[Lernen] gelernt ${result.learned.length}, gescheitert ${result.failed.length}, zurückgerollt ${result.rolledBack.length}`)
    }
}

function clip(value: unknown, max: number): string {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
