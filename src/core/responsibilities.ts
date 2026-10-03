/**
 * Verantwortungen (Phase 6b): wofür Xaventra von sich aus sorgt — ohne dass
 * Alfred es ihr sagt.
 *
 * Eine Verantwortung = { id (Code), titel, ziel, messbare Kriterien, scope
 * (Knoten), erlaubte Aktionsarten (über die Aktions-Policy), status, herkunft }.
 *
 * Selbst ableiten — feste Regeln, kein Modell entscheidet:
 *   knoten-gesund        jeder Knoten mit Profil → „Knoten X gesund halten“
 *                        (Selbstprüfung nicht kritisch, Profil frisch)
 *   dienst-laeuft        jede Nachtwache-Prüfung → „Dienst Y läuft“
 *   geraet-ueberwachen   jedes eingerichtete Gerät aus dem Wahrnehmen → „Gerät Z überwachen“
 *   release-aktuell      bekannte signierte Version → „aktuelle signierte Version auf allen Knoten“
 *   wiederholte-anfrage  ≥3 gleichartige Owner-Anfragen in 14 Tagen → „von mir aus im Blick behalten“
 *
 * Aktivierung (2.84, Alfred 02.10.: weniger Ja/Nein): jede abgeleitete
 * Verantwortung ist sofort aktiv + Gedanke „Ich kümmere mich ab jetzt um …“.
 * Die Übernahme selbst ändert nichts; jeder L2-Schritt darin (z. B.
 * dienst-neustart) fragt die Mission weiterhin einzeln per Knopf-Karte, L3
 * wird nie Teil einer Verantwortung. Nur ein Kandidat mit `fragen: true`
 * wird noch als Knopf-Karte vorgeschlagen; [Nein] lehnt ab, abgelehnte werden
 * nie neu vorgeschlagen oder aktiviert. Ältere Vorschläge (vor 2.84) ohne
 * `fragen` übernimmt sync von selbst; ihre Karte schließt sich dadurch.
 *
 * Nachtwache-Host `local` heißt der eigene Knoten: Titel und Scope nennen ihn
 * mit seiner Knoten-ID (die ID der Verantwortung bleibt unverändert).
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { evaluateAction, levelRank, maxLevel, type ActionLevel } from './action-policy.js'
import { atomicWriteJsonSync } from './atomic-storage.js'
import type { ApprovalCard, CardExecutor, NewCardInput } from './approval-cards.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type ResponsibilityStatus = 'aktiv' | 'pausiert' | 'vorgeschlagen' | 'abgelehnt'
export type ResponsibilityOrigin = 'selbst-abgeleitet' | 'owner'
export type ResponsibilityRule = 'knoten-gesund' | 'dienst-laeuft' | 'geraet-ueberwachen' | 'release-aktuell' | 'wiederholte-anfrage' | 'owner'
export type CriterionType = 'knoten-selbstpruefung' | 'knoten-gemeldet' | 'nachtwache-pruefung' | 'geraet-ok' | 'release-aktuell'

export interface Criterion { id: string; typ: CriterionType; ref: string; text: string }
export interface CriterionResult { criterion: Criterion; erfuellt: boolean | null; befund: string }

export interface Responsibility {
    id: string
    titel: string
    ziel: string
    kriterien: Criterion[]
    scope: string[]
    aktionen: string[]
    maxLevel: ActionLevel
    status: ResponsibilityStatus
    herkunft: ResponsibilityOrigin
    regel: ResponsibilityRule
    beleg: string
    createdAt: string
    updatedAt: string
    activatedAt?: string
    activatedBy?: string
    decidedAt?: string
    decidedBy?: string
    cardId?: string
    lastCheck?: { at: string; erfuellt: boolean | null; befunde: string[] }
}

export interface Candidate {
    id: string
    titel: string
    ziel: string
    kriterien: Criterion[]
    scope: string[]
    aktionen: string[]
    regel: ResponsibilityRule
    beleg: string
    /** Regel verlangt die Owner-Antwort, egal welches Level. */
    fragen?: boolean
}

// ---------------------------------------------------------------------------
// Signals (snapshot of existing measurements)
// ---------------------------------------------------------------------------

export interface SignalNode {
    nodeId: string
    lastSeen?: number
    profile: {
        version?: string
        role?: string
        selfCheck?: { status: 'ok' | 'warn' | 'crit'; items?: Array<{ id: string; label: string; status: string; detail?: string }> }
    } | null
}
export interface SignalNightwatchResult { id: string; label: string; host: string; status: 'ok' | 'fehler' | 'unbekannt'; message: string; severity?: string }
export interface ResponsibilitySignals {
    now: number
    localNodeId: string
    nodes: SignalNode[]
    nightwatch: { finishedAt: string; results: SignalNightwatchResult[] } | null
    devices: Array<{ id: string; name: string; type: string; status: string; ok?: boolean | null; detail?: string }>
    release: { version: string } | null
    ownerRequests: Array<{ at: number; text: string }>
    /** P9: an agent can take a mission step (delegation on, Agentic-OS URL set). Missing = no. */
    delegation?: { available: boolean }
}

// ---------------------------------------------------------------------------
// fixed derivation rules
// ---------------------------------------------------------------------------

const ID_SAFE = (value: string) => String(value).replace(/[^A-Za-z0-9_.@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x'
const clean = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)

export const PROFILE_STALE_MS = 2 * 60 * 60_000
export const NIGHTWATCH_STALE_MS = 6 * 60 * 60_000
export const REQUEST_WINDOW_MS = 14 * 24 * 60 * 60_000
export const REQUEST_MIN_COUNT = 3

/** Feste Themen für wiederholte Owner-Anfragen (Code, kein Modell). */
const REQUEST_TOPICS: ReadonlyArray<{ art: string; label: string; pattern: RegExp }> = Object.freeze([
    { art: 'drucker', label: 'Drucker/Druckstand', pattern: /druck|drucker|printer|filament/i },
    { art: 'speicher', label: 'Speicherplatz', pattern: /platte|speicherplatz|disk|festplatte|voll\b/i },
    { art: 'knoten', label: 'Knoten-Zustand', pattern: /knoten|\bnodes?\b|spark|worker/i },
    { art: 'update', label: 'Updates/Versionen', pattern: /update|version|release/i },
    { art: 'mail', label: 'E-Mails', pattern: /e-?mail|posteingang|inbox/i },
    { art: 'backup', label: 'Backups', pattern: /backup|sicherung/i },
])

function semverParts(value: string): number[] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim())
    return match ? match.slice(1).map(Number) : null
}
function olderThan(version: string, reference: string): boolean | null {
    const a = semverParts(version), b = semverParts(reference)
    if (!a || !b) return null
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
    return false
}

/** Nightwatch checks address the own node as `local`. */
function nodeOfHost(host: string, localNodeId: string): string {
    return host === 'local' && localNodeId ? localNodeId : host
}
function serviceTitle(label: string, node: string): string {
    return `${clean(label, 60)} auf ${clean(node, 40)} läuft`
}

/** Pure and deterministic: the same signals always give the same candidates. */
export function deriveResponsibilities(signals: ResponsibilitySignals): Candidate[] {
    const out: Candidate[] = []
    for (const node of [...signals.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
        if (!node?.nodeId || !node.profile) continue
        const local = node.nodeId === signals.localNodeId
        out.push({
            id: `knoten-gesund:${ID_SAFE(node.nodeId)}`,
            titel: `Knoten ${clean(node.nodeId, 60)} gesund halten`,
            ziel: 'Selbstprüfung nicht kritisch und Profil frisch gemeldet',
            kriterien: [
                { id: 'selbstpruefung', typ: 'knoten-selbstpruefung', ref: node.nodeId, text: 'Selbstprüfung nicht kritisch' },
                { id: 'gemeldet', typ: 'knoten-gemeldet', ref: node.nodeId, text: 'Profil in den letzten 2 h gemeldet' },
            ],
            scope: [node.nodeId],
            // Self-heal only acts on the own node (own process, own data dir).
            aktionen: local ? ['diagnose', 'self-heal-zyklus', 'melden'] : ['diagnose', 'melden'],
            regel: 'knoten-gesund',
            beleg: `Knotenprofil ${node.nodeId} (${clean(node.profile.version || '?', 20)}, Rolle ${clean(node.profile.role || '?', 10)})`,
        })
    }
    for (const result of [...(signals.nightwatch?.results || [])].sort((a, b) => `${a.id}@${a.host}`.localeCompare(`${b.id}@${b.host}`))) {
        if (!result?.id || !result.host) continue
        const node = nodeOfHost(result.host, signals.localNodeId)
        out.push({
            id: `dienst-laeuft:${ID_SAFE(result.id)}@${ID_SAFE(result.host)}`,
            titel: serviceTitle(result.label || result.id, node),
            ziel: 'Nachtwache-Prüfung ist grün',
            kriterien: [{ id: 'nachtwache', typ: 'nachtwache-pruefung', ref: `${result.id}@${result.host}`, text: `Nachtwache „${clean(result.label || result.id, 60)}“ ok` }],
            scope: [node],
            // P9: with a reachable agent the mission may hand the repair over (after Alfred's Ja) before it hands off.
            aktionen: signals.delegation?.available ? ['diagnose', 'delegieren', 'dienst-neustart', 'melden'] : ['diagnose', 'dienst-neustart', 'melden'],
            regel: 'dienst-laeuft',
            beleg: `Nachtwache-Prüfung ${result.id} auf ${result.host}`,
        })
    }
    for (const device of [...signals.devices].sort((a, b) => a.id.localeCompare(b.id))) {
        if (!device?.id || device.status !== 'eingerichtet') continue
        out.push({
            id: `geraet:${ID_SAFE(device.id)}`,
            titel: `${clean(device.name || device.id, 60)} überwachen`,
            ziel: 'Gerät erreichbar, keine offene Fehlermeldung',
            kriterien: [{ id: 'geraet', typ: 'geraet-ok', ref: device.id, text: 'keine offene Fehlermeldung' }],
            scope: [signals.localNodeId],
            aktionen: ['diagnose', 'melden'],
            regel: 'geraet-ueberwachen',
            beleg: `eingerichtetes Gerät ${device.id} (${clean(device.type, 20)})`,
        })
    }
    if (signals.release?.version && semverParts(signals.release.version)) {
        out.push({
            id: 'release-aktuell',
            titel: 'Aktuelle signierte Version auf allen Knoten',
            ziel: `alle Knoten auf ${clean(signals.release.version, 20)} oder neuer`,
            kriterien: [{ id: 'version', typ: 'release-aktuell', ref: 'alle', text: 'kein Knoten älter als die letzte geprüfte Version' }],
            scope: signals.nodes.filter(node => node.profile).map(node => node.nodeId).sort(),
            // Ausrollen hat (noch) keinen registrierten Weg: diagnose + melden, der Rest ist Übergabe.
            aktionen: ['diagnose', 'melden'],
            regel: 'release-aktuell',
            beleg: `geprüftes Release ${clean(signals.release.version, 20)}`,
        })
    }
    const recent = signals.ownerRequests.filter(item => Number.isFinite(item.at) && item.at <= signals.now && signals.now - item.at <= REQUEST_WINDOW_MS)
    for (const topic of REQUEST_TOPICS) {
        const hits = recent.filter(item => topic.pattern.test(String(item.text || '')))
        if (hits.length < REQUEST_MIN_COUNT) continue
        out.push({
            id: `anfrage:${topic.art}`,
            titel: `${topic.label} von mir aus im Blick behalten`,
            ziel: `${topic.label} regelmäßig prüfen und von selbst melden, statt auf Nachfrage`,
            kriterien: [],
            scope: [signals.localNodeId],
            aktionen: ['diagnose', 'melden'],
            regel: 'wiederholte-anfrage',
            beleg: `${hits.length}× in 14 Tagen danach gefragt`,
        })
    }
    return out
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

export function measureCriterion(criterion: Criterion, signals: ResponsibilitySignals): CriterionResult {
    const result = (erfuellt: boolean | null, befund: string): CriterionResult => ({ criterion, erfuellt, befund: clean(befund, 300) })
    switch (criterion.typ) {
        case 'knoten-selbstpruefung': {
            const node = signals.nodes.find(item => item.nodeId === criterion.ref)
            const check = node?.profile?.selfCheck
            if (!check) return result(null, `keine Selbstprüfung von ${criterion.ref}`)
            if (check.status === 'crit') {
                const items = (check.items || []).filter(item => item.status === 'crit').map(item => `${item.label}${item.detail ? ` ${item.detail}` : ''}`)
                return result(false, `Selbstprüfung ${criterion.ref} kritisch${items.length ? `: ${items.join(', ')}` : ''}`)
            }
            return result(true, `Selbstprüfung ${criterion.ref}: ${check.status}`)
        }
        case 'knoten-gemeldet': {
            if (criterion.ref === signals.localNodeId) return result(true, 'eigener Knoten')
            const node = signals.nodes.find(item => item.nodeId === criterion.ref)
            if (!node || !Number.isFinite(node.lastSeen)) return result(null, `${criterion.ref}: keine Meldung bekannt`)
            const age = signals.now - Number(node.lastSeen)
            return age <= PROFILE_STALE_MS ? result(true, `${criterion.ref} gemeldet vor ${Math.round(age / 60_000)} min`) : result(false, `${criterion.ref} seit ${Math.round(age / 60_000)} min still`)
        }
        case 'nachtwache-pruefung': {
            const report = signals.nightwatch
            if (!report) return result(null, 'kein Nachtwache-Bericht')
            const at = Date.parse(report.finishedAt)
            if (!Number.isFinite(at) || signals.now - at > NIGHTWATCH_STALE_MS) return result(null, 'Nachtwache-Bericht zu alt')
            const hit = report.results.find(item => `${item.id}@${item.host}` === criterion.ref)
            if (!hit || hit.status === 'unbekannt') return result(null, `Prüfung ${criterion.ref} nicht prüfbar`)
            return hit.status === 'ok' ? result(true, `${criterion.ref} ok`) : result(false, `${criterion.ref}: ${hit.message}`)
        }
        case 'geraet-ok': {
            const device = signals.devices.find(item => item.id === criterion.ref)
            if (!device || device.ok === undefined || device.ok === null) return result(null, `${criterion.ref}: kein Messwert`)
            return device.ok ? result(true, `${device.name} ok`) : result(false, `${device.name}: ${device.detail || 'Fehlermeldung'}`)
        }
        case 'release-aktuell': {
            if (!signals.release?.version) return result(null, 'keine geprüfte Version bekannt')
            const behind = signals.nodes.filter(node => node.profile?.version && olderThan(node.profile.version, signals.release!.version) === true)
            const known = signals.nodes.filter(node => node.profile?.version)
            if (!known.length) return result(null, 'keine Knotenversion bekannt')
            return behind.length
                ? result(false, `älter als ${signals.release.version}: ${behind.map(node => `${node.nodeId} ${node.profile!.version}`).join(', ')}`)
                : result(true, `alle ${known.length} Knoten auf ${signals.release.version} oder neuer`)
        }
        default:
            return result(null, 'unbekanntes Kriterium')
    }
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

export interface ThoughtPort {
    add(input: { source: string; title: string; evidence?: string; severity?: 'critical' | 'warning' | 'info'; kind?: 'ereignis' | 'idee' | 'vorschlag'; proposal?: string; permission?: 'selbst' | 'fragen' | 'nie'; signature?: string; node?: string }): unknown
    retireProposal?(signature: string): void
}
export interface CardPort {
    create(input: NewCardInput): { ok: true; card: ApprovalCard; created: boolean } | { ok: false; reason: string }
    isOpen?(cardId: string): boolean
}
export interface ResponsibilityPorts { thoughts: ThoughtPort; cards: CardPort }
export interface ResponsibilityOptions { dataDir: string; now?: () => number; localNodeId: string; ports: ResponsibilityPorts }

export interface CheckOutcome { responsibility: Responsibility; erfuellt: boolean | null; ergebnisse: CriterionResult[]; verletzt: CriterionResult[] }

export interface ResponsibilityManager {
    list(filter?: { status?: ResponsibilityStatus | ResponsibilityStatus[] }): Responsibility[]
    get(id: string): Responsibility | null
    sync(signals: ResponsibilitySignals): { aktiviert: Responsibility[]; vorgeschlagen: Responsibility[] }
    decide(id: string, answer: 'ja' | 'nein', by: string): { ok: boolean; message: string }
    setPaused(id: string, paused: boolean, by: string): { ok: boolean; message: string }
    check(signals: ResponsibilitySignals): CheckOutcome[]
    measure(responsibility: Responsibility, signals: ResponsibilitySignals): { erfuellt: boolean | null; ergebnisse: CriterionResult[] }
}

const SOURCE = 'verantwortung'

export function createResponsibilityManager(options: ResponsibilityOptions): ResponsibilityManager {
    const now = options.now ?? Date.now
    const file = join(options.dataDir, 'responsibilities', 'responsibilities.json')
    const iso = () => new Date(now()).toISOString()

    const load = (): Responsibility[] => {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            return raw?.version === 1 && Array.isArray(raw.items) ? raw.items : []
        } catch { return [] }
    }
    const save = (items: Responsibility[]) => atomicWriteJsonSync(file, { version: 1, items })

    function allowedActions(candidate: Candidate): { aktionen: string[]; level: ActionLevel } {
        const kept: string[] = []
        const levels: ActionLevel[] = []
        for (const kind of candidate.aktionen) {
            const verdict = evaluateAction({ kind, origin: 'verantwortung', node: candidate.scope[0] }, { localNodeId: options.localNodeId })
            if (verdict.level === 'L3') continue // L3 is never part of a responsibility
            kept.push(kind)
            levels.push(verdict.level)
        }
        return { aktionen: kept, level: maxLevel(levels) }
    }

    function measure(responsibility: Responsibility, signals: ResponsibilitySignals) {
        const ergebnisse = responsibility.kriterien.map(criterion => measureCriterion(criterion, signals))
        const erfuellt = ergebnisse.some(item => item.erfuellt === false) ? false : ergebnisse.length && ergebnisse.every(item => item.erfuellt === true) ? true : null
        return { erfuellt, ergebnisse }
    }

    const manager: ResponsibilityManager = {
        list(filter = {}) {
            const wanted = filter.status ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status]) : null
            return load().filter(item => !wanted || wanted.has(item.status))
        },
        get(id) {
            return load().find(item => item.id === id) || null
        },
        sync(signals) {
            const items = load()
            const aktiviert: Responsibility[] = []
            const vorgeschlagen: Responsibility[] = []
            const activate = (item: Responsibility, aktionen: string[], level: ActionLevel) => {
                options.ports.thoughts.add({
                    source: SOURCE, title: `Ich kümmere mich ab jetzt um: ${item.titel}`, kind: 'ereignis', permission: 'selbst', severity: 'info',
                    evidence: `${item.beleg}. Ziel: ${item.ziel}. Darf selbst: ${aktionen.filter(kind => levelRank(evaluateAction({ kind, origin: 'verantwortung', node: item.scope[0] }, { localNodeId: options.localNodeId }).level) < levelRank('L2')).join(', ') || 'nichts'} (${levelRank(level) >= levelRank('L2') ? 'L2-Schritte frage ich einzeln per Knopf' : `höchstens ${level}`}).`,
                    signature: `verantwortung:aktiv:${item.id}`,
                })
                aktiviert.push(item)
            }
            for (const candidate of deriveResponsibilities(signals)) {
                const known = items.find(item => item.id === candidate.id)
                if (known) {
                    // 2.84: proposals from older versions no longer wait for a Ja (abgelehnt stays abgelehnt).
                    if (known.status === 'vorgeschlagen' && candidate.fragen !== true) {
                        const { aktionen, level } = allowedActions(candidate)
                        const at = iso()
                        Object.assign(known, {
                            titel: clean(candidate.titel, 120), scope: candidate.scope, aktionen, maxLevel: level,
                            status: 'aktiv', activatedAt: at, activatedBy: 'regel:selbst-abgeleitet', updatedAt: at,
                        })
                        activate(known, aktionen, level)
                    }
                    continue // known (incl. abgelehnt): never re-proposed
                }
                const { aktionen, level } = allowedActions(candidate)
                // The takeover changes nothing; every L2 step inside still gets its own card (missions.ts).
                const needsOwner = candidate.fragen === true
                const at = iso()
                const item: Responsibility = {
                    id: candidate.id, titel: clean(candidate.titel, 120), ziel: clean(candidate.ziel, 200), kriterien: candidate.kriterien,
                    scope: candidate.scope, aktionen, maxLevel: level, status: needsOwner ? 'vorgeschlagen' : 'aktiv',
                    herkunft: 'selbst-abgeleitet', regel: candidate.regel, beleg: clean(candidate.beleg, 200), createdAt: at, updatedAt: at,
                    ...(needsOwner ? {} : { activatedAt: at, activatedBy: 'regel:selbst-abgeleitet' }),
                }
                if (needsOwner) {
                    const created = options.ports.cards.create({
                        art: 'verantwortung',
                        titel: `Soll ich mich um „${item.titel}“ kümmern?`,
                        beleg: `${item.beleg}. Ziel: ${item.ziel}.`,
                        vorschlag: `Ab jetzt dafür sorgen (${aktionen.join(', ')}); folgenreiche Schritte (L2) frage ich trotzdem jedes Mal per Knopf.`,
                        aktion: { kind: 'verantwortung', ref: item.id },
                        dedupeKey: `verantwortung:${item.id}`,
                        quelle: SOURCE,
                        node: item.scope[0],
                        ablaufMs: 3 * 24 * 60 * 60_000,
                    })
                    if (created.ok) item.cardId = created.card.id
                    // 2.86 Punkt 5: one question = one card. The card above is the question;
                    // this thought is only the report line (a second `fragen` thought became a
                    // second card whose Ja did nothing).
                    options.ports.thoughts.add({
                        source: SOURCE, title: `Vorschlag: ${item.titel}`, kind: 'ereignis', permission: 'selbst', severity: 'info',
                        evidence: `${item.beleg}. ${item.ziel}. Frage per Karte „verantwortung“.`, signature: `verantwortung:vorschlag:${item.id}`,
                    })
                    vorgeschlagen.push(item)
                } else {
                    activate(item, aktionen, level)
                }
                items.push(item)
            }
            if (aktiviert.length || vorgeschlagen.length) save(items)
            // Also repairs stale questions left by an earlier activation/restart.
            // Retiring visibility never changes responsibility authority.
            for (const item of items) if (item.status !== 'vorgeschlagen') {
                options.ports.thoughts.retireProposal?.(`verantwortung:vorschlag:${item.id}`)
            }
            return { aktiviert, vorgeschlagen }
        },
        decide(id, answer, by) {
            const items = load()
            const item = items.find(entry => entry.id === id)
            if (!item) return { ok: false, message: 'Verantwortung nicht mehr vorhanden.' }
            if (item.status !== 'vorgeschlagen') return { ok: false, message: `Verantwortung ist bereits ${item.status}.` }
            const at = iso()
            if (answer === 'ja') Object.assign(item, { status: 'aktiv', activatedAt: at, activatedBy: by, decidedAt: at, decidedBy: by, updatedAt: at })
            else Object.assign(item, { status: 'abgelehnt', decidedAt: at, decidedBy: by, updatedAt: at })
            save(items)
            options.ports.thoughts.retireProposal?.(`verantwortung:vorschlag:${item.id}`)
            return { ok: true, message: answer === 'ja' ? `Übernommen: ${item.titel}.` : `Abgelehnt: ${item.titel} — ich schlage das nicht noch einmal vor.` }
        },
        setPaused(id, paused, by) {
            const items = load()
            const item = items.find(entry => entry.id === id)
            if (!item) return { ok: false, message: 'Unbekannte Verantwortung.' }
            if (paused && item.status !== 'aktiv') return { ok: false, message: `Nur aktive Verantwortungen lassen sich pausieren (ist ${item.status}).` }
            if (!paused && item.status !== 'pausiert') return { ok: false, message: `Nicht pausiert (ist ${item.status}).` }
            Object.assign(item, { status: paused ? 'pausiert' : 'aktiv', updatedAt: iso(), decidedBy: by })
            save(items)
            return { ok: true, message: `${item.titel}: ${paused ? 'pausiert' : 'wieder aktiv'}.` }
        },
        check(signals) {
            const items = load()
            const outcomes: CheckOutcome[] = []
            for (const item of items) {
                if (item.status !== 'aktiv') continue
                const { erfuellt, ergebnisse } = measure(item, signals)
                item.lastCheck = { at: iso(), erfuellt, befunde: ergebnisse.map(entry => entry.befund).slice(0, 5) }
                outcomes.push({ responsibility: item, erfuellt, ergebnisse, verletzt: ergebnisse.filter(entry => entry.erfuellt === false) })
            }
            if (outcomes.length) save(items)
            return outcomes
        },
        measure,
    }
    return manager
}

/** Card executor `verantwortung`: [Ja] activates, [Nein] rejects. Never "Immer erlauben". */
export function createResponsibilityCardExecutor(getManager: () => ResponsibilityManager | null): CardExecutor {
    return {
        kind: 'verantwortung',
        impact: 'intern',
        async execute(card, _answer, ctx) {
            const manager = getManager()
            if (!manager) return { ok: false, message: 'Verantwortungen sind aus — nichts übernommen.' }
            return manager.decide(card.aktion.ref, 'ja', ctx.decidedBy)
        },
        async reject(card, ctx) {
            const manager = getManager()
            if (!manager) return { ok: true, message: 'Abgelehnt.' }
            return manager.decide(card.aktion.ref, 'nein', ctx.decidedBy)
        },
        isStillOpen(card) {
            const manager = getManager()
            if (!manager) return true
            const item = manager.get(card.aktion.ref)
            return Boolean(item && item.status === 'vorgeschlagen')
        },
    }
}
