/**
 * 2.90.1 (Peer-Test 29.10., 2.89.15 auf ns1/ns2/NAS): a node that does not know the owner answers a hand-over
 * with its fixed guest greeting or a refusal within milliseconds. The Main took that text as the result, asked
 * the node four more times and ran into the run limit. Such an answer is a failed hand-over with one clear
 * sentence, and the same node is not asked again in the same run (spawn_subagent and mesh_delegate).
 *
 * 2.90.2 (Abnahme 2.90.1, Langtest B): a node that REJECTS the request (mesh policy, e.g.
 * agent_tool_not_globally_allowed) is "abgelehnt", never "nicht erreichbar"; the runner ends the run with the
 * sentence (`isHandoffRefusal`), so the model neither hands over again nor wanders through status tools.
 */
import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'

/** Openings/markers of the peer's own access texts (multi-user-middleware onboarding and checkAuth). */
const REFUSAL = [
    /Du bist als \**Gast\** verbunden/i,
    /Ein Admin kann deine Rechte erweitern/i,
    /^🔒 Zugriff verweigert/u,
    /^Du bist blockiert/i,
    /User-ID ist bereits an einen anderen Kanal gebunden/i,
]

export function isPeerRefusal(text: unknown): boolean {
    const value = String(text ?? '').trim()
    return Boolean(value) && REFUSAL.some(pattern => pattern.test(value))
}

/** Every refused hand-over sentence starts with this; the runner ends the run on it. */
const HANDOFF_REFUSED = '⛔ Übergabe an '

export function peerRefusalSentence(node: string): string {
    return `${HANDOFF_REFUSED}${node} nicht ausgeführt: Der Knoten hat den Auftrag nur mit Gast-Rechten angenommen — dort bist du nicht als Owner erkannt (Knoten-Stand oder Schlüssel).`
}

/** Mesh policy reasons (mesh-policy.ts) in plain words; unknown reasons are named as they are. */
const REJECTION_WORDS: Array<[RegExp, string]> = [
    [/agent_tool_not_(?:globally_)?allowed|agent_tool_not_allowed_for_peer/, 'er erlaubt die angeforderten Werkzeuge nicht'],
    [/role_not_allowed|request_role_not_allowed/, 'er nimmt von diesem Knoten keine Aufträge in dieser Rolle an'],
    [/missing_peer_key|untrusted_node|invalid_signature/, 'er kennt den Schlüssel dieses Knotens nicht'],
    [/missing_fence|fenced|coordination_disabled/, 'er erkennt diesen Knoten gerade nicht als Main an'],
]

export function peerRejectionSentence(node: string, reason: string): string {
    const raw = String(reason || '').replace(/^Error:\s*/i, '').trim().slice(0, 80)
    const words = REJECTION_WORDS.find(([pattern]) => pattern.test(raw))?.[1]
    return `${HANDOFF_REFUSED}${node} abgelehnt: ${words || `der Knoten meldet „${raw || 'ohne Angabe'}“`}.`
}

/** True for a tool result that carries a refused hand-over sentence (string or JSON with it). */
export function isHandoffRefusal(result: unknown): boolean {
    return String(typeof result === 'string' ? result : JSON.stringify(result ?? '')).includes(HANDOFF_REFUSED)
}

/** The refused hand-over sentence inside a tool result, for the owner. */
export function handoffRefusalText(result: unknown): string {
    const text = String(typeof result === 'string' ? result : (result as any)?.error ?? JSON.stringify(result ?? ''))
    const at = text.indexOf(HANDOFF_REFUSED)
    return at < 0 ? text : text.slice(at).split('\n')[0].replace(/"\s*[,}].*$/, '')
}

/** 2.90.3 (probe 00:06): after a proven hand-over the model is told not to hand the same node the task again. */
const HANDOFF_DONE_HINT = '(Ergebnis liegt vor — nicht erneut an '

export function handoffDoneHint(node: string): string {
    return `${HANDOFF_DONE_HINT}${node} übergeben; antworte mit diesem Ergebnis.)`
}

/**
 * 2.90.3: the proven result inside a successful hand-over tool result ("✅ Subagent … fertig (… ms):" or
 * "Ergebnis von <node>:"), without the header and the model hint; null for anything else (refusals, errors).
 */
export function handoffResultText(result: unknown): string | null {
    const text = String(typeof result === 'string' ? result : '')
    if (!text || text.includes(HANDOFF_REFUSED)) return null
    const match = /(?:✅ Subagent \S+ fertig \([^)]*\):|Ergebnis von (\S+):)\n([\s\S]+)/u.exec(text)
    if (!match) return null
    const body = match[2].split(HANDOFF_DONE_HINT)[0].trim().slice(0, 1500)
    return body || null
}

const TTL_MS = 10 * 60_000
const refused = new Map<string, { until: number; sentence: string }>()
/** The governed run; without one nothing is remembered ("in the same run" needs a run). */
const runKey = (): string | null => {
    const context = getExecutionPolicyContext()
    return context.runId || context.contractId ? String(context.runId || context.contractId) : null
}

export function rememberPeerRefusal(node: string, sentence = peerRefusalSentence(node), now = Date.now()): void {
    for (const [key, entry] of refused) if (entry.until <= now) refused.delete(key)
    const run = runKey()
    if (run) refused.set(`${run}|${node}`, { until: now + TTL_MS, sentence })
}

/** The sentence when this node refused in the current run; the hand-over is then not sent again. */
export function peerRefusalInThisRun(node: string, now = Date.now()): string | null {
    const run = runKey()
    const entry = run ? refused.get(`${run}|${node}`) : undefined
    return entry && entry.until > now ? entry.sentence : null
}

export function peerRefusedInThisRun(node: string, now = Date.now()): boolean {
    return peerRefusalInThisRun(node, now) !== null
}
