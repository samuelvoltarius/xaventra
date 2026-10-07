import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_CONFIG, FIXTURE_GRAPH, fixtureRegistryRows, fixtureScoutNodes } from '../test-utils/capability-truth-fixture.js'

// 2.89 Paket C: the SAME fixture is asked in every place that used to answer on its own
// (nodes, online, GPU, "kann ich?", "Fehlend", model). They must all say the same.

vi.mock('../install/software-scout.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../install/software-scout.js')>()
    return {
        ...actual,
        collectScoutNodes: async () => {
            const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
            return fixtureScoutNodes(getLocalNodeId())
        },
    }
})
vi.mock('../mesh/capability-graph.js', async importOriginal => ({
    ...await importOriginal<typeof import('../mesh/capability-graph.js')>(),
    getCapabilityGraph: () => ({ getSnapshot: () => structuredClone(FIXTURE_GRAPH), pruneStale: () => structuredClone(FIXTURE_GRAPH) }),
}))

beforeAll(async () => {
    // The registry as Supabase sync leaves it in the local mesh file.
    const { saveMeshData } = await import('../mesh/mesh-registry.js')
    saveMeshData({ nodes: fixtureRegistryRows() as any, tasks: [] })
})
beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const { resetNodeStrengthMemo } = await import('../mesh/node-strengths.js')
    resetNodeStrengthMemo()
})

describe('nodes, online and hardware: one view for every list', () => {
    it('node-strengths knows signed, registry and graph nodes with one online window', async () => {
        const { collectNodeStrengths } = await import('../mesh/node-strengths.js')
        const nodes = await collectNodeStrengths()
        const byId = new Map(nodes.map(node => [node.nodeId, node]))
        expect([...byId.keys()].sort()).toEqual(expect.arrayContaining(['gpu-box', 'old-box', 'registry-pi']))
        expect(byId.get('gpu-box')).toMatchObject({ online: true, source: 'profile' })
        expect(byId.get('registry-pi')).toMatchObject({ online: true, source: 'registry' })
        expect(byId.get('old-box')).toMatchObject({ online: false })
        expect(byId.get('registry-pi')!.skills).toContain('embedding')
        expect(byId.get('gpu-box')!.skills).toEqual(expect.arrayContaining(['llm', 'stt']))
        // A display adapter is no GPU (before: several places called it one).
        const local = nodes.find(node => node.local)!
        expect(local.gpu.name).toBeNull()
    })

    it('mesh_nodes, mesh_status and the node list tell the same online story', async () => {
        const { getToolRegistry } = await import('../tools/complete-registry.js')
        const listed = String(await getToolRegistry().get('mesh_nodes')!.handler({} as any))
        expect(listed).toContain('gpu-box')
        expect(listed).toContain('registry-pi')
        expect(listed).not.toContain('old-box')
        const { formatMeshNodes } = await import('../mesh/mesh-registry.js')
        const status = await formatMeshNodes()
        const line = (id: string) => status.split('\n').find(row => row.includes(id)) || ''
        // registry-pi: online (green) in status AND in the list; old-box: offline (red) in status AND absent from the list
        expect(status.split('\n').find(row => row.includes('*registry-pi*'))).toContain('🟢')
        expect(status.split('\n').find(row => row.includes('*old-box*'))).toContain('🔴')
        expect(line('registry-pi')).not.toContain('offline')
    })

    it('capability projection: a display adapter is no GPU, a CUDA card is', async () => {
        const { nodesFromCapabilityGraph } = await import('../mesh/capability-orchestrator.js')
        const view = nodesFromCapabilityGraph(FIXTURE_GRAPH)
        expect(view.find(node => node.name === 'gpu-box')!.hardware.gpu).toBe(true)
        const displayOnly = structuredClone(FIXTURE_GRAPH)
        displayOnly.nodes[0].hardware = { ...displayOnly.nodes[0].hardware!, gpu: 'Microsoft Basic Display Adapter', gpu_vram_mb: undefined }
        displayOnly.nodes[0].capabilities = []
        displayOnly.nodes[0].runtimes = []
        expect(nodesFromCapabilityGraph(displayOnly)[0].hardware.gpu).toBe(false)
    })

    it('hardware words: the same phrase rule everywhere', async () => {
        const { hardwarePhrase, hardwarePhraseOf, collectNodeStrengths } = await import('../mesh/node-strengths.js')
        const display = hardwarePhrase({ cpus: 8, ramGB: 32, gpu: { name: 'Microsoft Basic Display Adapter', backend: 'cpu' }, displayAdapter: 'Microsoft Basic Display Adapter' })
        expect(display).not.toMatch(/GPU Microsoft/)
        expect(display).toContain('Anzeigeadapter')
        const gpu = hardwarePhraseOf((await collectNodeStrengths()).find(node => node.nodeId === 'gpu-box')!)
        expect(gpu).toContain('GPU NVIDIA RTX 4090')
        expect(gpu).toContain('24 GB VRAM')
    })

    it('main eligibility is what the node reports, not an id list', async () => {
        const { nodeMainEligible } = await import('../mesh/node-strengths.js')
        expect(nodeMainEligible(['main-eligible'])).toBe(true)
        expect(nodeMainEligible(['worker-only', 'main-ineligible'])).toBe(false)
        expect(nodeMainEligible(['nova-workstation'])).toBe(false)
        expect(nodeMainEligible(undefined)).toBe(false)
    })
})

describe('"kann ich?" and "Fehlend": one inventory', () => {
    it('Whisper on another node is "kann" (stt); a Gmail tool without connection is "kann-nicht-verbunden"', async () => {
        const { capabilityInventory } = await import('../learning/capability-inventory.js')
        const { assessCapability } = await import('../learning/capability-learning.js')
        const base = { tools: async () => ['gmail_search'], connections: () => new Map<string, string>(), learned: () => [], toolHealth: () => [], cloud: () => [], runtime: async () => undefined }
        const inventory = await capabilityInventory(base)
        expect(inventory.mesh!.get('stt')).toContain('gpu-box')
        expect(assessCapability('Kannst du meine Sprachnachricht abschreiben?', inventory)).toMatchObject({ status: 'kann', via: expect.arrayContaining(['knoten:gpu-box']) })
        expect(assessCapability('Kannst du meine Mails lesen?', inventory)).toMatchObject({ status: 'kann-nicht-verbunden', connector: 'gmail' })
        const connected = await capabilityInventory({ ...base, connections: () => new Map([['gmail', 'verbunden']]) })
        expect(assessCapability('Kannst du meine Mails lesen?', connected).status).toBe('kann')
    })

    it('Gegenprobe: without Whisper on any node the same question is "kann-nicht"', async () => {
        const { capabilityInventory } = await import('../learning/capability-inventory.js')
        const { assessCapability } = await import('../learning/capability-learning.js')
        const inventory = await capabilityInventory({ tools: async () => [], connections: () => new Map(), learned: () => [], toolHealth: () => [], cloud: () => [], runtime: async () => undefined, strengths: async () => [] })
        expect(assessCapability('Kannst du meine Sprachnachricht abschreiben?', inventory)).toMatchObject({ status: 'kann-nicht' })
    })

    it('a registered tool that keeps failing does not count (one tool-health store)', async () => {
        const { capabilityInventory } = await import('../learning/capability-inventory.js')
        const { assessCapability } = await import('../learning/capability-learning.js')
        const failing = [{ name: 'fax_send', status: 'degraded', consecutiveFailures: 3 } as any]
        const inventory = await capabilityInventory({ tools: async () => ['fax_send'], connections: () => new Map(), learned: () => [], toolHealth: () => failing, cloud: () => [], runtime: async () => undefined })
        expect(assessCapability('Kannst du ein Fax schicken?', inventory)).toMatchObject({ status: 'kann-nicht', broken: ['fax_send'] })
    })

    it('mesh_capabilities, the orchestrator and self-setup show the same Fehlend list; embedding is only there with a real source', async () => {
        const { getMissingCapabilities } = await import('../mesh/capability-orchestrator.js')
        const orchestrator = await getMissingCapabilities()
        // registry-pi runs an embedding model -> embedding is there; vision/tts have no source
        expect(orchestrator).not.toContain('llm')
        expect(orchestrator).not.toContain('stt')
        expect(orchestrator).not.toContain('embedding')
        expect(orchestrator).toEqual(expect.arrayContaining(['vision', 'tts']))

        const { getToolRegistry } = await import('../tools/complete-registry.js')
        const tool = String(await getToolRegistry().get('mesh_capabilities')!.handler({} as any))
        expect(tool).toContain('Fehlend:')
        for (const label of ['Bilder verstehen', 'Sprachausgabe']) expect(tool).toContain(label)
        expect(tool).not.toMatch(/Fehlend:[^\n]*Spracherkennung/)

        const { runSelfSetupScan } = await import('./self-setup-orchestrator.js')
        const state = await runSelfSetupScan({
            skipNetwork: true, environment: {} as any, validation: { valid: true, warnings: [], errors: [] } as any,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { voice: { enabled: true }, vision: { enabled: true }, nodes: [] }, capabilitySnapshot: FIXTURE_GRAPH,
        })
        // self-setup asks for stt/tts only when voice is on; the same inventory decides what is missing
        expect(state.mesh.missingCapabilities).not.toContain('stt')
        expect(state.mesh.missingCapabilities).not.toContain('llm')
        expect(state.mesh.missingCapabilities).toContain('vision')
    })

    it('embedding with only the hash makeshift is listed as missing (no longer "always there")', async () => {
        const { capabilityInventory, missingCapabilities, describeMissing } = await import('../learning/capability-inventory.js')
        const inventory = await capabilityInventory({ light: true, strengths: async () => [], cloud: () => [], runtime: async () => undefined, embedding: () => 'notbehelf' })
        expect(missingCapabilities(inventory)).toContain('embedding')
        expect(describeMissing(inventory).join(' ')).toContain('nur Notbehelf')
    })
})

describe('model: one active runtime for every place', () => {
    const respond = (url: string) => new Response(JSON.stringify(String(url).endsWith('/v1/models') ? { data: [{ id: 'chat-a' }] } : {}), { status: 200 })

    it('doctor, active runtime and the self-doctor input agree for provider vllm', async () => {
        const fetchImpl = (async (url: any) => respond(String(url))) as typeof fetch
        const { describeActiveRuntime } = await import('../llm/active-runtime.js')
        const { checkProviders } = await import('../doctor/collect.js')
        const active = await describeActiveRuntime({ config: FIXTURE_CONFIG, fetchImpl, registry: null, meshRuntimes: [] })
        expect(active).toMatchObject({ provider: 'vllm', kind: 'local', reachable: true, endpoint: 'http://192.0.2.10:8000' })
        const doctor = await checkProviders(FIXTURE_CONFIG, { fetch: fetchImpl })
        expect(doctor.ok).toBe(true)
        // provider vllm used to be skipped by the doctor
        const down = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
        expect((await checkProviders(FIXTURE_CONFIG, { fetch: down })).issues.map(issue => issue.code)).toEqual(['LOCAL_LLM_UNREACHABLE'])
        expect((await describeActiveRuntime({ config: FIXTURE_CONFIG, fetchImpl: down, registry: null, meshRuntimes: [] })).reachable).toBe(false)
    })

    it('one env variable (NOVA_PROVIDER) and the config; NOVA_LLM_PROVIDER is gone', async () => {
        const { configuredProvider } = await import('../llm/active-runtime.js')
        expect(configuredProvider({ provider: 'ollama' }, { NOVA_PROVIDER: 'openai' } as any)).toEqual({ provider: 'ollama', source: 'config' })
        expect(configuredProvider({}, { NOVA_PROVIDER: 'openai' } as any)).toEqual({ provider: 'openai', source: 'env' })
        expect(configuredProvider({}, { NOVA_LLM_PROVIDER: 'openai' } as any)).toEqual({ provider: 'none', source: 'none' })
    })
})