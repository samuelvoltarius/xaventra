/**
 * Projekte im laufenden System (2.88): verbindet den ProjectCoordinator mit
 * Unteragenten (Hintergrundarbeit, nur sichere Werkzeuge), dem einen
 * Meldeweg an den Owner (sendGovernedProactive → Planer, Ruhezeiten,
 * Entdopplung) und den bestehenden Aufträgen/Zielen (keine Doppelarbeit).
 */
import { getNovaDataDir } from './data-root.js'
import { ProjectCoordinator, goalSimilarity, type ProjectLink, type ProjectNoticeKind, type ProjectPorts } from './projects.js'

const RUN_TIMEOUT_MS = 5 * 60_000
const SAME_WORK = 0.6

const SEVERITY: Record<ProjectNoticeKind, 'info' | 'warning'> = { frage: 'warning', fertig: 'warning', fehler: 'warning', stand: 'info' }

let coordinator: ProjectCoordinator | null = null

/** Existing Auftrag (running or queued) or open goal that already covers this goal. */
export function findExistingWork(goal: string, principalId: string, sources: {
    active?: { id: string; goal: string; status: string } | null
    queue?: Array<{ goal: string; userId: string }>
    goals?: Array<{ id: string; title: string; status: string }>
}): ProjectLink | null {
    const active = sources.active
    if (active && ['active', 'paused', 'planning'].includes(active.status) && goalSimilarity(goal, active.goal) >= SAME_WORK) {
        return { art: 'auftrag', ref: active.id, titel: active.goal.slice(0, 80), aktiv: true }
    }
    const queued = (sources.queue || []).find(item => goalSimilarity(goal, item.goal) >= SAME_WORK)
    if (queued) return { art: 'auftrag', ref: 'warteschlange', titel: queued.goal.slice(0, 80), aktiv: true }
    const open = (sources.goals || []).find(item => ['planned', 'active', 'blocked'].includes(item.status) && goalSimilarity(goal, item.title) >= SAME_WORK)
    // An open goal is context, not running work: the project still works on it.
    if (open) return { art: 'ziel', ref: open.id, titel: open.title.slice(0, 80), aktiv: false }
    return null
}

function defaultPorts(): ProjectPorts {
    return {
        async run(project, instruction, signal) {
            const { spawnSubagent } = await import('../agents/subagent-orchestrator.js')
            const result = await spawnSubagent({
                task: instruction,
                userId: project.principalId,
                authUserId: project.auftraggeber?.rawId || project.principalId,
                timeoutMs: RUN_TIMEOUT_MS,
            }, { signal })
            return { ok: result.status === 'completed' && Boolean(result.output), text: result.output || result.error || result.status }
        },
        async notify(project, text, kind) {
            const state = (globalThis as any).__novaState
            const send = state?.sendGovernedProactive
            if (typeof send !== 'function') return
            await send.call(state, text, 'projekte', SEVERITY[kind], 0.95, `projekt:${project.id}:${kind}:${project.runden}:${project.updatedAt}`, [`projekt:${project.id}`])
        },
        findExisting(goal, principalId) {
            try {
                const executor = loaded.executor
                const goals = loaded.goals
                return findExistingWork(goal, principalId, {
                    active: executor?.getActiveMission?.() || null,
                    queue: (executor?.getMissionQueue?.() || []).filter((item: { userId: string }) => item.userId),
                    goals: goals?.getGoalManager?.().list(principalId) || [],
                })
            } catch { return null }
        },
    }
}

const loaded: { executor?: any; goals?: any } = {}

/** The process-wide coordinator. On a Main it resumes running projects once. */
export async function getProjectCoordinator(): Promise<ProjectCoordinator> {
    if (coordinator) return coordinator
    const [executor, goals] = await Promise.all([
        import('./autonomous-executor.js').catch(() => undefined),
        import('./goal-manager.js').catch(() => undefined),
    ])
    loaded.executor = executor
    loaded.goals = goals
    if (coordinator) return coordinator
    coordinator = new ProjectCoordinator({ dataDir: getNovaDataDir('projekte'), ports: defaultPorts() })
    if (process.env.NOVA_NODE_ONLY !== 'true' && process.env.NOVA_TEST_MODE !== '1') {
        const created = coordinator
        // Only the live Main continues background projects (same authority as owner notices).
        void (async () => {
            try {
                const { MAIN_SERVICE, verifyLiveServiceLeadership } = await import('../mesh/leader-election.js')
                const { hasValidFence } = await import('../mesh/fence.js')
                if (await verifyLiveServiceLeadership(MAIN_SERVICE) || hasValidFence(MAIN_SERVICE)) created.resume()
            } catch { /* no authority proof: do not resume here */ }
        })()
    }
    return coordinator
}

export function setProjectCoordinator(value: ProjectCoordinator | null): void {
    coordinator?.stopAll()
    coordinator = value
}