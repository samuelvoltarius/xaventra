import { describe, expect, it } from 'vitest'
import { NODE_LABEL_KEYS, detectKubernetes, formatLabelSuggestions, suggestNodeLabels } from './kubernetes-node.js'
import { detectRuntimeKind, formatNodeOverview, installPathFor, sanitizeNodeProfile, suggestionsFor, type NodeProfile } from '../core/node-profile.js'

// Paket „Kubernetes als Infrastruktur-Schicht“: in-cluster detection and node
// label suggestions. Only fixtures — no cluster, no kubectl, no real names.

const NS_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

function profile(overrides: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'worker-a', hostname: 'host-a', platform: 'linux', arch: 'x64', version: '2.88.0',
        role: 'worker', runtime: 'native', rootReadOnly: false, noNewPrivileges: false, cpus: 8, ramGB: 16,
        gpu: { name: null, backend: 'cpu', viaVllm: false }, installPath: 'package-manager', tools: ['apt'],
        selfCheck: { status: 'ok', checkedAt: '2026-10-07T10:00:00.000Z', items: [] },
        collectedAt: '2026-10-07T10:00:00.000Z', ...overrides,
    }
}

describe('In-Cluster-Erkennung', () => {
    it('is null outside a pod (no KUBERNETES_SERVICE_HOST), even with pod-like env', () => {
        expect(detectKubernetes({}, () => '')).toBeNull()
        expect(detectKubernetes({ XAVENTRA_POD_NAME: 'x-main-0', HOSTNAME: 'x-main-0' }, () => 'xaventra')).toBeNull()
    })

    it('reports pod, namespace, node, workload and role from the downward API', () => {
        const info = detectKubernetes({
            KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443',
            XAVENTRA_POD_NAME: 'xv-main-0', XAVENTRA_POD_NAMESPACE: 'xaventra', XAVENTRA_K8S_NODE_NAME: 'node-a',
            XAVENTRA_K8S_WORKLOAD: 'main', XAVENTRA_K8S_RELEASE: 'xv',
        }, () => { throw new Error('not read when env is set') })
        expect(info).toEqual({ inCluster: true, namespace: 'xaventra', pod: 'xv-main-0', node: 'node-a', workload: 'main', release: 'xv', role: 'main' })
    })

    it('falls back to the service-account namespace file and HOSTNAME, worker role from NOVA_NODE_ONLY', () => {
        const info = detectKubernetes({ KUBERNETES_SERVICE_HOST: '10.96.0.1', HOSTNAME: 'xv-worker-general-7d9f-abcde', NOVA_NODE_ONLY: 'true' },
            path => path === NS_FILE ? 'kunde-a\n' : '')
        expect(info).toMatchObject({ inCluster: true, namespace: 'kunde-a', pod: 'xv-worker-general-7d9f-abcde', node: null, workload: null, role: 'worker' })
    })

    it('drops values that are no DNS names instead of passing them on', () => {
        const info = detectKubernetes({ KUBERNETES_SERVICE_HOST: '10.96.0.1', XAVENTRA_POD_NAMESPACE: 'Bad Name; rm', XAVENTRA_POD_NAME: '../x', XAVENTRA_K8S_NODE_NAME: 'a'.repeat(300) }, () => '')
        expect(info).toMatchObject({ namespace: null, pod: null, node: null })
    })

    it('counts a pod as container even with cgroup v2 "0::/" and no /.dockerenv (containerd)', () => {
        expect(detectRuntimeKind({ platform: 'linux', dockerenv: false, cgroup: '0::/\n', systemdInvocation: false })).toBe('unknown')
        expect(detectRuntimeKind({ platform: 'linux', dockerenv: false, cgroup: '0::/\n', systemdInvocation: false, kubernetes: true })).toBe('container')
        expect(installPathFor({ runtime: 'container', rootReadOnly: true, noNewPrivileges: true, hasApt: false, isRoot: false })).toBe('image')
    })

    it('carries the pod facts through the signed profile and shows them, without SSH/systemd hints', () => {
        const raw = profile({ runtime: 'container', installPath: 'image', kubernetes: { inCluster: true, namespace: 'xaventra', pod: 'xv-main-0', node: 'node-a', workload: 'main', release: 'xv', role: 'main' } })
        const clean = sanitizeNodeProfile(JSON.parse(JSON.stringify(raw)))!
        expect(clean.kubernetes).toEqual(raw.kubernetes)
        const text = formatNodeOverview([{ nodeId: 'xv-main-0', profile: clean, local: true }])
        expect(text).toContain('Kubernetes-Pod xv-main-0 in xaventra auf Knoten node-a (main)')
        expect(suggestionsFor(clean).join(' ')).toMatch(/Kubernetes/)
        expect(text).not.toMatch(/ssh|systemd|systemctl/i)
        // An older peer without the field stays valid.
        expect(sanitizeNodeProfile(JSON.parse(JSON.stringify(profile())))!.kubernetes).toBeUndefined()
        // Hostile input is bounded to DNS names.
        expect(sanitizeNodeProfile({ ...raw, kubernetes: { inCluster: true, namespace: 'A B', pod: 'x'.repeat(400), role: 'root' } })!.kubernetes)
            .toEqual({ inCluster: true, namespace: null, pod: null, node: null, workload: null, release: null, role: null })
    })
})

describe('Node-Label-Vorschläge (nur Ausgabe, kein kubectl)', () => {
    it('uses only the xaventra.ai label convention', () => {
        expect([...NODE_LABEL_KEYS]).toEqual(['xaventra.ai/gpu', 'xaventra.ai/gpu-class', 'xaventra.ai/memory', 'xaventra.ai/desktop', 'xaventra.ai/browser', 'xaventra.ai/general'])
    })

    it('derives labels from the strength profile', () => {
        expect(suggestNodeLabels(profile({ ramGB: 128, gpu: { name: 'NVIDIA GB10', backend: 'cuda', viaVllm: true } }))).toEqual({
            'xaventra.ai/gpu': 'true', 'xaventra.ai/gpu-class': 'nvidia', 'xaventra.ai/memory': 'xlarge',
            'xaventra.ai/desktop': 'false', 'xaventra.ai/browser': 'false', 'xaventra.ai/general': 'true',
        })
        expect(suggestNodeLabels(profile({ ramGB: 4, cpus: 4, tools: ['display', 'browser'] }))).toMatchObject({
            'xaventra.ai/gpu': 'false', 'xaventra.ai/gpu-class': 'none', 'xaventra.ai/memory': 'small', 'xaventra.ai/desktop': 'true', 'xaventra.ai/browser': 'true',
        })
        expect(suggestNodeLabels(profile({ ramGB: 32, platform: 'darwin', gpu: { name: 'Apple M2', backend: 'metal', viaVllm: false }, tools: ['playwright_browsers'] })))
            .toMatchObject({ 'xaventra.ai/gpu-class': 'apple', 'xaventra.ai/memory': 'large', 'xaventra.ai/browser': 'true' })
        // A node in crit state is no general-purpose target.
        expect(suggestNodeLabels(profile({ selfCheck: { status: 'crit', checkedAt: '', items: [] } }))['xaventra.ai/general']).toBe('false')
        // vLLM uses the GPU even when the local backend reads cpu (unified memory).
        expect(suggestNodeLabels(profile({ gpu: { name: 'NVIDIA GB10', backend: 'cpu', viaVllm: true } }))['xaventra.ai/gpu']).toBe('true')
        // A detected but unused GPU (backend cpu, no vLLM) is not offered as GPU node.
        expect(suggestNodeLabels(profile({ gpu: { name: 'NVIDIA T4', backend: 'cpu', viaVllm: false } }))['xaventra.ai/gpu']).toBe('false')
    })

    it('formats a suggestion text that never contains a kubectl command', () => {
        const text = formatLabelSuggestions([
            { nodeId: 'worker-a', kubernetesNode: 'node-a', profile: profile({ ramGB: 64, gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: false } }) },
            { nodeId: 'pi', profile: profile({ arch: 'arm64', ramGB: 8 }) },
            { nodeId: 'alt', profile: null },
        ])
        expect(text).toContain('node-a')
        expect(text).toContain('xaventra.ai/gpu=true')
        expect(text).toContain('xaventra.ai/memory=medium')
        expect(text).toMatch(/alt.*kein Profil/)
        expect(text).not.toMatch(/kubectl/)
    })
})
