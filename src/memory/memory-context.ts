import { getMemoryGovernanceCoordinator } from './memory-governance.js'
import { getSessionContinuityStore } from './session-summarizer.js'

export interface MemoryContextRequest {
    scopes: string[]
    principalId: string
    channel: string
    query: string
    observeUserTurn?: boolean
    legacySessionNames?: string[]
}

/**
 * The single prompt assembly boundary for personal memory and conversation
 * continuity. Canonical facts come from governance; the continuity store adds
 * only compact user-scoped goals and verified outcomes.
 */
export async function buildMemoryContext(request: MemoryContextRequest): Promise<string> {
    const continuity = getSessionContinuityStore()
    continuity.backfillFromSessionLogs(
        request.principalId,
        request.legacySessionNames || [request.principalId],
    )
    if (request.observeUserTurn) {
        continuity.addTurn(request.principalId, 'user', request.query, { channel: request.channel })
    }

    const governed = getMemoryGovernanceCoordinator()
        .getContextForPrompt(request.scopes, request.query)
    const session = continuity.getSessionPrompt(request.principalId, request.query)
    const { getWorkflowEpisodeStore } = await import('./workflow-episode-store.js')
    const workflows = getWorkflowEpisodeStore().getPrompt(request.principalId, request.query)
    const [{ getGoalManager }, { getBeliefStore }] = await Promise.all([
        import('../core/goal-manager.js'), import('../core/belief-store.js'),
    ])
    const goals = getGoalManager().getPrompt(request.principalId)
    const beliefs = getBeliefStore().getPrompt(request.principalId, request.query)
    const blocks = [governed, session, workflows, goals, beliefs].filter(Boolean)
    if (blocks.length === 0) return ''
    return [
        '## Relevanter Erinnerungskontext',
        'Nutze nur diese belegten oder ausdrücklich vom Benutzer genannten Angaben. Bei Konflikten gilt der neuere kanonische Eintrag.',
        ...blocks,
    ].join('\n\n')
}
