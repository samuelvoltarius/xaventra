/**
 * Gedanken-Hub (2.81.0 integration): one thought store for every phase.
 *
 * Phase 2 (Wahrnehmen), Phase 3 (Denken), Phase 4 (Selbst-Update) and
 * Phase 5b (Software-Scout) each produce thoughts through their own port. Here they become planner thoughts
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
    | { kind: 'software-scout'; candidateId: string; nodeId: string; dedupeKey: string }

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

/**
 * Phase 5b: a software gap becomes a thought with permission `fragen`. Only
 * candidate id and node id are remembered (checked against the release's
 * candidate catalog); the catalog id is looked up again on "Ja", never taken
 * from the thought.
 */
export function createSoftwareScoutThoughtSink() {
    return {
        async emit(thought: any): Promise<void> {
            const { findSoftwareCandidate } = await import('../install/software-candidates.js')
            const candidate = findSoftwareCandidate(thought?.candidateId)
            const nodeId = String(thought?.nodeId || '')
            const { thought: stored } = addThought({
                source: 'software-scout',
                title: String(thought?.title || ''),
                evidence: [thought?.text, ...(Array.isArray(thought?.evidence) ? thought.evidence : [])].filter(Boolean).join(' · '),
                severity: 'info',
                kind: 'vorschlag',
                proposal: thought?.proposal ? String(thought.proposal) : undefined,
                permission: 'fragen',
                signature: thought?.dedupeKey ? String(thought.dedupeKey) : undefined,
                node: nodeId || undefined,
            })
            if (candidate && /^[A-Za-z0-9._-]{1,80}$/.test(nodeId)) {
                remember(stored.id, { kind: 'software-scout', candidateId: candidate.id, nodeId, dedupeKey: String(thought?.dedupeKey || '').slice(0, 200) })
            }
        },
    }
}

async function answerSoftwareScout(action: Extract<StoredAction, { kind: 'software-scout' }>, answer: 'ja' | 'nein'): Promise<{ ok: boolean; message: string }> {
    const { recordSoftwareScoutAnswer } = await import('../install/software-scout.js')
    recordSoftwareScoutAnswer(action.dedupeKey, answer)
    if (answer === 'nein') return { ok: true, message: 'Verworfen; diesen Software-Vorschlag bringe ich 30 Tage nicht mehr.' }
    const { findSoftwareCandidate } = await import('../install/software-candidates.js')
    const candidate = findSoftwareCandidate(action.candidateId)
    if (!candidate) return { ok: false, message: 'Kandidat steht nicht mehr im Software-Katalog; nichts geändert.' }
    if (!candidate.catalogId) {
        return { ok: true, message: `Vermerkt: ${candidate.title} auf ${action.nodeId}. Katalogeintrag nötig — es gibt dafür noch keinen Installationskatalog-Eintrag, also wird nichts installiert.` }
    }
    // The existing Stufe-2 path: install queue → install card → signed ticket. No ticket here.
    const { defaultInstallDeps, proposeCatalogInstall, resolveInstallTarget } = await import('../install/install-queue.js')
    const target = await resolveInstallTarget(action.nodeId).catch(() => null)
    if (!target) return { ok: false, message: `Kein Profil für ${action.nodeId}; nichts in die Warteschlange gestellt.` }
    const result = proposeCatalogInstall(candidate.catalogId, target, defaultInstallDeps(), 'scan')
    return { ok: result.ok, message: `${result.message}${result.ok && result.proposal?.status === 'queued' ? ' Freigabe kommt als Installations-Karte (signiertes Ticket, mit Rückweg).' : ''}` }
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
    if (action.kind === 'software-scout') return answerSoftwareScout(action, answer)
    if (answer === 'nein') return { ok: true, message: 'Verworfen.' }
    if (action.kind === 'approveDevice') {
        const { approveSensingDevice } = await import('../sensing/runtime.js')
        return approveSensingDevice(action.deviceId, { principalId: ctx.userId, permission: 'owner' })
    }
    if (action.kind === 'self-update') return { ok: true, message: 'Vermerkt. Die Aktivierung führt erst der Host-Agent aus, sobald er dafür eingerichtet ist; bis dahin rollt Claude aus.' }
    return { ok: true, message: `Vermerkt (${action.what}); die Ausführung dafür ist noch nicht gebaut.` }
}
