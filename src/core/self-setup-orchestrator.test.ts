import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySelfSetupAction, isExplicitSelfSetupRequest, loadSelfSetupState, runSelfSetupResearch, runSelfSetupScan } from './self-setup-orchestrator.js'
import { researchCapability, researchResultToSetupAction } from './capability-researcher.js'

const env = {
    python: 'python',
    node: 'node',
    npm: 'npm',
    powershell: 'powershell',
}

const validation = { valid: true, errors: [], warnings: [] }

describe('SelfSetupOrchestrator', () => {
    it('preserves every runtime/model endpoint without guessing capabilities from model names', async () => {
        const now = new Date().toISOString()
        const state = await runSelfSetupScan({
            skipNetwork: true, environment: env, validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] }, config: { nodes: [] },
            capabilitySnapshot: { version: 1, updatedAt: now, nodes: [{
                id: 'worker', hostname: 'worker', status: 'online', updatedAt: now, capabilities: ['llm', 'embedding'],
                runtimes: ['custom-chat', 'another-finetune', 'embedding-only'].map((model, i) => ({
                    id: `runtime-${i}`, name: 'vLLM', type: i === 2 ? 'embeddings' : 'llm',
                    endpoint: `http://192.0.2.1:${8000 + i}`, status: 'running', models: [model],
                    capabilities: i === 2 ? ['embedding'] : ['llm'], verifiedAt: now, verificationSource: 'probe',
                })),
            }] },
        })
        expect(state.llm.localCandidates).toEqual([
            { node: 'worker', model: 'custom-chat', endpoint: 'http://192.0.2.1:8000' },
            { node: 'worker', model: 'another-finetune', endpoint: 'http://192.0.2.1:8001' },
        ])
    })
    it.each(['installed', 'expired', 'offline', 'tombstoned'])('does not treat %s canonical software or stale config as a usable LLM', async failure => {
        const now = new Date().toISOString()
        const state = await runSelfSetupScan({
            skipNetwork: true, environment: env, validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { nodes: [{ name: 'local', host: 'localhost', ollamaModels: ['old-chat'], services: { ollama: 'http://localhost:11434' } }] },
            capabilitySnapshot: { version: 1, updatedAt: now, nodes: [{
                id: 'local', hostname: 'local', host: 'localhost', updatedAt: now, capabilities: ['llm'],
                status: failure === 'offline' ? 'offline' : 'online',
                runtimes: [{ id: 'runtime', name: 'vLLM', type: 'llm', endpoint: 'http://localhost:8000',
                    status: failure === 'installed' ? 'installed' : 'running', models: ['chat'], capabilities: ['llm'],
                    verifiedAt: now, verificationSource: 'probe', expiresAt: failure === 'expired' ? now : undefined,
                }],
            }], tombstones: failure === 'tombstoned' ? [{ id: 'runtime', deletedAt: now }] : [] },
        })
        expect(state.mesh.missingCapabilities).toContain('llm')
        expect(state.llm.localCandidates).toEqual([])
    })
    it('does not turn a general improvement request into an installation scan', () => {
        expect(isExplicitSelfSetupRequest('dich noch besser udn schlauer machen')).toBe(false)
        expect(isExplicitSelfSetupRequest('Prüfe die Runtime und installiere fehlende Komponenten')).toBe(true)
    })

    it('uses live canonical vLLM capabilities even when legacy config has no nodes', async () => {
        const now = new Date().toISOString()
        const state = await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { voice: { enabled: false }, nodes: [] },
            capabilitySnapshot: {
                version: 1,
                updatedAt: now,
                nodes: [{
                    id: 'nova-spark', hostname: 'gpu-main', status: 'online',
                    capabilities: ['gpu', 'llm'], updatedAt: now,
                    runtimes: [{
                        id: 'vllm-1', name: 'vLLM', type: 'vllm',
                        endpoint: 'http://100.64.0.10:8000', status: 'running',
                        models: ['Qwen3.5-122B'], capabilities: ['llm', 'tools'],
                        verifiedAt: now, verificationSource: 'probe',
                    }],
                }],
            },
        })

        expect(state.llm.localCandidates).toContainEqual({
            node: 'nova-spark', model: 'Qwen3.5-122B', endpoint: 'http://100.64.0.10:8000',
        })
        expect(state.mesh.missingCapabilities).not.toContain('llm')
        expect(state.mesh.missingCapabilities).not.toContain('embedding')
    })

    it('queues a gated repair and requires a GPU smoke-test after execution', async () => {
        const state = await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { nodes: [] },
            gpu: {
                checkedAt: new Date().toISOString(),
                detected: true,
                vendor: 'nvidia',
                name: 'Test RTX',
                driverDetected: true,
                cudaToolkitDetected: false,
                vulkanLoaderDetected: true,
                supportedBackends: [],
                activeBackend: 'cpu',
                deviceNames: [],
                bindings: [{ backend: 'vulkan', packageName: '@node-llama-cpp/win-x64-vulkan', installed: true, version: '3.18.1' }],
                bindingVersion: '3.18.1',
                errors: { vulkan: 'binding rejected' },
                probeSkipped: false,
            },
        })

        const action = state.actions.find(item => item.id === 'local:gpu-binding-vulkan')
        expect(action?.command).toBe('npm rebuild node-llama-cpp')
        expect(action?.verification).toEqual({ kind: 'gpu_backend', backend: 'vulkan' })
        expect(state.mode).toBe('proposal')
    })

    it('does not bypass native GPU repair approval in YOLO mode', async () => {
        await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { selfSetup: { mode: 'yolo' }, nodes: [] },
            gpu: {
                checkedAt: new Date().toISOString(), detected: true, vendor: 'amd', name: 'Test Radeon',
                driverDetected: true, cudaToolkitDetected: false, vulkanLoaderDetected: true,
                supportedBackends: [], activeBackend: 'cpu', deviceNames: [], bindings: [],
                errors: { vulkan: 'binding rejected' }, probeSkipped: false,
            },
        })

        const result = await applySelfSetupAction('local:gpu-binding-vulkan', '')
        expect(result.success).toBe(false)
        expect(result.message).toContain('Freigabe fehlt')
    })

    it('keeps voice ok when ffplay is missing but fallback deps exist', async () => {
        const state = await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: {
                ok: true,
                installed: [],
                failed: [],
                skipped: ['PyAudio'],
                warnings: ['ffmpeg: kein Package-Manager verfuegbar'],
            },
            config: { voice: { enabled: true }, nodes: [] },
        })

        expect(state.voice.ok).toBe(true)
        expect(state.voice.missingRequired).toEqual([])
        expect(state.actions.some(a => a.id === 'local:ffmpeg')).toBe(true)
    })

    it('creates setup proposals without mutating xaventra.config.json', async () => {
        const configPath = join(process.cwd(), 'xaventra.config.json')
        const before = readFileSync(configPath, 'utf-8')

        const state = await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { voice: { enabled: true }, nodes: [] },
        })

        const after = readFileSync(configPath, 'utf-8')
        expect(after).toBe(before)
        expect(state.actions.some(a => a.type === 'config_patch' && a.configPath === 'voice.autoInstallDeps')).toBe(true)
    })

    it('derives mesh recommendations from actual node capabilities instead of fixed node names', async () => {
        const state = await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: {
                nodes: [
                    {
                        name: 'MacMini',
                        role: 'compute',
                        os: 'macOS',
                        services: { ollama: 'http://100.64.0.24:11434' },
                        ollamaModels: ['qwen3.5:9b', 'mxbai-embed-large:latest'],
                    },
                    {
                        name: 'Jetson',
                        role: 'edge',
                        os: 'Linux',
                        runtime: 'ollama',
                        hardware: { gpu: 'NVIDIA Jetson', ram_gb: 8 },
                        services: {},
                    },
                ],
            },
        })

        const macMini = state.mesh.nodes.find(n => n.name === 'MacMini')
        expect(macMini?.capabilities).toContain('llm')
        expect(macMini?.capabilities).toContain('embedding')
        expect(macMini?.recommendedFor).toContain('embedding')
    })

    it('marks yolo mode when explicitly configured', async () => {
        const state = await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: { selfSetup: { mode: 'yolo' }, nodes: [] },
        })

        expect(state.mode).toBe('yolo')
    })

    it('uses the real SSH host for remote research actions', async () => {
        const result = await researchCapability('embedding', {
            name: 'MacMini',
            host: 'xaventra@100.64.0.24',
            role: 'compute',
            online: true,
            hardware: { chip: 'Apple M4' },
            services: { ollama: 'http://100.64.0.24:11434' },
            ollamaModels: [],
            capabilities: ['ollama', 'metal'],
            canInstall: ['ollama:nomic-embed-text'],
            recommendedFor: ['embedding'],
        }, { skipWeb: true })

        const action = researchResultToSetupAction(result)
        expect(action.type).toBe('remote_shell')
        expect(action.command).toContain('ssh xaventra@100.64.0.24')
    })

    it('persists single-capability research actions into setup state', async () => {
        await runSelfSetupScan({
            skipNetwork: true,
            environment: env,
            validation,
            voice: { ok: true, installed: [], failed: [], skipped: [], warnings: [] },
            config: {
                nodes: [
                    {
                        name: 'MacMini',
                        host: 'xaventra@100.64.0.24',
                        role: 'compute',
                        os: 'macOS',
                        services: { ollama: 'http://100.64.0.24:11434' },
                        ollamaModels: ['qwen3.5:9b'],
                    },
                ],
            },
        })

        const researched = await runSelfSetupResearch({ capabilities: ['embedding'], skipWeb: true })
        expect(researched.actions.some(a => a.id === 'research:embedding:MacMini' && a.research)).toBe(true)

        const persisted = loadSelfSetupState()
        expect(persisted?.actions.some(a => a.id === 'research:embedding:MacMini' && a.research)).toBe(true)
    })
})
