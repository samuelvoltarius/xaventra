import type { NovaTool } from './complete-registry.js'

/**
 * 2.89: the owner's background projects (2.88 Projekte) as a read-only tool, so
 * „Was machen meine Projekte?“ also works inside a longer task and not only as
 * the pipeline's direct status answer. Lists only the caller's own projects.
 */
export const projectsStatusTool: NovaTool = {
    name: 'projekte_status',
    category: 'other',
    description: 'Zeigt den Stand der eigenen Hintergrund-Projekte (läuft, wartet auf dich, fertig). Nur lesen.',
    parameters: [],
    handler: async (params: Record<string, unknown>) => {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const principalId = String(getExecutionPolicyContext()?.userId || params.userId || '').trim()
        if (!principalId) return { success: false, error: 'Kein angemeldeter Auftraggeber — Projekte bleiben privat.' }
        const { getProjectCoordinator } = await import('../core/projects-runtime.js')
        const { formatProjectList } = await import('../core/projects.js')
        const projects = (await getProjectCoordinator()).list(principalId)
        const visible = projects.filter(project => project.status !== 'gestoppt')
        if (!visible.length) return { success: true, count: 0, output: 'Es laufen gerade keine Projekte.' }
        return { success: true, count: visible.length, output: formatProjectList(visible, Date.now()) }
    },
}
