/**
 * 2.86 Paket M „Geführt“, Punkt 8 — Knopf „Ich komm nicht weiter“.
 *
 * She checks herself what is stuck — with the EXISTING sources, no new
 * diagnosis: the Doctor report (`collectDiagnostics`), the connections
 * (login expired/failed), the one open question (question-queue) and the
 * setup checklist. The answer is ONE concrete solution in ONE sentence plus
 * at most one button. When none of them explains it, she says so honestly and
 * asks Claude through the existing delegation (read-only investigation, the
 * answer lands in the report) — at most once per 6 hours.
 */
import type { DoctorIssue, DoctorReport } from '../doctor/types.js'
import type { Checklist } from './setup-checklist.js'
import { loadGuidedState, nowOf, updateGuidedState, type GuidedOptions } from './guided-store.js'

export type HilfeAktion =
    | { art: 'app'; bereich: 'verbindungen' | 'start' | 'system' }
    | { art: 'verbinden'; key: string }
    | { art: 'frage-zeigen'; cardId: string }
    | { art: 'nochmal' }

export interface HilfeAntwort {
    satz: string
    knopf?: { label: string; aktion: HilfeAktion }
    quelle: 'diagnose' | 'verbindung' | 'frage' | 'einrichtung' | 'claude' | 'unbekannt'
}

/** Doctor issue codes → one owner sentence + one button. Codes without an entry are not mapped. */
export const HILFE_DIAGNOSE: Partial<Record<DoctorIssue['code'], { satz: string; knopf?: HilfeAntwort['knopf'] }>> = {
    CONFIG_MISSING: { satz: 'Meine Grundeinstellung fehlt; die Einrichtung in der App legt sie mit einem Knopf neu an.', knopf: { label: 'Einrichtung öffnen', aktion: { art: 'app', bereich: 'start' } } },
    CONFIG_INVALID_JSON: { satz: 'Meine Grundeinstellung ist beschädigt; die Einrichtung in der App legt sie mit einem Knopf neu an.', knopf: { label: 'Einrichtung öffnen', aktion: { art: 'app', bereich: 'start' } } },
    LLM_PROVIDER_NOT_SET: { satz: 'Ich habe gerade kein KI-Modell zum Denken; unter „Verbindungen“ richtest du eins mit einem Knopf ein.', knopf: { label: 'KI einrichten', aktion: { art: 'app', bereich: 'verbindungen' } } },
    LLM_API_KEY_MISSING: { satz: 'Für dein KI-Modell fehlt noch die Anmeldung; unter „Verbindungen“ trägst du sie einmal ein.', knopf: { label: 'KI einrichten', aktion: { art: 'app', bereich: 'verbindungen' } } },
    OLLAMA_UNREACHABLE: { satz: 'Das KI-Programm auf diesem Rechner antwortet nicht; unter „Verbindungen“ siehst du, ob es läuft, und kannst ein anderes wählen.', knopf: { label: 'KI prüfen', aktion: { art: 'app', bereich: 'verbindungen' } } },
    OLLAMA_NO_MODELS: { satz: 'Auf diesem Rechner ist noch kein KI-Modell geladen; unter „Verbindungen“ holst du eins mit einem Knopf.', knopf: { label: 'KI einrichten', aktion: { art: 'app', bereich: 'verbindungen' } } },
    TELEGRAM_ENABLED_NO_TOKEN: { satz: 'Telegram ist eingeschaltet, aber noch nicht fertig gekoppelt; in der App geht das mit einem Code zum Scannen.', knopf: { label: 'Telegram koppeln', aktion: { art: 'app', bereich: 'start' } } },
    TELEGRAM_TOKEN_INVALID_FORMAT: { satz: 'Die Telegram-Kopplung ist unvollständig; koppel Telegram in der App bitte einmal neu.', knopf: { label: 'Telegram koppeln', aktion: { art: 'app', bereich: 'start' } } },
    PORT_REST_OCCUPIED: { satz: 'Ein anderes Programm belegt meinen Platz auf diesem Rechner; ein Neustart des Rechners löst das meist.', knopf: { label: 'Nochmal prüfen', aktion: { art: 'nochmal' } } },
    PORT_MESH_OCCUPIED: { satz: 'Ein anderes Programm belegt meinen Platz auf diesem Rechner; ein Neustart des Rechners löst das meist.', knopf: { label: 'Nochmal prüfen', aktion: { art: 'nochmal' } } },
    DIST_MISSING: { satz: 'Meine Programmdateien sind unvollständig; installiere Xaventra bitte einmal neu.', knopf: { label: 'Nochmal prüfen', aktion: { art: 'nochmal' } } },
    DIST_STALE: { satz: 'Meine Programmdateien sind älter als das Update; starte Xaventra einmal neu, dann passt es.', knopf: { label: 'Nochmal prüfen', aktion: { art: 'nochmal' } } },
    NODE_MODULES_MISSING: { satz: 'Mir fehlen Bausteine; installiere Xaventra bitte einmal neu.', knopf: { label: 'Nochmal prüfen', aktion: { art: 'nochmal' } } },
    NODE_VERSION_OLD: { satz: 'Ein Grundprogramm auf diesem Rechner ist zu alt; die Neuinstallation von Xaventra bringt das passende mit.', knopf: { label: 'Nochmal prüfen', aktion: { art: 'nochmal' } } },
}

export interface HilfeQuellen {
    diagnose?: Pick<DoctorReport, 'issues'> | null
    verbindungen?: Array<{ title: string; status: string }>
    /** The one visible/next open question (question-queue order). */
    frage?: { id: string; titel: string } | null
    einrichtung?: Pick<Checklist, 'offen' | 'erledigt' | 'gesamt'> | null
}

/** Pure: the one answer from the sources, or null when nothing explains it. */
export function findeLoesung(q: HilfeQuellen): HilfeAntwort | null {
    const issues = q.diagnose?.issues || []
    const mapped = (severity: DoctorIssue['severity']) => issues.filter(issue => issue.severity === severity).map(issue => HILFE_DIAGNOSE[issue.code]).find(Boolean)
    const error = mapped('error')
    if (error) return { ...error, quelle: 'diagnose' }
    const login = (q.verbindungen || []).find(item => ['abgelaufen', 'wartet-auf-anmeldung', 'fehler', 'wartet-auf-zugang'].includes(item.status))
    if (login) {
        const satz = login.status === 'fehler'
            ? `${login.title} antwortet gerade nicht; unter „Verbindungen“ kannst du die Verbindung einmal neu herstellen.`
            : login.status === 'wartet-auf-zugang'
                ? `Für ${login.title} fehlt noch der Zugang; unter „Verbindungen“ trägst du ihn einmal ein.`
                : `Die Anmeldung bei ${login.title} ist abgelaufen; unter „Verbindungen“ meldest du dich mit einem Knopf neu an.`
        return { satz, knopf: { label: 'Verbindungen öffnen', aktion: { art: 'app', bereich: 'verbindungen' } }, quelle: 'verbindung' }
    }
    if (q.frage) return { satz: `Ich warte auf deine Antwort zu „${String(q.frage.titel).slice(0, 80)}“; danach mache ich weiter.`, knopf: { label: 'Frage zeigen', aktion: { art: 'frage-zeigen', cardId: q.frage.id } }, quelle: 'frage' }
    const next = q.einrichtung?.offen?.[0]
    if (next?.knopf) {
        const aktion: HilfeAktion = next.knopf.aktion.art === 'verbinden' ? { art: 'verbinden', key: next.knopf.aktion.key } : { art: 'app', bereich: next.knopf.aktion.bereich }
        return { satz: `Als Nächstes: ${next.titel} – ${next.satz.charAt(0).toLowerCase()}${next.satz.slice(1)}`, knopf: { label: next.knopf.label, aktion }, quelle: 'einrichtung' }
    }
    const warning = mapped('warning')
    if (warning) return { ...warning, quelle: 'diagnose' }
    return null
}

export interface HilfeDeps extends GuidedOptions {
    quellen?: () => Promise<HilfeQuellen>
    /** The existing delegation to Claude (default: core/delegation `delegate`). */
    claudeFragen?: (auftrag: string, kontext: Record<string, unknown>) => Promise<boolean>
}

const ASK_AGAIN_MS = 6 * 60 * 60_000

export const HILFE_UNBEKANNT_GEFRAGT = 'Ich weiß es gerade nicht. Ich habe Claude gefragt; die Antwort steht in deinem nächsten Bericht.'
export const HILFE_UNBEKANNT_SCHON = 'Ich weiß es gerade nicht. Claude ist schon gefragt; die Antwort steht in deinem nächsten Bericht.'
export const HILFE_UNBEKANNT_ALLEIN = 'Ich weiß es gerade nicht, und ich kann gerade niemanden fragen. Schreib mir in einem Satz, was nicht klappt.'

/** The button „Ich komm nicht weiter“. */
export async function ichKommNichtWeiter(deps: HilfeDeps = {}): Promise<HilfeAntwort> {
    const quellen = deps.quellen ? await deps.quellen() : await defaultQuellen(deps)
    const found = findeLoesung(quellen)
    if (found) return found
    const now = nowOf(deps)
    const last = Date.parse(String(loadGuidedState(deps).hilfeGefragtAt || ''))
    if (Number.isFinite(last) && now - last < ASK_AGAIN_MS) return { satz: HILFE_UNBEKANNT_SCHON, quelle: 'claude' }
    const ask = deps.claudeFragen || defaultClaudeFragen
    const kontext = {
        einrichtung: quellen.einrichtung ? `${quellen.einrichtung.erledigt} von ${quellen.einrichtung.gesamt} erledigt` : 'unbekannt',
        selbstpruefung: (quellen.diagnose?.issues || []).slice(0, 8).map(issue => `${issue.severity}:${issue.code}`).join(', ') || 'ohne Befund',
        verbindungen: (quellen.verbindungen || []).slice(0, 10).map(item => `${item.title}=${item.status}`).join(', ') || 'keine',
    }
    let asked = false
    try {
        asked = await ask('Untersuche, warum der Owner in Xaventra nicht weiterkommt (Knopf „Ich komm nicht weiter“), und beschreibe einen konkreten nächsten Schritt in einem Satz in Alltagssprache.', kontext)
    } catch { asked = false }
    if (!asked) return { satz: HILFE_UNBEKANNT_ALLEIN, quelle: 'unbekannt' }
    updateGuidedState(state => { state.hilfeGefragtAt = new Date(now).toISOString() }, deps)
    return { satz: HILFE_UNBEKANNT_GEFRAGT, quelle: 'claude' }
}

async function defaultClaudeFragen(auftrag: string, kontext: Record<string, unknown>): Promise<boolean> {
    const { delegate } = await import('../core/delegation.js')
    const { IDEA_INVESTIGATION_CRITERION } = await import('../thinking/idea-run.js')
    const result = await delegate({ to: 'claude', auftrag, kontext, erwartet: { art: IDEA_INVESTIGATION_CRITERION, text: 'ein konkreter nächster Schritt in einem Satz' }, frist: 24 * 60 })
    return result.ok === true
}

async function defaultQuellen(deps: GuidedOptions): Promise<HilfeQuellen> {
    const out: HilfeQuellen = {}
    try { const { collectDiagnostics } = await import('../doctor/index.js'); out.diagnose = await collectDiagnostics() } catch { out.diagnose = null }
    try {
        const { loadConnections } = await import('../connections/connection-store.js')
        out.verbindungen = loadConnections({ dataDir: deps.dataDir }).filter(item => item.status !== 'getrennt').map(item => ({ title: item.title, status: item.status }))
    } catch { out.verbindungen = [] }
    try {
        const { listApprovalCards } = await import('../core/approval-cards.js')
        const { orderedOpenQuestions } = await import('../core/question-queue.js')
        const first = orderedOpenQuestions(listApprovalCards({ dataDir: deps.dataDir, status: 'offen' }), nowOf(deps))[0]
        out.frage = first ? { id: first.id, titel: first.titel } : null
    } catch { out.frage = null }
    try { const { collectChecklist } = await import('./setup-checklist.js'); out.einrichtung = await collectChecklist({ dataDir: deps.dataDir }) } catch { out.einrichtung = null }
    return out
}
