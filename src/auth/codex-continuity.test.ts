import { describe, expect, it } from 'vitest'
import { decideCodexContinuityNotice, stateFromCodexProbe, type CodexContinuityState } from './codex-continuity.js'
import type { CodexContinuityProbe } from './codex-runtime.js'

function probe(overrides: Partial<CodexContinuityProbe> = {}): CodexContinuityProbe {
    return {
        available: false,
        localStatus: {
            nodeId: 'nova-spark', available: false, authenticated: false,
            authMode: null, planType: null, checkedAt: '2026-07-19T01:00:00.000Z',
        },
        knownNodeIds: ['home'],
        fallback: {
            endpoint: 'http://gpu-main:8000/v1', model: 'qwen3-coder',
            nodeId: 'nova-spark', hostname: 'gpu-main',
        },
        checkedAt: '2026-07-19T01:00:00.000Z',
        ...overrides,
    }
}

const availableState: CodexContinuityState = {
    version: 1,
    available: true,
    activeNodeId: 'home',
    lastKnownNodeId: 'home',
    fallbackFingerprint: 'nova-spark:qwen3-coder:http://gpu-main:8000/v1',
    updatedAt: '2026-07-19T00:59:00.000Z',
}

describe('Codex continuity decisions', () => {
    it('announces the failed Codex node and the verified vLLM route', () => {
        const notice = decideCodexContinuityNotice(availableState, probe())
        expect(notice?.severity).toBe('warning')
        expect(notice?.content).toContain('`home`')
        expect(notice?.content).toContain('vLLM `qwen3-coder`')
        expect(notice?.content).toContain('`gpu-main`')
        expect(notice?.content).toContain('User × Node')
    })

    it('does not repeat an unchanged outage', () => {
        const currentProbe = probe()
        const unavailable = stateFromCodexProbe(currentProbe, availableState)
        expect(decideCodexContinuityNotice(unavailable, currentProbe)).toBeNull()
    })

    it('does not repeat an outage when only the fallback alias changes', () => {
        const unavailable = stateFromCodexProbe(probe(), availableState)
        expect(decideCodexContinuityNotice(unavailable, probe({
            fallback: {
                endpoint: 'http://gpu-main:8000/v1/',
                model: 'qwen3-coder',
                nodeId: 'configured',
            },
            checkedAt: '2026-07-19T01:02:00.000Z',
        }))).toBeNull()
    })

    it('does not expose an obsolete generated node id and derives the configured endpoint host', () => {
        const notice = decideCodexContinuityNotice({
            ...availableState,
            activeNodeId: 'nova-workstation',
            lastKnownNodeId: 'nova-workstation',
        }, probe({
            knownNodeIds: [],
            fallback: {
                endpoint: 'http://gpu-main:8000/v1',
                model: 'qwen3-coder',
                nodeId: 'configured',
            },
        }))
        expect(notice?.content).not.toContain('nova-workstation')
        expect(notice?.content).not.toContain('`configured`')
        expect(notice?.content).toContain('`gpu-main`')
    })

    it('announces a principal-specific Codex recovery', () => {
        const unavailable = stateFromCodexProbe(probe(), availableState)
        const notice = decideCodexContinuityNotice(unavailable, probe({
            available: true,
            activeNodeId: 'home',
            checkedAt: '2026-07-19T01:01:00.000Z',
        }))
        expect(notice?.severity).toBe('info')
        expect(notice?.content).toContain('wieder verfügbar')
        expect(notice?.content).toContain('`home`')
    })

    it('fails closed when neither Codex nor a verified fallback exists', () => {
        const notice = decideCodexContinuityNotice(null, probe({
            fallback: null,
            knownNodeIds: [],
            localStatus: {
                nodeId: 'nova-spark', available: true, authenticated: false,
                authMode: null, planType: null, checkedAt: '2026-07-19T01:00:00.000Z',
            },
        }))
        expect(notice?.content).toContain('fail-closed')
        expect(notice?.content).toContain('/codex login')
    })
})
