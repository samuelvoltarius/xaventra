import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { codexPrincipalHash, getCodexHome, isCodexSideEffectItem, parseCodexStructuredResponse, type CodexPublicStatus } from './codex-app-server.js'
import { capabilityRuntimeForCodexStatus, rankCodexProbeCandidates } from './codex-runtime.js'

const originalRoot = process.env.NOVA_CODEX_AUTH_ROOT
const originalNodeOnly = process.env.NOVA_NODE_ONLY

afterEach(() => {
    if (originalRoot === undefined) delete process.env.NOVA_CODEX_AUTH_ROOT
    else process.env.NOVA_CODEX_AUTH_ROOT = originalRoot
    if (originalNodeOnly === undefined) delete process.env.NOVA_NODE_ONLY
    else process.env.NOVA_NODE_ONLY = originalNodeOnly
})

describe('Codex user x node isolation', () => {
    it('creates opaque and distinct homes per principal and node', () => {
        process.env.NOVA_CODEX_AUTH_ROOT = join(process.cwd(), '.nova-test-codex')
        const a = getCodexHome('telegram:123', 'home')
        const b = getCodexHome('telegram:456', 'home')
        const c = getCodexHome('telegram:123', 'spark')
        expect(a).not.toBe(b)
        expect(a).not.toBe(c)
        expect(a).toContain(codexPrincipalHash('telegram:123'))
        expect(a).not.toContain('telegram:123')
    })

    it('keeps Codex login state on the persistent Nova data volume for node containers', () => {
        delete process.env.NOVA_CODEX_AUTH_ROOT
        process.env.NOVA_NODE_ONLY = 'true'

        expect(getCodexHome('telegram:123', 'nova-spark'))
            .toBe(join(process.cwd(), '.nova-data', 'codex-auth', 'nova-spark', codexPrincipalHash('telegram:123')))
    })

    it('publishes only aggregate auth capability data', () => {
        const status: CodexPublicStatus = {
            nodeId: 'spark', available: true, authenticated: true,
            authMode: 'chatgpt', planType: 'pro', checkedAt: '2026-07-18T00:00:00.000Z',
        }
        const runtime = capabilityRuntimeForCodexStatus(status)
        expect(runtime.metadata).toEqual({ available: true, authenticated: true })
        expect(runtime.metadata).not.toHaveProperty('planType')
        expect(runtime.metadata).not.toHaveProperty('principalId')
        expect(runtime.metadata).not.toHaveProperty('email')
        expect(runtime.models).toEqual(['gpt-5.4'])
        expect(runtime.capabilities).toContain('authenticated')
    })

    it('actively probes fresh online mesh nodes and ignores a stale Codex alias', () => {
        const now = Date.parse('2026-07-19T19:30:00.000Z')
        const candidates = rankCodexProbeCandidates([
            {
                id: 'home-alias', hostname: 'home', status: 'online', capabilities: ['codex'],
                runtimes: [{
                    id: 'home:codex', name: 'Codex', type: 'codex', endpoint: 'local://codex', status: 'running',
                    models: ['gpt-5.6-sol'], capabilities: ['authenticated'], verifiedAt: '2026-07-19T19:00:00.000Z', verificationSource: 'probe',
                }], updatedAt: '2026-07-19T19:00:00.000Z',
            },
            {
                id: 'nova-home', hostname: 'home', status: 'online', lastHeartbeat: '2026-07-19T19:29:50.000Z',
                hardware: { gpu_vram_mb: 8192 } as any, capabilities: [], runtimes: [], updatedAt: '2026-07-19T19:29:50.000Z',
            },
            {
                id: 'nova-pi5', hostname: 'pi5', status: 'online', lastHeartbeat: '2026-07-19T19:29:55.000Z',
                hardware: { gpu_vram_mb: 0 } as any, capabilities: [], runtimes: [], updatedAt: '2026-07-19T19:29:55.000Z',
            },
        ], 'nova-spark', now)
        expect(candidates.map(node => node.id)).toEqual(['nova-home', 'nova-pi5'])
    })

    it('converts model tool plans into Nova-owned tool calls', () => {
        const response = parseCodexStructuredResponse('{"content":"","toolCalls":[{"name":"read_file","arguments":{"path":"x"}}]}')
        expect(response.toolCalls?.[0]).toMatchObject({ name: 'read_file', arguments: { path: 'x' } })
        expect(response.finishReason).toBe('tool_calls')
    })

    it('fails closed on malformed output and internal planner identity leakage', () => {
        expect(() => parseCodexStructuredResponse('Das ist keine strukturierte Antwort.'))
            .toThrow('invalid structured response')
        expect(() => parseCodexStructuredResponse(JSON.stringify({
            content: 'Du sprichst mit dem reinen Planungsmodell innerhalb von Nova. Ich plane die nächsten erlaubten Tool-Aufrufe im vorgegebenen JSON-Format.',
            toolCalls: [],
        }))).toThrow('exposed an internal role')
    })

    it('rejects direct Codex side effects but accepts model-only items', () => {
        expect(isCodexSideEffectItem({ type: 'commandExecution' })).toBe(true)
        expect(isCodexSideEffectItem({ type: 'fileChange' })).toBe(true)
        expect(isCodexSideEffectItem({ type: 'agentMessage' })).toBe(false)
        expect(isCodexSideEffectItem({ type: 'reasoning' })).toBe(false)
    })
})
