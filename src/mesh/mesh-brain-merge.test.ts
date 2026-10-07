import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import { buildSnapshot, recommendationsFor } from './mesh-brain.js'
import { skillForTask as taskToSkill } from './node-strengths.js'
import { getRecommendations, hardwareFromStrength } from './model-recommender.js'
import { deriveStrength } from './node-strengths.js'

// Mesh-Gehirn 2.88: two model recommenders and two routing tables became one.
// mesh-brain only combines node-strengths (who can what) with the one model
// catalog (model-recommender); no SSH scan, no own list, no curl|sh.

const NOW = 1_800_000_000_000
function profile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'x', hostname: 'x', platform: 'linux', arch: 'x64', version: '2.88.0', role: 'worker', runtime: 'native',
        rootReadOnly: false, noNewPrivileges: false, cpus: 8, ramGB: 32, gpu: { name: null, backend: 'cpu', viaVllm: false },
        services: [], installPath: 'none', tools: ['git'], selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '', ...over,
    }
}
const ollamaBox = deriveStrength({
    nodeId: 'ollama-box', local: false, lastSeen: NOW - 5_000,
    profile: profile({ ramGB: 32, gpu: { name: 'NVIDIA RTX', backend: 'cuda', viaVllm: false, vramGB: 16 } }),
    graphRuntimes: [{ name: 'ollama', type: 'ollama', models: ['llama2:7b'], available: true }],
}, NOW)
const plainBox = deriveStrength({ nodeId: 'plain-box', local: true, profile: profile({ ramGB: 8, cpus: 4 }) }, NOW)

describe('one recommender, one routing source', () => {
    it('maps the strength profile to the catalog hardware view', () => {
        expect(hardwareFromStrength(ollamaBox)).toMatchObject({ ramGb: 32, vramGb: 16, hasGpu: true, gpuType: 'cuda' })
        const unified = deriveStrength({ nodeId: 'u', local: true, profile: profile({ ramGB: 128, gpu: { name: 'NVIDIA GB10', backend: 'cpu', viaVllm: true } }) }, NOW)
        expect(hardwareFromStrength(unified)).toMatchObject({ vramGb: 128, hasGpu: true, gpuType: 'cuda' })
    })

    it('recommends from the catalog only where a model runtime runs, and flags old models', () => {
        const advice = recommendationsFor(ollamaBox)
        const catalog = getRecommendations('ollama-box', hardwareFromStrength(ollamaBox), ['llama2:7b'])
        expect(advice.recommendations.map(rec => rec.tool)).toEqual(catalog.toInstall.slice(0, 3))
        expect(advice.recommendations.every(rec => !rec.installCmd || rec.installCmd.startsWith('ollama pull '))).toBe(true)
        expect(advice.deprecated).toEqual(['llama2:7b'])
        expect(recommendationsFor(plainBox).recommendations).toEqual([])
    })

    it('builds the routing table from rankNodes with short reasons', () => {
        const snap = buildSnapshot([ollamaBox, plainBox], NOW)
        const llm = snap.routingTable.find(entry => entry.task === 'llm')!
        expect(llm.bestNode).toBe('ollama-box')
        expect(llm.reason).toBe('ollama-box: GPU NVIDIA RTX, Modell llama2:7b geladen')
        expect(snap.summary.split('\n')[0]).toBe('*Was kann welcher Knoten?*')
        expect(snap.summary).toContain('veraltet llama2:7b')
    })

    it('keeps the old task names of mesh_route working', () => {
        expect(taskToSkill('large-llm')).toBe('grosse-modelle')
        expect(taskToSkill('image-generation')).toBe('bilder')
        expect(taskToSkill('bilder')).toBe('bilder')
        expect(taskToSkill('unbekannt')).toBeNull()
    })

    it('has no SSH scan, no Tailscale call and no curl|sh install command any more', () => {
        const source = readFileSync(new URL('./mesh-brain.ts', import.meta.url), 'utf8')
        expect(source).not.toMatch(/tailscale status|NodeIntelligence|child_process|curl -fsSL|\| sh/)
    })
})
