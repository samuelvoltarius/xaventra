import { describe, expect, it } from 'vitest'
import { applySystemPromptBudget, blockPriority } from './prompt-budget.js'
import { buildLagebild, formatLagebild, replaceStaticEnvironment, type LagebildDeps } from './lagebild.js'

const NOW = Date.parse('2026-10-29T12:00:00Z')

const deps = (over: Partial<LagebildDeps> = {}): LagebildDeps => ({
    now: () => NOW,
    profile: async () => ({
        nodeId: 'main-node', hostname: 'main-host', platform: 'linux', role: 'main', cpus: 8, ramGB: 32,
        gpu: { name: null, backend: 'none', viaVllm: false }, services: [],
        virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 501, pveNode: 'pve-a' },
    } as any),
    strengths: async () => ([
        { nodeId: 'main-node', local: true, online: true, version: '2.89.15', cpus: 8, ramGB: 32, skills: ['rechnen'], services: [], tools: [] },
        { nodeId: 'lab', hostname: 'lab', local: false, online: true, version: '2.89.7', cpus: 4, ramGB: 8, skills: ['rechnen'], services: [], tools: [] },
        { nodeId: 'gpu-box', hostname: 'gpu-box', local: false, online: false, version: '2.89.7', cpus: 16, ramGB: 64, skills: ['llm', 'grosse-modelle'], services: [{ type: 'llm' }], tools: [] },
    ] as any),
    proxmox: async () => ({
        ok: true, pool: 'xaventra',
        guests: [{ vmid: 610, name: 'lab', status: 'running' }, { vmid: 620, name: 'kube-a', status: 'running' }],
        free: { ramGB: 40, cores: 10, diskGB: 600 },
    }),
    kubernetes: async () => ({ configured: false, reason: 'infra.kubernetes.server fehlt' }),
    model: () => ({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', local: false }),
    ...over,
})

describe('2.90.0 Lagebild: measured self-image', () => {
    it('says where Xaventra really runs: a VM on Proxmox, not the user PC', async () => {
        const text = formatLagebild(await buildLagebild(deps()))
        expect(text).toContain('VM 501 auf Proxmox-Knoten pve-a')
        expect(text).not.toMatch(/PC des (?:Users|Nutzers)/i)
        expect(text).toContain('MiniMax-M3.1-Flash')
        expect(text).toContain('Cloud')
    })
    it('names no local vLLM unless the profile measured one', async () => {
        expect(formatLagebild(await buildLagebild(deps()))).toMatch(/kein lokales Sprachmodell/i)
        const withVllm = await buildLagebild(deps({ profile: async () => ({ ...(await deps().profile()), gpu: { name: 'GB10', backend: 'cuda', viaVllm: true } } as any) }))
        expect(formatLagebild(withVllm)).toMatch(/lokales Sprachmodell: vLLM/i)
    })
    it('lists peers with status, version and skills; the own node is not repeated', async () => {
        const text = formatLagebild(await buildLagebild(deps()))
        expect(text).toContain('lab (online, 2.89.7')
        expect(text).toContain('gpu-box (offline')
        expect(text.match(/main-node/g)?.length ?? 0).toBeLessThanOrEqual(1)
    })
    it('shows the Proxmox pool with free room and the card rule', async () => {
        const text = formatLagebild(await buildLagebild(deps()))
        expect(text).toContain('Pool xaventra')
        expect(text).toContain('610 lab')
        expect(text).toContain('620 kube-a')
        expect(text).toContain('40 GB RAM')
        expect(text).toMatch(/nur per Karte/i)
    })
    it('is honest about Kubernetes and puts what is missing into one line', async () => {
        const lage = await buildLagebild(deps())
        const text = formatLagebild(lage)
        expect(text).toContain('Kubernetes: nicht verbunden (infra.kubernetes.server fehlt)')
        expect(lage.missing).toContain('Kubernetes-Verbindung')
    })
    it('a failing source becomes "unbekannt", never a crash and never "kann nicht"', async () => {
        const lage = await buildLagebild(deps({
            proxmox: async () => { throw new Error('ECONNREFUSED') },
            strengths: async () => { throw new Error('mesh down') },
        }))
        const text = formatLagebild(lage)
        expect(text).toContain('Proxmox: unbekannt')
        expect(text).toContain('Knoten: unbekannt')
    })
    it('a host without Proxmox says so plainly', async () => {
        const lage = await buildLagebild(deps({
            profile: async () => ({ ...(await deps().profile()), virtualization: { kind: 'none' } } as any),
            proxmox: async () => ({ ok: false, reason: 'infra.proxmox nicht eingerichtet' }),
        }))
        const text = formatLagebild(lage)
        expect(text).toMatch(/direkt auf der Hardware/)
        expect(text).toContain('Proxmox: nicht eingerichtet')
    })
})

describe('2.90.0 Lagebild: prompt block', () => {
    it('is small and protected from the cap', async () => {
        const text = formatLagebild(await buildLagebild(deps()))
        expect(text.length).toBeLessThanOrEqual(1_500)
        const heading = text.trim().split('\n')[0]
        expect(heading.startsWith('## LAGEBILD')).toBe(true)
        expect(blockPriority(heading)).toBe(0)
        const prompt = `Identität${'\n\n## Hintergrund\n' + 'x'.repeat(20_000)}\n\n${text}`
        expect(applySystemPromptBudget(prompt, 12_000).prompt).toContain('VM 501 auf Proxmox-Knoten pve-a')
    })
    it('replaces the static soul environment text (B5) and keeps everything else', async () => {
        const soul = 'Identität\n\n## KRITISCHE REGELN\nr\n\n## DEINE UMGEBUNG (WICHTIG - lies das!)\nDu läufst AUF DEM PC DES USERS.\n\n## MESH NETZWERK\nmesh_deploy\n\n## NODE UPDATES (WICHTIG!)\ngit pull\n\n## HANDELN\nh'
        const block = formatLagebild(await buildLagebild(deps()))
        const result = replaceStaticEnvironment(soul, block)
        expect(result).not.toContain('PC DES USERS')
        expect(result).not.toContain('mesh_deploy')
        expect(result).not.toContain('git pull')
        expect(result).toContain('## KRITISCHE REGELN')
        expect(result).toContain('## HANDELN')
        expect(result).toContain('VM 501 auf Proxmox-Knoten pve-a')
    })
})
