/**
 * 2.89.4: Kubernetes im Gespräch („Welche Pods laufen?“, „Was ist im Cluster?“).
 *
 * Reads status, pods, events and logs through the existing narrow adapter
 * (src/infra/kubernetes.ts) — facts only from that API result. Writes stay on
 * the existing card path (/cluster). Never raw kubectl, never SSH. Without a
 * configured Kubernetes access the answer is honest: „nicht konfiguriert“.
 */
import type { NovaTool } from './complete-registry.js'
import { K8S_NO_SSH_HINT } from '../agents/kubernetes-status-plan.js'

async function requireOwner(): Promise<void> {
    const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
    const { getUserPermission } = await import('../users/multi-user-middleware.js')
    const ctx = getExecutionPolicyContext()
    if (!ctx.authUserId || getUserPermission(ctx.authUserId, ctx.channel) !== 'owner') throw new Error('Nur für den authentifizierten Owner.')
}

const OFF = /Kubernetes-Steuerung ist aus:?\s*/i

export const clusterStatusTool: NovaTool = {
    name: 'cluster_status',
    category: 'system',
    description: 'Kubernetes-Cluster lesen: Workloads, Pods mit Knoten, Warnungen/Events, Logs (Geheimnisse geschwärzt). Fakten zu Nodes und Pods kommen NUR aus diesem Werkzeug (API), nie aus SSH, kubectl oder einer Shell-Suche. Ohne konfigurierten Kubernetes-Zugang: ehrlich „nicht konfiguriert“. Neustart/Chart-Update laufen über /cluster mit Karte.',
    parameters: [
        {
            name: 'befehl', type: 'string',
            description: 'leer oder „status“ = Überblick; „events“ = Warnungen; „logs <pod> [zeilen]“; „neustart <workload>“ / „update …“ legen eine Karte an. Kein kubectl, kein SSH.',
        },
    ],
    handler: async (params) => {
        await requireOwner()
        const befehl = String(params?.befehl ?? params?.command ?? '').trim()
        if (/\b(?:ssh|kubectl|exec|shell|bash)\b/i.test(befehl)) {
            return { success: false, configured: false, error: `Das mache ich im Cluster nie. ${K8S_NO_SSH_HINT}` }
        }
        const { handleClusterCommand } = await import('../infra/kubernetes-command.js')
        const message = await handleClusterCommand(befehl)
        if (OFF.test(message)) {
            const reason = message.replace(OFF, '').replace(/\.?\s*Einrichtung:.*$/i, '').trim()
            return {
                success: true,
                configured: false,
                message: reason
                    ? `Kubernetes ist nicht konfiguriert (${reason}). Einrichtung: docs/KUBERNETES.md`
                    : 'Kubernetes ist nicht konfiguriert. Einrichtung: docs/KUBERNETES.md',
            }
        }
        return { success: !/^[❌⛔]/.test(message), configured: true, formatted: message, message }
    },
}

export const clusterTools: NovaTool[] = [clusterStatusTool]
