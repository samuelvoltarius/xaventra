/**
 * Gedanken-Hub (2.81.0 integration): one thought store for every phase.
 *
 * Phase 2 (Wahrnehmen), Phase 3 (Denken) and Phase 4 (Selbst-Update) each
 * produce thoughts through their own port. Here they become planner thoughts
 * (src/planner/thoughts.ts): fixed importance rules, quiet hours, dedupe,
 * daily limit, /gedanken, and — for permission `fragen` — a Knopf-Karte.
 *
 * The action behind a thought is remembered by the CODE, from a closed list
 * of known kinds (approveDevice, thinking decision, self-update). Anything
 * else a producer might attach is dropped. A button press dispatches only
 * these known actions; there is no generic "run this" path.
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { addThought } from '../planner/index.js'

type StoredAction =
    | { kind: 'approveDevice'; deviceId: string }
    | { kind: 'thinking'; thoughtKind: string }
    | { kind: 'self-update'; action: string }
    | { kind: 'note'; what: string }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/
const file = () => getNovaDataDir('thought-actions.json')
function load(): Record<string, StoredAction> {
    try { return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {} } catch { return {} }
}
function remember(thoughtId: string, action: StoredAction): void {
    const all = load()
    all[thoughtId] = action
    const keys = Object.keys(all)
    for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete all[key]
    atomicWriteJsonSync(file(), all)
}

/** Planner sources are `^[a-z][a-z0-9-]{1,31}$`. */
function sourceName(prefix: string, value: unknown): string {
    const tail = String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    return `${prefix}-${tail || 'quelle'}`.slice(0, 32).replace(/-+$/, '')
}

function severityFromLabel(value: string): 'critical' | 'warning' | 'info' {
    return value === 'dringend' || value === 'kritisch' ? 'critical' : value === 'hoch' ? 'warning' : 'info'
}

export function createSensingThoughtSink() {
    return {
        writeThought(thought: any): void {
            const { thought: stored } = addThought({
                source: sourceName('wahrnehmen', thought.source),
                title: String(thought.title || ''),
                evidence: [thought.summary, thought.evidence ? JSON.stringify(thought.evidence) : ''].filter(Boolean).join(' · '),
                severity: severityFromLabel(String(thought.importance || '')),
                kind: thought.action ? 'vorschlag' : 'ereignis',
                proposal: thought.proposal ? String(thought.proposal) : undefined,
                permission: thought.level === 'fragen' || thought.level === 'nie' ? thought.level : 'selbst',
                signature: thought.dedupeKey ? String(thought.dedupeKey) : undefined,
                node: thought.origin?.nodeId,
            })
            const action = thought.action
            if (action?.kind === 'approveDevice' && ID.test(String(action.deviceId || ''))) remember(stored.id, { kind: 'approveDevice', deviceId: String(action.deviceId) })
            else if (action?.kind === 'connectAccount' || action?.kind === 'applyQuietHours') remember(stored.id, { kind: 'note', what: action.kind })
        },
    }
}

export function createThinkingThoughtSink() {
    return {
        async emit(thought: any): Promise<void> {
            const evidence = (thought.evidence || []).map((item: any) => `${item.metric}=${item.value}${item.unit || ''} (${item.source})`).join(', ')
            const { thought: stored } = addThought({
                source: sourceName('denken', thought.source),
                title: String(thought.title || ''),
                evidence: [thought.text, evidence, thought.target ? `Ziel: ${thought.target}` : ''].filter(Boolean).join(' · '),
                severity: Number(thought.importance) >= 0.8 ? 'warning' : 'info',
                kind: thought.stufe === 'fragen' ? 'vorschlag' : 'idee',
                proposal: thought.proposal?.action ? String(thought.proposal.action) : undefined,
                permission: thought.stufe === 'fragen' || thought.stufe === 'nie' ? thought.stufe : 'selbst',
                signature: thought.dedupeKey ? String(thought.dedupeKey) : undefined,
            })
            if (thought.kind && /^[a-z0-9:_-]{1,80}$/i.test(String(thought.kind))) remember(stored.id, { kind: 'thinking', thoughtKind: String(thought.kind) })
        },
    }
}

export function createSelfUpdateThoughtSink() {
    return {
        async emit(thought: any): Promise<void> {
            const { thought: stored } = addThought({
                source: 'selbst-update',
                title: String(thought.title || ''),
                evidence: [thought.text, ...(thought.evidence || [])].filter(Boolean).join(' · '),
                severity: severityFromLabel(String(thought.importance || '')),
                kind: thought.proposal ? 'vorschlag' : 'ereignis',
                proposal: thought.proposal?.action ? String(thought.proposal.action) : undefined,
                permission: thought.permission === 'fragen' || thought.permission === 'nie' ? thought.permission : 'selbst',
                signature: thought.dedupeKey ? String(thought.dedupeKey) : undefined,
            })
            if (thought.proposal?.action) remember(stored.id, { kind: 'self-update', action: String(thought.proposal.action).slice(0, 60) })
        },
    }
}

/** Called by the `gedanke` card executor after the owner pressed Ja/Nein. */
export async function dispatchThoughtAnswer(thoughtId: string, answer: 'ja' | 'nein', ctx: { userId: string }): Promise<{ ok: boolean; message: string }> {
    const action = load()[thoughtId]
    if (!action) return { ok: true, message: answer === 'ja' ? 'Angenommen.' : 'Verworfen.' }
    if (action.kind === 'thinking') {
        const { recordDecision } = await import('../thinking/thinking-runtime.js')
        await recordDecision(action.thoughtKind, answer)
        return { ok: true, message: answer === 'ja' ? 'Angenommen, ich setze die Idee als Vorschlag um.' : 'Verworfen, ich schlage so etwas seltener vor.' }
    }
    if (answer === 'nein') return { ok: true, message: 'Verworfen.' }
    if (action.kind === 'approveDevice') {
        const { approveSensingDevice } = await import('../sensing/runtime.js')
        return approveSensingDevice(action.deviceId, { principalId: ctx.userId, permission: 'owner' })
    }
    if (action.kind === 'self-update') return { ok: true, message: 'Vermerkt. Die Aktivierung führt erst der Host-Agent aus, sobald er dafür eingerichtet ist; bis dahin rollt Claude aus.' }
    return { ok: true, message: `Vermerkt (${action.what}); die Ausführung dafür ist noch nicht gebaut.` }
}
