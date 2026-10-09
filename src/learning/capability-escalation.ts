/**
 * 2.89.4: eigene Fähigkeiten prüfen, bevor „kann ich nicht“.
 *
 * Live 09.10.2026: DHL-Tracking mit dynamischem Suchfeld endete in
 * „Ich habe kein echtes Maus-Werkzeug … entzieht sich jedem automatischen
 * Zugriff“ — obwohl (a) Tracking-Seiten die Nummer oft im URL-Parameter
 * nehmen, (b) Playwright echte Eingaben + Warten kann und (c) Computer-Use
 * (desktop_screenshot + desktop_input) existiert.
 *
 * Kette VOR jedem ehrlichen Scheitern:
 *   1. Direktlink / Fetch (URL-Parameter, API, parcel_track)
 *   2. Browser mit Warten und echter Eingabe (browser_navigate/type/click)
 *   3. Desktop-Computer-Use (desktop_screenshot + desktop_input)
 * Erst wenn alle Stufen ehrlich gescheitert sind: „kann ich noch nicht“.
 * Fehlt nur Chromium/Playwright, ist das eine Lücke (Bedarf), nie „unmöglich“.
 */
import type { CapabilityInventory } from './capability-inventory.js'
import type { SoftwareCapability } from '../install/software-candidates.js'

export type EscalationStep = 'direktlink' | 'browser' | 'desktop'
export type UiGap = 'browser' | 'desktop'

export interface UiToolView {
    /** Registered tool names (or a short capability list via `steps`). */
    tools?: readonly string[]
    /** Forced steps (tests). When set, wins over `tools`. */
    steps?: readonly EscalationStep[]
    browserBroken?: boolean
    desktopDisabled?: boolean
}

export interface UiToolViewOf {
    steps: EscalationStep[]
    browserMissing: boolean
    desktopMissing: boolean
    /** Honest labels of what is there, in chain order. */
    present: string[]
}

const BROWSER_TOOL = /^(browser_(?:open|navigate|type|click|extract|screenshot|search)|playwright)/
const DESKTOP_TOOL = /^desktop_(?:input|screenshot)/

/** Tool names → which chain steps are actually registered here. */
export function uiToolViewFromTools(tools: readonly string[] | undefined, over: Omit<UiToolView, 'tools' | 'steps'> = {}): UiToolViewOf {
    const names = tools || []
    // Direktlink/Fetch steht immer (fetch_url, parcel_track oder rohes HTTP).
    const steps: EscalationStep[] = ['direktlink']
    if (names.some(name => BROWSER_TOOL.test(String(name))) && !over.browserBroken) steps.push('browser')
    if (names.some(name => DESKTOP_TOOL.test(String(name))) && !over.desktopDisabled) steps.push('desktop')
    return {
        steps,
        browserMissing: !steps.includes('browser'),
        desktopMissing: !steps.includes('desktop'),
        present: steps.map(step => STEP_LABEL[step]),
    }
}

export function uiToolViewFromInventory(inventory: CapabilityInventory | null | undefined, over: Omit<UiToolView, 'tools' | 'steps'> = {}): UiToolViewOf {
    const tools = inventory?.tools || []
    const broken = inventory?.brokenTools
    const browserBroken = over.browserBroken === true || [...(broken || [])].some(name => /^browser_/.test(String(name)))
    return uiToolViewFromTools(tools, { ...over, browserBroken })
}

const STEP_LABEL: Record<EscalationStep, string> = {
    direktlink: 'Direktlink/Fetch',
    browser: 'Browser (Warten + echte Eingabe)',
    desktop: 'Desktop-Computer-Use',
}

/**
 * Fixed chain. Always starts at the cheapest step; a step is only "there"
 * when its tools are registered (or the caller forced `steps`).
 */
export function escalationChain(view: UiToolView = {}): EscalationStep[] {
    if (view.steps) return [...view.steps]
    return uiToolViewFromTools(view.tools, view).steps
}

// ---------------------------------------------------------------------------
// Falsche „unmöglich“-Behauptungen
// ---------------------------------------------------------------------------

/** The live 09.10. denial — and close friends. Never matches an honest "noch nicht". */
const FALSE_DENIAL = [
    /kein(?:\s+echtes)?\s+maus[-\s]?werkzeug/i,
    /kein(?:en)?\s+zugriff\s+(?:auf\s+)?(?:die\s+)?maus/i,
    /entzieht\s+sich\s+jedem\s+automatischen\s+zugriff/i,
    /entzieht\s+sich\s+jeder\s+automatisierung/i,
    /nicht\s+automatisierbar/i,
    /unm(?:ö|oe)glich\s+zu\s+automatisieren/i,
    /kann\s+nicht\s+(?:per|mit|durch)\s+(?:maus|tastatur|eingabe)\s+bedien/i,
    /kein\s+echtes\s+(?:maus|tastatur|eingabe|ui|gui)[-\s]?werkzeug/i,
]

export function detectsFalseDenial(reply: unknown): boolean {
    const value = String(reply ?? '')
    if (!value || value.length > 8_000) return false
    return FALSE_DENIAL.some(pattern => pattern.test(value))
}

/** Drop the false-denial sentences; keep the rest of the reply (partial results stay). */
export function stripFalseDenialSentences(reply: unknown): string {
    const value = String(reply ?? '')
    const sentences = value.split(/(?<=[.!?])\s+|\n+/).map(part => part.trim()).filter(Boolean)
    return sentences.filter(sentence => !FALSE_DENIAL.some(pattern => pattern.test(sentence))).join(' ').trim()
}

/** The correction the owner reads instead of the false claim. Never quotes the claim, never "unmöglich". */
export function formatDenialCorrection(view: UiToolViewOf): string {
    const parts = [
        'Korrektur: die Seite ist automatisierbar — jener Satz von eben stimmt nicht. '
        + `Kette: ${['Direktlink/Fetch', 'Browser (Warten + echte Eingabe)', 'Desktop-Computer-Use'].join(' → ')}.`,
    ]
    if (view.present.length) {
        parts.push(`Hier belegt: ${view.present.join(' → ')}. Ich gehe die Kette in dieser Reihenfolge ab und melde ehrlich, was dabei herauskommt.`)
    } else {
        parts.push('In diesem Lauf ist keine Stufe der Kette im Inventar — eine Lücke (Bedarf), kein Ausschluss.')
    }
    if (view.browserMissing) {
        parts.push('Browser/Chromium fehlt oder ist kaputt: als Bedarf notiert (Software-Scout).')
    }
    if (view.desktopMissing) {
        parts.push('Desktop-Eingabe derzeit nicht aktiv (NOVA_DESKTOP_INPUT_ENABLED / Owner-Enrollment).')
    }
    parts.push('Erst wenn alle Stufen ehrlich gescheitert sind, folgt die Ehrlichkeitsformel.')
    return parts.join(' ')
}

/**
 * Replace a false "unmöglich / kein Maus-Werkzeug" claim with the honest chain
 * note. Returns null when the reply is fine. Pure text — safe in every test.
 */
export function rewriteFalseDenial(reply: unknown, view: UiToolView | UiToolViewOf = {}): string | null {
    if (!detectsFalseDenial(reply)) return null
    const of = 'steps' in view && Array.isArray((view as UiToolViewOf).steps)
        ? view as UiToolViewOf
        : uiToolViewFromTools((view as UiToolView).tools, view as UiToolView)
    const cleaned = stripFalseDenialSentences(reply)
    const note = formatDenialCorrection(of)
    return cleaned ? `${cleaned}\n\n${note}` : note
}

// ---------------------------------------------------------------------------
// Prompt (vor dem Modell)
// ---------------------------------------------------------------------------

/** Fixed rule for the system prompt: run the chain before any "kann ich not". */
export function capabilityEscalationPrompt(): string {
    return '## Eskalationskette vor „kann ich nicht“\n'
        + 'Prüfe vor JEDER „kann ich nicht“-Antwort das Inventar und gehe die Kette ab:\n'
        + '1. Direktlink/Fetch — Tracking-Nummern und ähnliche IDs zuerst als URL-Parameter (z. B. `?tracking-id=…`, `?piececode=…`), dann API/`parcel_track`/`fetch_url`.\n'
        + '2. Browser mit Warten und echter Eingabe — `browser_navigate`, dann `browser_type`/`browser_click`, auf späte Elemente warten (`browser_extract`).\n'
        + '3. Desktop-Computer-Use — `desktop_screenshot` zur Orientierung, dann `desktop_input` (Move/Click/Type).\n'
        + 'Behaupte NIE „kein Maus-Werkzeug“, „nicht automatisierbar“, „entzieht sich jedem automatischen Zugriff“ oder „unmöglich“, '
        + 'solange eine Stufe noch nicht versucht ist. Fehlt nur Chromium/Playwright, melde das als Lücke (Bedarf), nicht als Unmöglichkeit.\n'
        + 'Scheitere erst nach der ganzen Kette ehrlich — und nenne dann die Stufen, die du versucht hast.'
}

// ---------------------------------------------------------------------------
// Lücken (Bedarf) statt „unmöglich“
// ---------------------------------------------------------------------------

/** Browser gap = demand learning (Software-Scout), never a claim of impossibility. */
export function noteUiGap(gap: UiGap, _detail = ''): void {
    try {
        // Lazy: keep this module free of install-cycle side effects at import time.
        void import('../install/software-demand.js').then(({ recordCapabilityNeed }) => {
            const capability: SoftwareCapability = gap === 'browser' ? 'browser' : 'desktop'
            const kind = gap === 'browser' ? 'browser-fehlt' : 'desktop-eingabe-fehlt'
            recordCapabilityNeed(capability, kind)
        }).catch(() => undefined)
    } catch { /* a missing signal only means: no card */ }
}

export function isBrowserMissingError(error: unknown): boolean {
    const text = String((error as { message?: string })?.message ?? error ?? '')
    return /playwright[^.]{0,40}(?:nicht installiert|not installed|executable doesn.?t exist)|chromium[^.]{0,40}(?:nicht gefunden|not found|missing)|executable doesn.?t exist|browser (?:type )?(?:launch|start).{0,20}(?:fail|error)/i.test(text)
}

// ---------------------------------------------------------------------------
// URL-Parameter (Tracking-Seiten nehmen die Nummer oft direkt)
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = ['tracking-id', 'trackingId', 'tracking_id', 'piececode', 'pieceCode', 'code', 'number', 'sendungsnummer', 'nums', 'id', 'q'] as const

/** Well-known parcel endpoints + generic `?«param»=id` candidates for any base URL. */
export function directLookupUrls(base: string, id: string): string[] {
    const code = String(id || '').trim()
    if (!code || code.length > 80) return []
    const enc = encodeURIComponent(code)
    const out: string[] = []
    const push = (url: string) => { if (url && !out.includes(url)) out.push(url) }

    let host = ''
    try { host = new URL(base).hostname.toLowerCase() } catch { host = String(base || '').toLowerCase() }
    if (/dhl\.(de|com|at|ch)/.test(host) || /dhl/i.test(base)) {
        push(`https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html?piececode=${enc}`)
        push(`https://nolp.dhl.de/next/public/search?lang=de&piececode=${enc}`)
        push(`https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${enc}`)
    }
    if (/17track/.test(host) || /17\s*track/i.test(base)) {
        push(`https://t.17track.net/de#nums=${enc}`)
        push(`https://www.17track.net/de/track?nums=${enc}`)
    }
    // Generic: the given base plus each common parameter (and a bare query form).
    const trimmed = String(base || '').trim()
    if (/^https?:\/\//i.test(trimmed)) {
        for (const param of TRACKING_PARAMS) {
            try {
                const url = new URL(trimmed)
                url.searchParams.set(param, code)
                push(url.toString())
            } catch { /* skip */ }
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Kette ausführen (Tests mit Fake-Page; Produktion über die vorhandenen Tools)
// ---------------------------------------------------------------------------

export interface UiLookupRequest {
    /** Base URL of the site (or a host word like `dhl`). */
    url: string
    /** The id to look up (tracking number, order id, …). */
    id: string
    /** Optional CSS/text selector for the browser input. */
    inputSelector?: string
}

export interface UiEscalationDeps {
    fetchPage?: (url: string) => Promise<{ ok: boolean; text?: string; status?: number }>
    browserNavigate?: (url: string) => Promise<unknown>
    browserWait?: (ms: number) => Promise<unknown>
    browserType?: (text: string, selector?: string) => Promise<unknown>
    browserClick?: (selector: string) => Promise<unknown>
    browserExtract?: () => Promise<unknown>
    desktopScreenshot?: () => Promise<unknown>
    desktopInput?: (action: Record<string, unknown>) => Promise<unknown>
    view?: UiToolViewOf
    noteGap?: (gap: UiGap, detail: string) => void
}

export interface UiEscalationResult {
    ok: boolean
    step: EscalationStep | 'keiner'
    evidence: string
    /** Honest owner text. Never "unmöglich". */
    reply: string
    gaps: UiGap[]
}

function pageHasId(text: unknown, id: string): boolean {
    const body = String(text ?? '')
    if (!body) return false
    return body.includes(id) || /\b(?:status|zustand|zugestellt|unterwegs|zugestellt|delivered|in transit|sendung)\b/i.test(body)
}

/**
 * Walk the chain with injectable ports. A fake page in tests is just `fetchPage`.
 * On Chromium-missing the browser step records a Bedarf and continues — never "unmöglich".
 */
export async function runUiEscalation(request: UiLookupRequest, deps: UiEscalationDeps = {}): Promise<UiEscalationResult> {
    const view = deps.view || uiToolViewFromTools([], {})
    const gaps: UiGap[] = []
    const note = deps.noteGap || noteUiGap
    const chain = view.steps.length ? view.steps : escalationChain(view)

    // 1) Direktlink / Fetch
    if (chain.includes('direktlink') && deps.fetchPage) {
        for (const url of directLookupUrls(request.url, request.id)) {
            try {
                const page = await deps.fetchPage(url)
                if (page?.ok && pageHasId(page.text, request.id)) {
                    return {
                        ok: true, step: 'direktlink',
                        evidence: `Seite über ${safeUrl(url)} liefert Beleg zur ID`,
                        reply: `Beleg über den Direktlink: ${safeUrl(url)}. Ohne UI-Eingabe.`,
                        gaps,
                    }
                }
            } catch { /* next candidate */ }
        }
    }

    // 2) Browser (Warten + echte Eingabe)
    if (chain.includes('browser') && deps.browserNavigate) {
        try {
            await deps.browserNavigate(String(request.url || '').slice(0, 300))
            if (deps.browserWait) await deps.browserWait(400)
            if (deps.browserType && request.inputSelector) {
                await deps.browserType(request.id, request.inputSelector)
                if (deps.browserClick) await deps.browserClick('button[type="submit"], input[type="submit"], button')
                if (deps.browserWait) await deps.browserWait(600)
            }
            const extract = deps.browserExtract ? await deps.browserExtract() : ''
            if (pageHasId(extract, request.id)) {
                return {
                    ok: true, step: 'browser',
                    evidence: 'Browser mit Warten + Eingabe liefert Beleg',
                    reply: `Beleg über den Browser (Warten + echte Eingabe) zu ${request.id}.`,
                    gaps,
                }
            }
        } catch (error) {
            if (isBrowserMissingError(error)) {
                gaps.push('browser')
                note('browser', String(error).slice(0, 120))
            }
        }
    } else if (chain.includes('browser') && view.browserMissing) {
        // Present in the requested chain but tools are gone: that is a gap.
    }

    // 3) Desktop-Computer-Use
    if (chain.includes('desktop') && deps.desktopScreenshot && deps.desktopInput) {
        try {
            await deps.desktopScreenshot()
            await deps.desktopInput({ action: 'type', text: request.id })
            await deps.desktopInput({ action: 'key', key: 'Return' })
            return {
                ok: true, step: 'desktop',
                evidence: 'Desktop-Computer-Use (Screenshot + Eingabe) ausgeführt',
                reply: `Desktop-Computer-Use ausgeführt (Screenshot + Eingabe von ${request.id}). Ergebnis per Screenshot prüfen.`,
                gaps,
            }
        } catch (error) {
            gaps.push('desktop')
            note('desktop', String(error).slice(0, 120))
        }
    }

    const tried = chain.map(step => STEP_LABEL[step]).join(' → ') || 'keine Stufe'
    const gapNote = gaps.length
        ? ` Lücke notiert (${gaps.join(', ')}) — Bedarf, kein Ausschluss.`
        : ''
    return {
        ok: false, step: 'keiner',
        evidence: `Kette versucht: ${tried}`,
        reply: `Die Kette (${tried}) hat hier keinen belegten Treffer geliefert. Das ist das ehrliche Ergebnis.${gapNote}`,
        gaps,
    }
}

function safeUrl(url: string): string {
    try {
        const parsed = new URL(url)
        return `${parsed.origin}${parsed.pathname}`
    } catch {
        return String(url).slice(0, 80)
    }
}

export default {
    detectsFalseDenial,
    stripFalseDenialSentences,
    formatDenialCorrection,
    rewriteFalseDenial,
    capabilityEscalationPrompt,
    escalationChain,
    uiToolViewFromTools,
    uiToolViewFromInventory,
    directLookupUrls,
    runUiEscalation,
    noteUiGap,
    isBrowserMissingError,
}
