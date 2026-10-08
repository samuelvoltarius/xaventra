import { describe, it, expect } from 'vitest'
import { isK8sShellFallback, kubernetesStatusPlan, kubernetesStatusResponse, K8S_NO_SSH_HINT } from './kubernetes-status-plan.js'

const base = {
    permission: 'owner', internal: false, hasImage: false, constrained: false,
    tools: [{ name: 'cluster_status' }, { name: 'ssh_command' }, { name: 'run_command' }],
}

describe('kubernetesStatusPlan (2.89.4)', () => {
    it.each([
        'Welche Pods laufen im Cluster?',
        'Was läuft in Kubernetes?',
        'Zeig mir den Cluster-Status',
        'Welche Pods sind auf welchem Knoten?',
        'k8s status',
    ])('%s startet mit cluster_status', content => {
        expect(kubernetesStatusPlan({ ...base, content })).toEqual([{ name: 'cluster_status', arguments: {} }])
    })

    it.each([
        'Starte worker-general neu',
        'Installiere Docker im Cluster',
        'Lösche den Pod xv-main-0',
        'Führe kubectl get pods per SSH aus',
        'Schreib ein Gedicht',
    ])('%s nicht', content => {
        expect(kubernetesStatusPlan({ ...base, content })).toBeNull()
    })

    it('nur für den Besitzer und nur mit dem Werkzeug', () => {
        expect(kubernetesStatusPlan({ ...base, content: 'Welche Pods laufen?', permission: 'guest' })).toBeNull()
        expect(kubernetesStatusPlan({ ...base, content: 'Welche Pods laufen?', tools: [{ name: 'run_command' }] })).toBeNull()
    })
})

describe('kubernetesStatusResponse — facts only from the tool result', () => {
    it('formats the API report and invents nothing else', () => {
        const text = kubernetesStatusResponse([{
            toolName: 'cluster_status', success: true,
            result: { configured: true, formatted: 'Pod xv-main-0 auf Knoten node-a — Running' },
        }])
        expect(text).toContain('xv-main-0')
        expect(text).toContain('node-a')
    })

    it('says honestly „nicht konfiguriert“ when there is no Kubernetes access', () => {
        const text = kubernetesStatusResponse([{
            name: 'cluster_status', success: true,
            result: { configured: false, message: 'Kubernetes ist nicht konfiguriert (nicht im Cluster und infra.kubernetes.server fehlt).' },
        }])
        expect(text).toMatch(/nicht konfiguriert/i)
        expect(text).not.toMatch(/ssh|kubectl/i)
    })

    it('without a verified tool result it invents no node or pod names', () => {
        expect(kubernetesStatusResponse([])).toMatch(/kein verifiziertes Status-Ergebnis/)
    })
})

describe('no SSH fallback for Kubernetes questions', () => {
    it('classifies shell/SSH as forbidden fallbacks', () => {
        expect(isK8sShellFallback('ssh_command')).toBe(true)
        expect(isK8sShellFallback('run_command')).toBe(true)
        expect(isK8sShellFallback('cluster_status')).toBe(false)
        expect(K8S_NO_SSH_HINT).toMatch(/nur aus cluster_status/)
    })
})
