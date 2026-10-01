/**
 * Einheitliche Aktions-Policy (Phase 6b): EIN Kern, der für jede Aktion —
 * egal ob Mission, Verantwortung, Selbstheilung, Installation, Gerät oder
 * Gedanke — entscheidet, wie weit Xaventra selbst gehen darf.
 *
 *   L0  lesen, messen, melden                         → auto
 *   L1  umkehrbar und eigen (eigene Caches, Log-
 *       Rotation, Endpoint-Umschalten)                 → auto
 *   L2  folgenreich (installieren, Dienst-Neustart,
 *       Config, extern senden, drucken/schalten, VM,
 *       Modell wechseln)                               → ask (Knopf)
 *   L3  gefährlich (löschen, Firewall/SSH/sudoers,
 *       Credentials, Sicherheit abschalten, NAS-
 *       Neustart, DB-Migration)                        → never / handoff
 *
 * Feste Regeln (Code, nicht Config):
 * - Das Level berechnet nur dieser Kern aus Aktionsart, Effekten, Ziel und
 *   Knoten. Ein vom Aufrufer (oder Modell) mitgegebenes `level`/`decision`
 *   wird ignoriert.
 * - Unbekannte Aktionsart oder unbekannter Effekt → L2 ask (fail-safe).
 * - L3 läuft nie automatisch und bekommt nie einen Knopf. Kommt die Bitte vom
 *   Owner selbst, lautet die Antwort `handoff` (Xaventra macht es nicht, sagt
 *   aber, was Alfred selbst tun müsste) — ausgeführt wird trotzdem nichts.
 * - Physische und nach außen wirkende Aktionen sind mindestens L2.
 * - L1 gilt nur für den eigenen Knoten; auf einem fremden Knoten wird L1 zu L2.
 *
 * Vereinte Nie-Liste: die Effekte (früher in self-heal.ts), die Aktionsarten-
 * Muster der Knopf-Karten und des Lernens, die verbotenen Ziele der
 * Selbstheilung und — für Befehle — die argv-Regeln aus install/never-list.ts.
 * Die bisherigen Module beziehen ihre Listen von hier; keine Liste ist dabei
 * kürzer geworden (Union, nur strenger).
 *
 * Vertrauensleiter (P8, automatisch): nach TRUST_AUTO_PROMOTE_AFTER (= 3)
 * bestätigten „Ja“ derselben Aktionsart, deren Ausführung ohne Rückweg und
 * ohne Fehlschlag lief, wird die Art von L2 (fragen) auf L1 (selbst)
 * hochgestuft — persistiert in `<data>/action-policy/trust.json`, sichtbar in
 * `/arbeit` und im Abendbericht. Wirksam nur über `evaluateActionWithTrust`
 * (der reine Kern `evaluateAction` bleibt unverändert). Nie für physisch,
 * extern (inkl. Geld/Kauf), Löschen/Entfernen/Zurückrollen, L3, unbekannte
 * Arten und TRUST_NIE_ARTEN (Release, Patch, VM entfernen/stoppen). Ein
 * „Nein“, ein Fehlschlag oder ein Rückweg setzt die Serie zurück und nimmt die
 * Hochstufung zurück; `resetTrust(kind)` („das wieder fragen“) ebenso.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { neverListViolation, NEVER_LIST } from '../install/never-list.js'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'

export type ActionLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type ActionDecision = 'auto' | 'ask' | 'handoff' | 'never'
export type ActionImpact = 'intern' | 'physisch' | 'extern'
export type ActionOrigin = 'owner' | 'mission' | 'verantwortung' | 'selbstheilung' | 'wahrnehmen' | 'denken' | 'planer' | 'code' | 'model'

export interface ActionRequest {
    kind: string
    effects?: readonly string[]
    /** Datei/Dienst/Gerät, auf das die Aktion wirkt (Nie-Ziele werden geprüft). */
    target?: string
    /** Knoten, auf dem die Aktion wirkt. */
    node?: string
    /** Nur für Katalog-Befehle: wird gegen die argv-Nie-Liste geprüft. */
    argv?: readonly string[]
    origin: ActionOrigin | string
    /** Wird IGNORIERT — das Level setzt nur der Kern. */
    level?: unknown
    /** Wird IGNORIERT. */
    decision?: unknown
}

export interface PolicyVerdict {
    level: ActionLevel
    decision: ActionDecision
    reason: string
    impact: ActionImpact
    /** true, wenn die Aktionsart in der festen Tabelle steht. */
    known: boolean
    /** P8: true, wenn die Vertrauensleiter L2 → L1 gehoben hat (nur `evaluateActionWithTrust`). */
    trusted?: boolean
}

export interface PolicyOptions {
    /** Eigener Knoten; L1 auf einem anderen Knoten wird L2. */
    localNodeId?: string
    /** Verschärfungen aus dem kausalen Gedächtnis; Standard: der registrierte Anbieter. */
    constraints?: readonly DecisionConstraint[]
}

/**
 * Bindende Owner-Entscheidung, die eine Aktionsart verschärft
 * (src/core/decisions.ts). Kann nur anheben: 'fragen' → mindestens L2,
 * 'nie' → L3. Nie senken.
 */
export interface DecisionConstraint { id: string; mode: 'fragen' | 'nie'; arten: readonly string[]; text: string }

let decisionConstraintProvider: (() => readonly DecisionConstraint[]) | null = null
/** Set once by the daemon (startDecisionMemory); null switches it off. */
export function setDecisionConstraintProvider(provider: (() => readonly DecisionConstraint[]) | null): void {
    decisionConstraintProvider = provider
}
function constraintsFor(options: PolicyOptions): readonly DecisionConstraint[] {
    if (Array.isArray(options.constraints)) return options.constraints
    try { return decisionConstraintProvider?.() ?? [] } catch { return [] }
}

// ---------------------------------------------------------------------------
// Vereinte Nie-Liste
// ---------------------------------------------------------------------------

/** STUFENPLAN „Feste Grenzen“ Nr. 1 plus Ausführungsgrenzen Stufe 3 plus Phase 6b.
 * Nicht per Config, YOLO oder Owner-Befehl aufhebbar. (Früher `NIE_LISTE` in
 * doctor/self-heal.ts, dort weiter unter diesem Namen exportiert.) */
export const NIE_EFFEKTE: ReadonlyArray<{ effect: string; label: string }> = Object.freeze([
    { effect: 'nas:neustart', label: 'NAS-Neustart' },
    { effect: 'nas:shutdown', label: 'NAS-Shutdown' },
    { effect: 'daten:loeschen', label: 'Löschen von Daten' },
    { effect: 'backup:loeschen', label: 'Löschen von Backups' },
    { effect: 'rollback-container:loeschen', label: 'Löschen von Rollback-Containern' },
    { effect: 'db:migration', label: 'DB-Migration' },
    { effect: 'db:schreiben', label: 'DB-Änderung (auch bei Lease-Verlust/403)' },
    { effect: 'telegram:nicht-main', label: 'Telegram-Token/-Kanal auf einem Nicht-Main' },
    { effect: 'firewall:aendern', label: 'Firewall' },
    { effect: 'ssh:aendern', label: 'SSH-Konfiguration' },
    { effect: 'tailscale:aendern', label: 'Tailscale' },
    { effect: 'sudoers:aendern', label: 'sudoers' },
    { effect: 'secrets:lesen', label: 'Secrets lesen' },
    { effect: 'secrets:verschieben', label: 'Secrets verschieben' },
    { effect: 'secrets:ausgeben', label: 'Secrets ausgeben' },
    { effect: 'fremddienst:aendern', label: 'fremde Dienste (Mail, purebeing-shop, Hermes)' },
    { effect: 'vllm:stoppen', label: 'vLLM stoppen' },
    { effect: 'kernel:aendern', label: 'Kernel' },
    { effect: 'treiber:aendern', label: 'Treiber' },
    { effect: 'cuda:aendern', label: 'CUDA' },
    { effect: 'apt:upgrade', label: 'apt upgrade' },
    { effect: 'apt:dist-upgrade', label: 'apt dist-upgrade' },
    { effect: 'curl-pipe-sh', label: 'curl | sh' },
    // Stufe 3, Alfred 01.10.2026: nur eigener Prozess, kein Shell/SSH/root.
    { effect: 'shell:ausfuehren', label: 'Shell-Befehl' },
    { effect: 'ssh:ausfuehren', label: 'SSH-Befehl' },
    { effect: 'root:werden', label: 'root-Rechte' },
    // Phase 6b: einheitliche Policy.
    { effect: 'credentials:aendern', label: 'Zugangsdaten ändern' },
    { effect: 'sicherheit:abschalten', label: 'Sicherheitsfunktion abschalten' },
])

const NIE_EFFEKT_SET = new Set(NIE_EFFEKTE.map(item => item.effect))

/** Aktionsarten-Muster der Knopf-Karten (früher approval-cards.ts). */
const NIE_ARTEN_KARTEN: readonly RegExp[] = [
    /loesch|lösch|delete|remove-data|wipe/,
    /secret|token|passw|credential/,
    /nas-(neustart|restart|shutdown|reboot)|reboot|shutdown/,
    /db-(migration|migrate|schreiben|write)|migration/,
    /firewall|sudoers|ssh-(config|aendern)|tailscale/,
    /kernel|treiber|driver|cuda/,
    /apt-(upgrade|dist-upgrade)|dist-upgrade|curl-pipe/,
    /vllm-(stop|stoppen)|fremddienst/,
    /telegram-nicht-main/,
]
/** Aktionsarten-Muster des Lernens (früher thinking/decision-learning.ts). */
const NIE_ARTEN_LERNEN: readonly RegExp[] = [
    /loesch|lösch|delete|remove|entfern|wipe|purge|\brm\b/,
    /secret|token|passw|credential|schluessel|schlüssel|private[-_]?key/,
    /migrat|db[:._-]?(schreib|write)/,
    /nas[:._-]?(neustart|reboot|shutdown|aus)/, /shutdown|reboot/,
    /firewall|\bssh\b|ssh[:._-]|tailscale|sudo/,
    /vllm[:._-]?(stop|kill|aus)/, /kernel|treiber|driver|cuda/, /dist-?upgrade|apt[:._-]?upgrade/,
]
/** Phase 6b: zusätzliche gefährliche Arten. */
const NIE_ARTEN_ZUSATZ: readonly RegExp[] = [
    /sicherheit[-_:]?(aus|abschalt)|security[-_:]?(off|disable)/,
    /zugangsdaten|anmeldedaten/,
]
/** Union: eine Aktionsart, die irgendeine Liste trifft, ist Nie-Liste. */
export const NIE_AKTIONSARTEN: readonly RegExp[] = Object.freeze([...NIE_ARTEN_KARTEN, ...NIE_ARTEN_LERNEN, ...NIE_ARTEN_ZUSATZ])

/** Ziele, die nie berührt werden, auch im eigenen Datenverzeichnis (früher self-heal.ts). */
export const NIE_ZIELE: readonly RegExp[] = Object.freeze([
    /(^|[\\/])\.env($|\.)/i,
    /(^|[\\/])auth[^\\/]*\.json$/i,
    /(^|[\\/])mesh-identity($|[\\/])/i,
    /\.(key|pem|p12|pfx)$/i,
    /(secret|credential|passw|token)/i,
    /(^|[\\/])backups?($|[\\/])/i,
    /rollback/i,
    /(^|[\\/])self-heal[\\/]archive($|[\\/])/i,
])

const normalize = (value: unknown) => String(value ?? '').toLowerCase().normalize('NFC').trim()

/** Label des Nie-Effekts oder null. */
export function nieEffekt(effect: unknown): string | null {
    const value = String(effect ?? '')
    return NIE_EFFEKT_SET.has(value) ? NIE_EFFEKTE.find(item => item.effect === value)!.label : null
}
/**
 * Benannte Ausnahmen von den Aktionsarten-Mustern. Nur exakte Arten; jede
 * Ausnahme ist L2 (Karte, nie „immer“) und prüft ihre eigenen Grenzen bei der
 * Karte UND bei der Ausführung.
 * - pve-entfernen: Alfred 01.10.2026 — nur selbst angelegte VMs (Tag
 *   xaventra-created), gestoppt, protection=0, nie die eigene VM
 *   (src/infra/proxmox.ts checkAction).
 */
export const NIE_AUSNAHMEN: ReadonlySet<string> = Object.freeze(new Set(['pve-entfernen'])) as ReadonlySet<string>

export function isNieAktionsart(text: unknown): boolean {
    const value = normalize(text)
    if (value === '') return false
    // Named exceptions are taken out token by token (cards check "<art> <kind>");
    // everything that remains is still tested against the patterns.
    const rest = value.split(/\s+/).filter(token => !NIE_AUSNAHMEN.has(token)).join(' ')
    return rest !== '' && NIE_AKTIONSARTEN.some(pattern => pattern.test(rest))
}
export function isNieZiel(target: unknown): boolean {
    const value = String(target ?? '')
    return value !== '' && NIE_ZIELE.some(pattern => pattern.test(value))
}

/** Eine Übersicht der vereinten Nie-Liste (für Doku und /arbeit). */
export function nieListeUebersicht(): { effekte: string[]; aktionsarten: number; ziele: number; befehlsregeln: string[] } {
    return {
        effekte: NIE_EFFEKTE.map(item => item.label),
        aktionsarten: NIE_AKTIONSARTEN.length,
        ziele: NIE_ZIELE.length,
        befehlsregeln: NEVER_LIST.map(rule => rule.id),
    }
}

// ---------------------------------------------------------------------------
// Physisch / nach außen
// ---------------------------------------------------------------------------

/** Knopf-Karten (früher approval-cards.ts) — dort unverändert für die Wirkungs-Anzeige. */
export const KARTEN_PHYSISCH = /drucken|druck|print|schalten|switch|licht|heizung|home-?assistant|ha-aktion|tuer|tür|klima/
export const KARTEN_EXTERN = /senden|send|mail|nachricht|post|veroeffentlich|veröffentlich|publish|kaufen|kauf|buy|purchase|bestell|order|zahlen|pay/
/** Lernen (früher decision-learning.ts). */
const LERNEN_PHYSISCH_EXTERN: readonly RegExp[] = [
    /druck|print|plotter|3d[-_ ]?druck|slice/,
    /schalt|switch|toggle|turn[-_]?on|turn[-_]?off|licht|light|steckdose|relais|heiz|klima|ha[:._-]|home[-_]?assistant|garage|tuer|tür|schloss|lock/,
    /send|senden|verschick|mail|telegram|whatsapp|sms|nachricht|message|post(en)?\b|reply|antwort|tweet|anruf|call/,
    /kauf|buy|purchase|bestell|order|zahl|pay|checkout|ueberweis|überweis|transfer|abo|subscribe|trade|handel/,
]
/** Union beider Listen: wirkt die (unbekannte) Art physisch oder nach außen? */
export function isPhysischOderExtern(kind: unknown): boolean {
    const value = normalize(kind)
    return KARTEN_PHYSISCH.test(value) || KARTEN_EXTERN.test(value) || LERNEN_PHYSISCH_EXTERN.some(pattern => pattern.test(value))
}

// ---------------------------------------------------------------------------
// Feste Tabellen
// ---------------------------------------------------------------------------

interface KindEntry { level: ActionLevel; impact: ActionImpact; text: string }
const kind = (level: ActionLevel, text: string, impact: ActionImpact = 'intern'): KindEntry => Object.freeze({ level, impact, text })

/** Bekannte Aktionsarten. Alles andere ist unbekannt → L2. */
export const AKTIONSARTEN: Readonly<Record<string, KindEntry>> = Object.freeze({
    // L0 — lesen, messen, melden
    'lesen': kind('L0', 'lesen'),
    'diagnose': kind('L0', 'Diagnose (nur lesend: Messungen, Journale)'),
    'messen': kind('L0', 'messen'),
    'melden': kind('L0', 'Gedanke/Meldung an den Owner'),
    // L1 — umkehrbar, eigenes
    'self-heal-zyklus': kind('L1', 'Selbstheilung (nur die drei freigegebenen Rezepte)'),
    'log-rotation': kind('L1', 'eigene Logs ins Archiv rotieren'),
    'cache-leeren': kind('L1', 'eigene Zwischenspeicher leeren'),
    'endpoint-umschalten': kind('L1', 'Modell-Endpoint umschalten und zurück'),
    // L2 — folgenreich
    'install-katalog': kind('L2', 'aus dem Katalog installieren'),
    'dienst-neustart': kind('L2', 'Dienst neu starten'),
    'config-aendern': kind('L2', 'Konfiguration ändern'),
    'geraet-einrichten': kind('L2', 'Gerät einrichten/überwachen'),
    'modell-wechseln': kind('L2', 'Modell wechseln'),
    'patch-anwenden': kind('L2', 'Patch anwenden'),
    'release-ausrollen': kind('L2', 'Release ausrollen'),
    'vm-starten': kind('L2', 'VM starten'),
    'vm-stoppen': kind('L2', 'VM stoppen'),
    'vm-snapshot': kind('L2', 'VM-Snapshot'),
    // Phase 6c Proxmox (src/infra/proxmox.ts); Grenzen prüft der Adapter.
    'pve-start': kind('L2', 'Proxmox-Gast starten'),
    'pve-herunterfahren': kind('L2', 'Proxmox-Gast sauber herunterfahren'),
    'pve-snapshot': kind('L2', 'Proxmox-Snapshot'),
    'pve-rollback': kind('L2', 'Proxmox-Gast auf Snapshot zurückrollen'),
    'pve-anlegen': kind('L2', 'eigene VM anlegen'),
    'pve-anpassen': kind('L2', 'eigene VM vergrößern'),
    'pve-entfernen': kind('L2', 'eigene VM entfernen (nur xaventra-created, gestoppt, ungeschützt)'),
    'mail-senden': kind('L2', 'E-Mail senden', 'extern'),
    'nachricht-senden': kind('L2', 'Nachricht nach außen senden', 'extern'),
    'drucken': kind('L2', 'drucken', 'physisch'),
    'schalten': kind('L2', 'schalten (Home Assistant)', 'physisch'),
    // L3 — gefährlich (zusätzlich zur Nie-Liste ausdrücklich benannt)
    'daten-loeschen': kind('L3', 'Daten löschen'),
    'firewall-aendern': kind('L3', 'Firewall ändern'),
    'ssh-aendern': kind('L3', 'SSH ändern'),
    'sudoers-aendern': kind('L3', 'sudoers ändern'),
    'credentials-aendern': kind('L3', 'Zugangsdaten ändern'),
    'sicherheit-abschalten': kind('L3', 'Sicherheit abschalten'),
    'nas-neustart': kind('L3', 'NAS neu starten'),
    'db-migration': kind('L3', 'DB-Migration'),
})

const L0_EFFECTS = new Set(['lesen', 'messen', 'owner:melden', 'vorschlag:einreihen', 'gedanke:notieren'])
const L1_EFFECTS = new Set(['fs:eigene-logs-archivieren', 'fs:eigene-caches-leeren', 'llm:endpoint-umschalten', 'planer:eigener-job'])
const L2_EFFECTS = new Set([
    'paket:installieren', 'dienst:neustart', 'config:aendern', 'geraet:einrichten', 'modell:wechseln', 'patch:anwenden', 'release:ausrollen',
    'vm:starten', 'vm:stoppen', 'vm:snapshot', 'extern:senden', 'physisch:drucken', 'physisch:schalten',
])

const RANK: Record<ActionLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }
const IMPACT_RANK: Record<ActionImpact, number> = { intern: 0, physisch: 1, extern: 2 }
const KIND_PATTERN = /^[a-z][a-z0-9-]{1,47}$/

function decisionFor(level: ActionLevel, origin: string): ActionDecision {
    if (level === 'L3') return origin === 'owner' ? 'handoff' : 'never'
    return level === 'L2' ? 'ask' : 'auto'
}

/**
 * Der eine Entscheider. Pure, ohne I/O. Das Ergebnis hängt nur von Art,
 * Effekten, Ziel, argv, Knoten und Herkunft ab — nie von `level`/`decision`
 * des Aufrufers.
 */
export function evaluateAction(request: ActionRequest, options: PolicyOptions = {}): PolicyVerdict {
    const origin = normalize(request?.origin) || 'model'
    const kindName = normalize(request?.kind)
    const effects = Array.isArray(request?.effects) ? request.effects.map(effect => String(effect)) : []
    const finish = (level: ActionLevel, reason: string, impact: ActionImpact, known: boolean): PolicyVerdict =>
        ({ level, decision: decisionFor(level, origin), reason, impact, known })

    // 1. Nie-Liste (alle Quellen) → L3.
    for (const effect of effects) {
        const label = nieEffekt(effect)
        if (label) return finish('L3', `Nie-Liste: ${label}`, 'intern', Boolean(AKTIONSARTEN[kindName]))
    }
    if (isNieAktionsart(kindName)) return finish('L3', `Nie-Liste: Aktionsart „${kindName}“`, 'intern', Boolean(AKTIONSARTEN[kindName]))
    if (request?.target !== undefined && isNieZiel(request.target)) return finish('L3', 'Nie-Liste: geschütztes Ziel', 'intern', Boolean(AKTIONSARTEN[kindName]))
    if (Array.isArray(request?.argv)) {
        const violation = neverListViolation(request.argv.map(String))
        if (violation) return finish('L3', `Nie-Liste: ${violation.why}`, 'intern', Boolean(AKTIONSARTEN[kindName]))
    }

    // 2. Feste Tabelle.
    const entry = KIND_PATTERN.test(kindName) ? AKTIONSARTEN[kindName] : undefined
    if (entry?.level === 'L3') return finish('L3', `gefährlich: ${entry.text}`, entry.impact, true)
    let level: ActionLevel = entry ? entry.level : 'L2'
    let impact: ActionImpact = entry ? entry.impact : 'intern'
    const reasons: string[] = [entry ? entry.text : `unbekannte Aktionsart „${kindName.slice(0, 48) || '?'}“ → fragen`]
    const raise = (to: ActionLevel, why: string) => { if (RANK[to] > RANK[level]) { level = to; reasons.push(why) } }
    const raiseImpact = (to: ActionImpact) => { if (IMPACT_RANK[to] > IMPACT_RANK[impact]) impact = to }

    if (!entry && isPhysischOderExtern(kindName)) raiseImpact(KARTEN_EXTERN.test(kindName) ? 'extern' : 'physisch')

    // 3. Effekte: höchster gewinnt, unbekannt → L2.
    for (const effect of effects) {
        if (L0_EFFECTS.has(effect)) continue
        if (L1_EFFECTS.has(effect)) { raise('L1', `Effekt ${effect}`); continue }
        if (L2_EFFECTS.has(effect)) {
            raise('L2', `Effekt ${effect}`)
            if (effect.startsWith('physisch:')) raiseImpact('physisch')
            if (effect.startsWith('extern:')) raiseImpact('extern')
            continue
        }
        raise('L2', `unbekannter Effekt ${effect.slice(0, 48)} → fragen`)
    }

    // 4. Physisch/extern fragt immer.
    if (impact !== 'intern') raise('L2', impact === 'physisch' ? 'wirkt physisch → fragt immer' : 'wirkt nach außen → fragt immer')
    // 5. „eigen“ heißt eigener Knoten.
    if (level === 'L1' && request?.node && options.localNodeId && normalize(request.node) !== normalize(options.localNodeId)) {
        raise('L2', `fremder Knoten ${String(request.node).slice(0, 40)} → fragen`)
    }
    // 6. Bindende Owner-Entscheidungen verschärfen nur (nie senken).
    for (const constraint of constraintsFor(options)) {
        if (!Array.isArray(constraint?.arten) || !constraint.arten.includes(kindName)) continue
        const why = `Entscheidung ${String(constraint.id).slice(0, 16)}: ${String(constraint.text ?? '').slice(0, 80)}`
        if (constraint.mode === 'nie') return finish('L3', why, impact, Boolean(entry))
        if (constraint.mode === 'fragen') raise('L2', why)
    }
    return finish(level, reasons.join('; '), impact, Boolean(entry))
}

export function levelRank(level: ActionLevel): number { return RANK[level] }
export function maxLevel(levels: readonly ActionLevel[]): ActionLevel {
    return levels.reduce<ActionLevel>((best, item) => RANK[item] > RANK[best] ? item : best, 'L0')
}

// ---------------------------------------------------------------------------
// Vertrauensleiter (vorbereitet, schaltet nie selbst)
// ---------------------------------------------------------------------------

export const TRUST_MIN_SUCCESSES = 5
/** P8: so many confirmed „Ja“ (each executed without rollback/failure) promote a kind L2 → L1. */
export const TRUST_AUTO_PROMOTE_AFTER = 3
/** Never promoted, whatever the history (infra-destroy, release/patch gates). */
export const TRUST_NIE_ARTEN: ReadonlySet<string> = Object.freeze(new Set([
    'release-ausrollen', 'patch-anwenden', 'pve-entfernen', 'pve-rollback', 'pve-herunterfahren', 'vm-stoppen',
])) as ReadonlySet<string>
/** Deleting/removing/rolling back and money never climb the ladder. */
const TRUST_NIE_MUSTER = /loesch|lösch|delete|entfern|remove|destroy|wipe|purge|rollback|zurueckroll|zurückroll|geld|kauf|buy|purchase|pay|zahl|bestell|order|ueberweis|überweis/
interface TrustStats {
    successes: number; total: number; rolledBack: number; failed: number; lastAt: string; proposedAt?: string
    /** consecutive owner „Ja“ whose execution succeeded without rollback */
    confirmedYes?: number
    promotedAt?: string
    resetAt?: string
    resetReason?: string
}
interface TrustFile { version: 1; kinds: Record<string, TrustStats> }
export interface TrustOptions { dataDir?: string; now?: () => number }

const trustFile = (opts: TrustOptions) => join(opts.dataDir || getNovaDataDir(), 'action-policy', 'trust.json')
function loadTrust(opts: TrustOptions): TrustFile {
    try {
        const raw = JSON.parse(readFileSync(trustFile(opts), 'utf8'))
        return raw?.version === 1 && raw.kinds && typeof raw.kinds === 'object' ? raw : { version: 1, kinds: {} }
    } catch { return { version: 1, kinds: {} } }
}
function saveTrust(data: TrustFile, opts: TrustOptions): void {
    const file = trustFile(opts)
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file, data)
}

/**
 * Darf diese Art überhaupt automatisch hochgestuft werden? Nur bekannte,
 * interne L2-Arten; nie physisch/extern/Geld/Löschen/L3/TRUST_NIE_ARTEN.
 */
export function isTrustEligible(kindName: string): boolean {
    const key = normalize(kindName)
    if (!KIND_PATTERN.test(key) || TRUST_NIE_ARTEN.has(key) || TRUST_NIE_MUSTER.test(key)) return false
    const verdict = evaluateAction({ kind: key, origin: 'code' })
    return verdict.known && verdict.level === 'L2' && verdict.impact === 'intern' && !isPhysischOderExtern(key)
}

function demote(stats: TrustStats, at: string, reason: string): void {
    stats.confirmedYes = 0
    if (stats.promotedAt) {
        delete stats.promotedAt
        stats.resetAt = at
        stats.resetReason = reason
    }
}

/**
 * Nach jeder echten Ausführung: ok ohne Rückweg zählt, Rückweg/Fehler setzt die
 * Serie zurück (und nimmt eine Hochstufung zurück). `approvedByOwner`: diese
 * Ausführung kam von einem „Ja“ des Owners — die Grundlage der Vertrauensleiter.
 */
export function recordActionOutcome(kindName: string, outcome: { ok: boolean; rolledBack?: boolean; approvedByOwner?: boolean }, opts: TrustOptions = {}): void {
    const key = normalize(kindName)
    if (!KIND_PATTERN.test(key)) return
    try {
        const data = loadTrust(opts)
        const stats = data.kinds[key] || { successes: 0, total: 0, rolledBack: 0, failed: 0, lastAt: '' }
        const at = new Date((opts.now || Date.now)()).toISOString()
        stats.total++
        if (outcome.ok && !outcome.rolledBack) {
            stats.successes++
            if (outcome.approvedByOwner) {
                stats.confirmedYes = (stats.confirmedYes || 0) + 1
                if (!stats.promotedAt && stats.confirmedYes >= TRUST_AUTO_PROMOTE_AFTER && isTrustEligible(key)) {
                    stats.promotedAt = at
                    delete stats.resetAt
                    delete stats.resetReason
                }
            }
        } else {
            stats.successes = 0
            delete stats.proposedAt
            if (outcome.rolledBack) stats.rolledBack++
            else stats.failed++
            demote(stats, at, outcome.rolledBack ? 'Rückweg nötig' : 'Fehlschlag')
        }
        stats.lastAt = at
        data.kinds[key] = stats
        saveTrust(data, opts)
    } catch { /* Vertrauen ist Beleg, nie Grund zum Scheitern */ }
}

/** Owner-Antwort auf eine Karte dieser Art. „Nein“ setzt die Serie zurück und nimmt eine Hochstufung zurück. */
export function recordOwnerAnswer(kindName: string, answer: 'ja' | 'nein', opts: TrustOptions = {}): void {
    const key = normalize(kindName)
    if (!KIND_PATTERN.test(key) || answer !== 'nein') return
    try {
        const data = loadTrust(opts)
        const stats = data.kinds[key] || { successes: 0, total: 0, rolledBack: 0, failed: 0, lastAt: '' }
        const at = new Date((opts.now || Date.now)()).toISOString()
        demote(stats, at, 'Owner: Nein')
        stats.lastAt = at
        data.kinds[key] = stats
        saveTrust(data, opts)
    } catch { /* Beleg, nie Grund zum Scheitern */ }
}

/** „Das wieder fragen“: nimmt die Hochstufung zurück und beginnt die Serie neu. */
export function resetTrust(kindName: string, opts: TrustOptions = {}, reason = 'Owner: wieder fragen'): { kind: string; wasPromoted: boolean } {
    const key = normalize(kindName)
    if (!KIND_PATTERN.test(key)) return { kind: key, wasPromoted: false }
    const data = loadTrust(opts)
    const stats = data.kinds[key]
    if (!stats) return { kind: key, wasPromoted: false }
    const wasPromoted = Boolean(stats.promotedAt)
    demote(stats, new Date((opts.now || Date.now)()).toISOString(), reason)
    data.kinds[key] = stats
    saveTrust(data, opts)
    return { kind: key, wasPromoted }
}

/** true, wenn diese Art durch die Vertrauensleiter selbst ausgeführt werden darf. */
export function isTrustPromoted(kindName: string, opts: TrustOptions = {}): boolean {
    const key = normalize(kindName)
    return Boolean(loadTrust(opts).kinds[key]?.promotedAt) && isTrustEligible(key)
}

export interface PromotedKind { kind: string; text: string; promotedAt: string; confirmedYes: number }

/** Alle hochgestuften Arten (für `/arbeit` und den Abendbericht). */
export function promotedKinds(opts: TrustOptions = {}): PromotedKind[] {
    return Object.entries(loadTrust(opts).kinds)
        .filter(([key, stats]) => stats.promotedAt && isTrustEligible(key))
        .map(([key, stats]) => ({ kind: key, text: AKTIONSARTEN[key]?.text || key, promotedAt: String(stats.promotedAt), confirmedYes: stats.confirmedYes || 0 }))
        .sort((a, b) => a.promotedAt.localeCompare(b.promotedAt))
}

/** Hochstufungen und Rücknahmen in einem Zeitfenster (Abendbericht). */
export function trustChangesSince(sinceMs: number, untilMs: number, opts: TrustOptions = {}): { promoted: PromotedKind[]; reset: Array<{ kind: string; at: string; reason: string }> } {
    const inWindow = (at?: string) => { const t = Date.parse(String(at)); return Number.isFinite(t) && t >= sinceMs && t <= untilMs }
    const data = loadTrust(opts)
    return {
        promoted: promotedKinds(opts).filter(item => inWindow(item.promotedAt)),
        reset: Object.entries(data.kinds).filter(([, stats]) => inWindow(stats.resetAt))
            .map(([key, stats]) => ({ kind: key, at: String(stats.resetAt), reason: String(stats.resetReason || '') })),
    }
}

/**
 * Der Kern plus Vertrauensleiter: eine hochgestufte Art wird L1 (selbst),
 * aber nur, wenn der reine Kern L2 intern sagt, keine physischen/externen
 * Effekte dabei sind und die Aktion auf dem eigenen Knoten wirkt.
 */
export function evaluateActionWithTrust(request: ActionRequest, options: PolicyOptions & TrustOptions = {}): PolicyVerdict {
    const verdict = evaluateAction(request, options)
    if (verdict.level !== 'L2' || verdict.impact !== 'intern' || verdict.decision !== 'ask') return verdict
    const effects = Array.isArray(request?.effects) ? request.effects.map(String) : []
    if (effects.some(effect => !(L0_EFFECTS.has(effect) || L1_EFFECTS.has(effect) || (L2_EFFECTS.has(effect) && !/^(physisch|extern):/.test(effect))))) return verdict
    if (request?.node && options.localNodeId && normalize(request.node) !== normalize(options.localNodeId)) return verdict
    let promoted = false
    try { promoted = isTrustPromoted(String(request?.kind || ''), options) } catch { promoted = false }
    if (!promoted) return verdict
    return { ...verdict, level: 'L1', decision: 'auto', trusted: true, reason: `${verdict.reason}; Vertrauensleiter: ${TRUST_AUTO_PROMOTE_AFTER}× Ja ohne Rückweg → selbst` }
}

/** Anzahl erfolgreicher Ausführungen ohne Rückweg in Folge. */
export function trustEvidence(kindName: string, opts: TrustOptions = {}): { kind: string; successes: number; total: number } {
    const key = normalize(kindName)
    const stats = loadTrust(opts).kinds[key]
    return { kind: key, successes: stats?.successes ?? 0, total: stats?.total ?? 0 }
}

/**
 * Höchstens ein Vorschlag-Text „L2 → L1?“ je Serie. Nie für physisch, extern
 * oder L3; nie für Arten, die schon L0/L1 sind. Ändert kein Level — die
 * Umstellung kann nur Alfred im Code vornehmen.
 */
export function trustUpgradeProposal(kindName: string, opts: TrustOptions = {}): { kind: string; titel: string; text: string } | null {
    const key = normalize(kindName)
    const verdict = evaluateAction({ kind: key, origin: 'code' })
    if (verdict.level !== 'L2' || verdict.impact !== 'intern' || !verdict.known) return null
    if (isPhysischOderExtern(key)) return null
    const data = loadTrust(opts)
    const stats = data.kinds[key]
    if (!stats || stats.successes < TRUST_MIN_SUCCESSES || stats.proposedAt || stats.promotedAt) return null
    stats.proposedAt = new Date((opts.now || Date.now)()).toISOString()
    try { saveTrust(data, opts) } catch { /* nächstes Mal */ }
    return {
        kind: key,
        titel: `Vertrauen: „${key}“ künftig ohne Rückfrage?`,
        text: `${stats.successes}× in Folge erfolgreich ohne Rückweg (${stats.total} Ausführungen gesamt). Vorschlag: von L2 (fragen) auf L1 (selbst). Umstellen kann nur Alfred im Code; bis dahin frage ich weiter.`,
    }
}
