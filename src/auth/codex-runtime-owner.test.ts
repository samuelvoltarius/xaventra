import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Decided 30.09.2026: Codex is the owner's own subscription (L7). The CLI
// adapter enforced that, the app-server route used by nova-runner did not:
// with codex.enabled=true any logged-in principal on the node got Codex.

const dataDir = mkdtempSync(join(tmpdir(), 'codex-owner-'))
const statusReads = vi.hoisted(() => ({ count: 0 }))

vi.mock('./codex-app-server.js', async importOriginal => {
    const actual = await importOriginal<typeof import('./codex-app-server.js')>()
    return {
        ...actual,
        getLocalCodexNodeId: () => 'spark',
        readCodexStatus: vi.fn(async () => {
            statusReads.count++
            return { nodeId: 'spark', available: true, authenticated: true, authMode: 'chatgpt', planType: null, checkedAt: new Date().toISOString() }
        }),
    }
})
vi.mock('../mesh/capability-graph.js', () => ({
    getCapabilityGraph: () => ({ getSnapshot: () => ({ nodes: [] }), upsertLocalRuntime: () => undefined }),
}))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'spark' }))
vi.mock('../core/data-root.js', () => ({ getNovaDataDir: (...parts: string[]) => join(dataDir, ...parts) }))

const { createCodexRoutedClient } = await import('./codex-runtime.js')
const { runWithLlmPrincipal, setLlmPrincipalPermission } = await import('../llm/llm-principal.js')

const existingClient = { modelId: 'qwen', complete: async () => ({ content: 'lokal' }) }

async function routeAs(permission: string | undefined) {
    const fallbacks: string[] = []
    const result = await runWithLlmPrincipal(async () => {
        setLlmPrincipalPermission(permission)
        return createCodexRoutedClient({
            principalId: `${permission}-1`, runId: 'run-1', config: { enabled: true, fallbackModel: 'qwen' },
            existingClient, onFallback: reason => { fallbacks.push(reason) },
        })
    })
    return { result, fallbacks }
}

describe('Codex app-server route is owner-only', () => {
    it('does not hand Codex to a logged-in non-owner and reports why', async () => {
        for (const permission of ['user', 'admin', 'guest', undefined]) {
            statusReads.count = 0
            const { result, fallbacks } = await routeAs(permission)
            expect(result.route).not.toBe('codex')
            expect(result.route).not.toBe('codex-remote')
            expect(result.client).toBe(existingClient)
            expect(fallbacks.join(' ')).toMatch(/nur .*Owner/)
            // No per-principal Codex probe for a principal that may not use it.
            expect(statusReads.count).toBe(0)
        }
    })

    it('still routes the owner to Codex', async () => {
        const { result } = await routeAs('owner')
        expect(result.route).toBe('codex')
    })
})
