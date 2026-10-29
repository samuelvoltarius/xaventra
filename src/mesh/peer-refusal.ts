/**
 * 2.90.1 (Peer-Test 29.10., 2.89.15 auf ns1/ns2/NAS): a node that does not know the owner answers a hand-over
 * with its fixed guest greeting or a refusal within milliseconds. The Main took that text as the result, asked
 * the node four more times and ran into the run limit. Such an answer is a failed hand-over with one clear
 * sentence, and the same node is not asked again in the same run (spawn_subagent and mesh_delegate).
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

export function peerRefusalSentence(node: string): string {
    return `Der Knoten ${node} hat den Auftrag nur mit Gast-Rechten angenommen und nichts ausgeführt — dort bist du nicht als Owner erkannt (Knoten-Stand oder Schlüssel). Nicht erneut an ${node} schicken; sag das dem Nutzer in einem Satz.`
}

const TTL_MS = 10 * 60_000
const refused = new Map<string, number>()
const runKey = () => {
    const context = getExecutionPolicyContext()
    return String(context.runId || context.contractId || context.authUserId || context.userId || 'anon')
}

export function rememberPeerRefusal(node: string, now = Date.now()): void {
    for (const [key, until] of refused) if (until <= now) refused.delete(key)
    refused.set(`${runKey()}|${node}`, now + TTL_MS)
}

/** True when this node refused in the current run; the hand-over is then not sent again. */
export function peerRefusedInThisRun(node: string, now = Date.now()): boolean {
    const until = refused.get(`${runKey()}|${node}`)
    return until !== undefined && until > now
}
