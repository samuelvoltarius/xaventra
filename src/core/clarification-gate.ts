import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { actionRequestText, detectActionIntent, isConversationOnly } from './action-intent.js'
import { getSessionContinuityStore, type PendingClarification } from '../memory/session-summarizer.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'
import { getBeliefStore } from './belief-store.js'
import { inferRequiredToolTargets } from './tool-evidence-binding.js'

export interface ClarificationDecision {
    action: 'continue' | 'ask' | 'cancel'
    content: string
    question?: string
    reason?: string
    missingFields: string[]
    confidence: number
    evidence: string[]
}

const CANCEL = /^(?:abbrechen|stopp?|vergiss es|cancel|never mind)$/i
const SOCIAL = /^(?:hallo|hi|hey|guten (?:morgen|abend|tag)|danke|ok(?:ay)?|super|perfekt)[!. ]*$/i
const AMBIGUOUS_REFERENCE = /\b(?:das|dies|dort|da|ihn|sie|es|that|this|there|it)\b/i
const IMPERSONAL_REFERENCE = /\b(?:(?:wie\s+spät|wie\s+viel\s+uhr)\s+ist\s+es|what\s+time\s+is\s+it)\b/gi
const HIGH_IMPACT = /\b(?:installier\w*|deinstallier\w*|deploy\w*|rollout|neustart\w*|restart\w*|lösch\w*|loesch\w*|entfern\w*|send\w*|schick\w*|service\s+(?:start|stop|restart))\b/i
const EXPLICIT_TARGET = /\b(?:auf|an|nach|zu|von|node|host|server|main|spark|pi5?|ns[12]|home|localhost|telegram|datei|ordner)\b/i

// Only this bounded local capture + reply shape supplies its own referents.
// A second operation, another recipient or unspecified capture stays gated.
const OWN_SCREENSHOT_REPLY = /^(?:und\s+)?(?:bitte\s+)?(?:mach|mache|erstelle)\s+(?:mal\s+)?(?:ein|eine|einen)\s+(?:screenshot|bildschirmfoto)\s+deines\s+(?:systems|bildschirms|desktops|arbeitsdesktops)(?:\s+und\s+(?:send|sende|schick|schicke)\s+(?:mir\s+(?:diesen|dieses|den|das|ihn|es)|(?:diesen|dieses|den|das|ihn|es)\s+mir))?[.!?]*$/i
// A pending question is only an answer slot while the conversation is fresh.
// A clarification persisted a day ago (and copied along on an update) must
// never turn the next unrelated message into that old action.
export const PENDING_CLARIFICATION_TTL_MS = 30 * 60_000
// Small talk is never an answer that authorizes the pending action.
const SMALL_TALK = /^(?:und\s+)?(?:wie\s+geht(?:['’]?s|\s+es)(?:\s+(?:dir|euch))?|wie\s+läuft(?:['’]?s|\s+es)|was\s+machst\s+du|alles\s+(?:gut|ok|klar|fit))\b[^.!]*[?!.]*$/i
const OBSOLETE_WORKFLOW_QUESTION = /^Ich habe dazu widersprüchliche oder unsichere Evidence \(workflow:[a-z-]+\)\. Welche Angabe soll ich als gültig behandeln\?$/

function hasExplicitReadUrlReference(text: string): boolean {
    const targets = inferRequiredToolTargets(text)
    return /^(?:test(?:e)?|prüfe?|pruefe?|check)\b/i.test(text)
        && !HIGH_IMPACT.test(actionRequestText(text))
        && targets.length === 1 && /^https?:\/\//i.test(targets[0])
}

function continuationEvidence(principalId: string, content: string): string[] {
    const summary = getSessionContinuityStore().getSummary(principalId)
    const evidence: string[] = []
    if (summary?.openGoals.length) evidence.push('user-scoped open goal')
    const recent = summary?.lastUpdated && Date.now() - summary.lastUpdated < 15 * 60_000
    if (recent && summary?.lastUserIntent && summary.lastUserIntent !== content) {
        evidence.push('recent previous user intent')
        if (EXPLICIT_TARGET.test(summary.lastUserIntent)) evidence.push('previous target context')
    }
    if (summary?.projectContext) evidence.push('project context')
    const graph = getCapabilityGraph().getSnapshot()
    if (graph.nodes.length === 1) evidence.push('single known mesh node')
    return evidence
}

export function evaluateClarification(principalId: string, content: string): ClarificationDecision {
    const text = String(content || '').trim()
    const store = getSessionContinuityStore()
    let pending = store.getSummary(principalId)?.pendingClarification
    // Old versions persisted target questions for announcements. Do not turn
    // the next ordinary reply into a resumed installation from that bad state.
    const expired = pending && (typeof pending.createdAt !== 'number' || !Number.isFinite(pending.createdAt)
        || Date.now() - pending.createdAt > PENDING_CLARIFICATION_TTL_MS)
    if (pending && (expired || isConversationOnly(pending.originalRequest)
        || (pending.missingFields.length === 1 && pending.missingFields[0] === 'belief'
            && OBSOLETE_WORKFLOW_QUESTION.test(pending.question))
        || (pending.missingFields.length === 1 && pending.missingFields[0] === 'reference'
            && hasExplicitReadUrlReference(pending.originalRequest))
        || (pending.missingFields.length === 1 && ['target', 'reference'].includes(pending.missingFields[0])
            && OWN_SCREENSHOT_REPLY.test(pending.originalRequest.trim())))) {
        store.clearPendingClarification(principalId)
        pending = undefined
    }

    if (pending) {
        if (CANCEL.test(text)) {
            store.clearPendingClarification(principalId)
            return { action: 'cancel', content: '', reason: 'user cancelled pending clarification', missingFields: [], confidence: 1, evidence: ['pending clarification'] }
        }
        // A new announcement/explanation is not an answer authorizing the old
        // action. Leave that clarification pending and answer this turn normally.
        if (isConversationOnly(text) || SOCIAL.test(text) || SMALL_TALK.test(text)) {
            return { action: 'continue', content: text, missingFields: [], confidence: 1, evidence: ['conversation does not resume pending action'] }
        }
        const restored = store.consumePendingClarification(principalId)!
        return {
            action: 'continue',
            content: `${restored.originalRequest}\n\n[Nutzer-Klärung: ${text}]`,
            reason: 'resuming the original request with the user answer',
            missingFields: [], confidence: 1, evidence: ['durable user-scoped clarification'],
        }
    }

    // NovaOS: Hier gibt es genau EINE Maschine — diese. Die Rueckfrage
    // "Auf welchem Node, Dienst oder Ziel soll ich das ausfuehren?" hat nur
    // eine moegliche Antwort und ist fuer den gedachten Nutzer eine
    // Sackgasse. Sie kam ausserdem in 0 Sekunden, noch bevor das Modell
    // ueberhaupt gefragt wurde. Im Normalmodus wird hier gar nicht mehr
    // zurueckgefragt: Nova entscheidet selbst. Im Expertenmodus bleibt das
    // Tor unveraendert. Am 30.08.2026 am laufenden System gemessen.
    if (process.env.NOVA_OS_MODE === 'true') {
        let novaOsModus = ''
        try {
            novaOsModus = readFileSync('/etc/novaos/modus', 'utf-8').trim()
        } catch { novaOsModus = '' }
        if (novaOsModus !== 'experte') {
            return {
                action: 'continue', content: text, missingFields: [], confidence: 1,
                evidence: ['NovaOS Normalmodus — keine Rueckfragen, es gibt nur diese Maschine'],
            }
        }
    }

    const intent = detectActionIntent(text)
    if (!intent.requiresTool || SOCIAL.test(text)) {
        return { action: 'continue', content: text, missingFields: [], confidence: 1, evidence: ['non-action request'] }
    }

    const evidence = continuationEvidence(principalId, text)
    const hasReferenceContext = evidence.includes('recent previous user intent')
    const hasTargetContext = evidence.includes('previous target context')
    // Remove only the impersonal clause for reference analysis, not the whole
    // request. Other references and high-impact target checks must still apply.
    const requestText = actionRequestText(text)
    // Reuse evidence's conservative single-GET transcript scoping. A literal
    // URL resolves a read-only reference, not a missing deployment/deletion
    // destination. Multiple targets and unrelated actions still require context.
    const explicitReadTarget = hasExplicitReadUrlReference(text)
    const ownScreenshotReply = OWN_SCREENSHOT_REPLY.test(text)
    const ambiguous = AMBIGUOUS_REFERENCE.test(requestText.replace(IMPERSONAL_REFERENCE, ''))
        && !EXPLICIT_TARGET.test(requestText) && !explicitReadTarget && !ownScreenshotReply
    const missingTarget = HIGH_IMPACT.test(requestText) && !EXPLICIT_TARGET.test(requestText) && !ownScreenshotReply
    const uncertainBelief = getBeliefStore().unresolved(principalId).find(belief => {
        // Outcome-derived route reliability is diagnostic metadata, not an
        // unresolved user fact. Keep it stored; a new observation still needs
        // independently verified evidence and never inherits success from it.
        if (belief.subject.startsWith('workflow:') && belief.predicate === 'route-success') return false
        const terms = `${belief.subject} ${belief.predicate} ${belief.value}`.toLowerCase().split(/[^a-z0-9äöüß]+/i).filter(term => term.length >= 4)
        return terms.some(term => text.toLowerCase().includes(term))
    })
    if ((ambiguous && !hasReferenceContext) || (missingTarget && !hasTargetContext) || uncertainBelief) {
        const question = uncertainBelief
            ? `Ich habe dazu widersprüchliche oder unsichere Evidence (${uncertainBelief.subject}). Welche Angabe soll ich als gültig behandeln?`
            : missingTarget
            ? 'Auf welchem Node, Dienst oder Ziel soll ich das ausführen?'
            : 'Worauf genau bezieht sich das?'
        const clarification: PendingClarification = {
            id: randomUUID(), originalRequest: text, question,
            missingFields: [uncertainBelief ? 'belief' : missingTarget ? 'target' : 'reference'], createdAt: Date.now(),
        }
        store.setPendingClarification(principalId, clarification)
        return {
            action: 'ask', content: text, question,
            reason: uncertainBelief ? 'relevant belief is disputed or uncertain' : missingTarget ? 'high-impact action has no resolvable target' : 'ambiguous reference has no user-scoped continuation',
            missingFields: clarification.missingFields, confidence: 0.95,
            evidence: evidence.length ? evidence : ['no matching user-scoped context'],
        }
    }

    return { action: 'continue', content: text, missingFields: [], confidence: hasReferenceContext ? 0.9 : 0.8, evidence }
}
