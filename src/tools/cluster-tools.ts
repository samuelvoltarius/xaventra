/**
 * 2.89.4: Kubernetes im Gespräch („Welche Pods laufen?“, „Was ist im Cluster?“).
 *
 * Reads status, pods, events and logs through the existing narrow adapter
 * (src/infra/kubernetes.ts) — facts only from that API result. Writes stay on
 * the existing card path (/cluster). Never raw kubectl, never SSH. Without a
 * configured Kubernetes access the answer is honest: „nicht konfiguriert“.
 *
 * 2.89.15: cluster_test_pod — pods in exactly xaventra-test only (template,
 * label managed-by=xaventra, limits, no host access). Every create needs the
 * owner's one-time code for exactly this pod (`confirm`); delete only own
 * labelled pods.
 */
import type { NovaTool } from './complete-registry.js'
import { K8S_NO_SSH_HINT } from '../agents/kubernetes-status-plan.js'
import { ownerApprovalRefusal } from './owner-approval.js'

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

/** "sh -c 'echo ok'" is ambiguous: a JSON array is taken as is, anything else is split on spaces. */
function parseKommando(raw: unknown): string[] | undefined {
    if (Array.isArray(raw)) return raw.map(String)
    const value = String(raw ?? '').trim()
    if (!value) return undefined
    if (value.startsWith('[')) {
        try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.map(String) } catch { /* fall through */ }
    }
    return value.split(/\s+/)
}

export const clusterTestPodTool: NovaTool = {
    name: 'cluster_test_pod',
    category: 'system',
    description: 'Test-Pods im Kubernetes-Namespace xaventra-test (NUR dort): liste, logs, anlegen, loeschen. Anlegen nur aus der festen Vorlage (Label managed-by=xaventra, CPU/Speicher-Limits, Laufzeitgrenze, kein hostNetwork/privileged/hostPath, kein Service-Account-Token) und nur mit dem Einmal-Code des Owners für genau diesen Pod (Parameter confirm). Löschen nur eigener gelabelter Pods. Kein anderer Namespace, keine Secrets, kein exec, kein kubectl.',
    parameters: [
        { name: 'aktion', type: 'string', description: 'liste | logs | anlegen | loeschen', required: true },
        { name: 'name', type: 'string', description: 'Pod-Name (Kleinbuchstaben, Ziffern, Bindestrich), z. B. xvt-probe' },
        { name: 'image', type: 'string', description: 'Image mit festem Tag oder Digest, z. B. docker.io/library/busybox:1.36 (kein latest)' },
        { name: 'kommando', type: 'string', description: 'optional: Kommando als JSON-Array, z. B. ["sh","-c","echo ok"]' },
        { name: 'cpu', type: 'string', description: 'optional, Standard 250m, höchstens 1000m' },
        { name: 'speicher', type: 'string', description: 'optional, Standard 128Mi, höchstens 1Gi' },
        { name: 'laufzeit_minuten', type: 'number', description: 'optional, Standard 60, höchstens 240 — danach beendet Kubernetes den Pod' },
        { name: 'zeilen', type: 'number', description: 'logs: Anzahl letzter Zeilen (Standard 100)' },
        { name: 'confirm', type: 'string', description: 'Einmal-Code des Owners aus /freigabe für genau dieses Anlegen' },
    ],
    handler: async (params) => {
        await requireOwner()
        const aktion = String(params?.aktion ?? '').trim().toLowerCase().replace('ö', 'oe')
        const name = String(params?.name ?? '').trim()
        const { runTestPodAction } = await import('../infra/kubernetes-command.js')
        let result: { ok: boolean; message: string }
        if (aktion === 'liste' || aktion === 'list' || aktion === '') result = await runTestPodAction({ art: 'liste' })
        else if (aktion === 'logs') result = await runTestPodAction({ art: 'logs', name, zeilen: Number(params?.zeilen) || undefined })
        else if (aktion === 'loeschen' || aktion === 'delete') result = await runTestPodAction({ art: 'loeschen', name })
        else if (aktion === 'anlegen' || aktion === 'create') {
            const minutes = Number(params?.laufzeit_minuten)
            result = await runTestPodAction({
                art: 'anlegen',
                input: {
                    name, image: String(params?.image ?? '').trim(), command: parseKommando(params?.kommando),
                    cpu: params?.cpu ? String(params.cpu) : undefined, memory: params?.speicher ? String(params.speicher) : undefined,
                    laufzeitSekunden: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : undefined,
                },
                approve: detail => ownerApprovalRefusal(params, 'cluster_test_pod', detail),
            })
        } else {
            return { success: false, error: `Unbekannte Aktion „${aktion.slice(0, 30)}“ (liste, logs, anlegen, loeschen).` }
        }
        return result.ok ? { success: true, message: result.message } : { success: false, error: result.message }
    },
}

export const clusterTools: NovaTool[] = [clusterStatusTool, clusterTestPodTool]
