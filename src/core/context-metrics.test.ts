import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contextSwitch, featureEnabled } from './context-switches.js'
import {
    formatKontext, measureModelInput, readContextMetrics, recordContextMetrics, summarizeContextMetrics,
    type ContextTurnMetrics,
} from './context-metrics.js'

const dirs: string[] = []
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'ctx-metrics-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const turn = (over: Partial<ContextTurnMetrics> = {}): ContextTurnMetrics => ({
    at: '2026-10-29T12:00:00.000Z', channel: 'telegram', mode: 'lean',
    promptRawChars: 19_854, promptSentChars: 12_000, promptCap: 12_000, capped: true, cappedBlocks: 20,
    ...over,
})

describe('2.90.0 context switches', () => {
    it('defaults: metrics on, task prompt and lagebild in shadow', () => {
        expect(contextSwitch('metrics', { env: {}, config: null })).toBe('on')
        expect(contextSwitch('taskPrompt', { env: {}, config: null })).toBe('shadow')
        expect(contextSwitch('lagebild', { env: {}, config: null })).toBe('shadow')
    })
    it('config context.* sets the mode, the environment wins', () => {
        const config = { context: { taskPrompt: 'on', metrics: 'off' } }
        expect(contextSwitch('taskPrompt', { env: {}, config })).toBe('on')
        expect(contextSwitch('metrics', { env: {}, config })).toBe('off')
        expect(contextSwitch('taskPrompt', { env: { XAVENTRA_TASK_PROMPT: 'off' }, config })).toBe('off')
        expect(contextSwitch('lagebild', { env: { XAVENTRA_LAGEBILD: 'ON' }, config })).toBe('on')
    })
    it('an unknown value falls back to the default, never to on', () => {
        expect(contextSwitch('taskPrompt', { env: { XAVENTRA_TASK_PROMPT: 'yes please' }, config: null })).toBe('shadow')
        expect(contextSwitch('metrics', { env: { XAVENTRA_CONTEXT_METRICS: 'shadow' }, config: null })).toBe('on')
    })
})

describe('2.90.0 feature switches (test pods, desktop input): on by default, each can be turned off', () => {
    it.each(['meshDesktopInput', 'k8sTestPods'] as const)('%s is on without any setting', name => {
        expect(featureEnabled(name, { env: {}, config: null })).toBe(true)
    })
    it('the environment turns them off one by one', () => {
        expect(featureEnabled('meshDesktopInput', { env: { NOVA_MESH_DESKTOP_INPUT_ENABLED: '0' }, config: null })).toBe(false)
        expect(featureEnabled('meshDesktopInput', { env: { NOVA_MESH_DESKTOP_INPUT_ENABLED: 'false' }, config: null })).toBe(false)
        expect(featureEnabled('k8sTestPods', { env: { XAVENTRA_K8S_TEST_PODS: 'off' }, config: null })).toBe(false)
        expect(featureEnabled('meshDesktopInput', { env: { XAVENTRA_K8S_TEST_PODS: 'off' }, config: null })).toBe(true)
    })
    it('the config turns them off; the environment wins', () => {
        const config = { mesh: { desktopInput: false }, infra: { kubernetes: { testPods: false } } }
        expect(featureEnabled('meshDesktopInput', { env: {}, config })).toBe(false)
        expect(featureEnabled('k8sTestPods', { env: {}, config })).toBe(false)
        expect(featureEnabled('k8sTestPods', { env: { XAVENTRA_K8S_TEST_PODS: 'on' }, config })).toBe(true)
        expect(featureEnabled('meshDesktopInput', { env: { NOVA_MESH_DESKTOP_INPUT_ENABLED: '1' }, config })).toBe(true)
    })
})

describe('2.90.0 model input measurement', () => {
    it('counts system messages, history and tool schemas separately and in total', () => {
        const stats = measureModelInput([
            { role: 'system', content: 'S'.repeat(1000) },
            { role: 'system', content: 'T'.repeat(200) },
            { role: 'user', content: 'U'.repeat(300) },
            { role: 'assistant', content: 'A'.repeat(100) },
            { role: 'user', content: [{ type: 'text', text: 'x' }] as any },
        ], [{ name: 'hass_get', description: 'd', parameters: {} }])
        expect(stats.systemMessages).toBe(2)
        expect(stats.systemChars).toBe(1200)
        expect(stats.historyMessages).toBe(3)
        expect(stats.historyChars).toBeGreaterThanOrEqual(400)
        expect(stats.toolsOffered).toBe(1)
        expect(stats.toolSchemaChars).toBeGreaterThan(20)
        expect(stats.modelInputChars).toBe(stats.systemChars + stats.historyChars + stats.toolSchemaChars)
    })
})

describe('2.90.0 context metrics file', () => {
    it('appends one JSON line per turn and reads it back', () => {
        const dir = tempDir()
        expect(recordContextMetrics(turn(), { dir })).toBe(true)
        expect(recordContextMetrics(turn({ capped: false, promptRawChars: 9_000, promptSentChars: 9_000 }), { dir })).toBe(true)
        const lines = readFileSync(join(dir, 'context-metrics.jsonl'), 'utf8').trim().split('\n')
        expect(lines).toHaveLength(2)
        expect(readContextMetrics({ dir })).toHaveLength(2)
        expect(readContextMetrics({ dir, limit: 1 })[0].promptRawChars).toBe(9_000)
    })
    it('never writes without an explicit directory in tests (side effects off)', () => {
        expect(recordContextMetrics(turn())).toBe(false)
    })
    it('the off switch stops writing', () => {
        const dir = tempDir()
        expect(recordContextMetrics(turn(), { dir, env: { XAVENTRA_CONTEXT_METRICS: 'off' } })).toBe(false)
        expect(existsSync(join(dir, 'context-metrics.jsonl'))).toBe(false)
    })
    it('rotates instead of growing without bound', () => {
        const dir = tempDir()
        for (let i = 0; i < 30; i++) recordContextMetrics(turn(), { dir, maxBytes: 2_000 })
        expect(statSync(join(dir, 'context-metrics.jsonl')).size).toBeLessThanOrEqual(2_000 + 600)
        expect(existsSync(join(dir, 'context-metrics.jsonl.1'))).toBe(true)
    })
    it('drops request text: no content field is stored', () => {
        const dir = tempDir()
        recordContextMetrics({ ...turn(), content: 'geheimer Satz' } as any, { dir })
        expect(readFileSync(join(dir, 'context-metrics.jsonl'), 'utf8')).not.toContain('geheimer Satz')
    })
})

describe('2.90.0 summary and /kontext', () => {
    const entries = [
        turn(), turn(), turn({ capped: false, promptRawChars: 8_000, promptSentChars: 8_000, cappedBlocks: 0 }),
        turn({ modelInputChars: 30_000, toolCalls: 13, selfInfoCalls: 6, taskPromptChars: 7_500, taskPromptWouldCap: false }),
    ]
    it('reports cap rate, medians and the worst self-description loop', () => {
        const summary = summarizeContextMetrics(entries)
        expect(summary.turns).toBe(4)
        expect(summary.capped).toBe(3)
        expect(summary.capRatePercent).toBe(75)
        expect(summary.medianPromptRawChars).toBe(19_854)
        expect(summary.maxSelfInfoCalls).toBe(6)
        expect(summary.taskPromptTurns).toBe(1)
        expect(summary.taskPromptWouldCap).toBe(0)
    })
    it('formats a short owner overview', () => {
        const text = formatKontext(entries)
        expect(text).toContain('4 Züge')
        expect(text).toContain('75 %')
        expect(formatKontext([])).toContain('Noch keine')
    })
})

describe('2.90.0 /kontext and /lage commands', () => {
    it('/kontext answers the owner with the measurement and the switches; a guest is refused', async () => {
        const dir = tempDir()
        const previous = process.env.NOVA_RUNTIME_ROOT
        process.env.NOVA_RUNTIME_ROOT = dir
        try {
            recordContextMetrics(turn(), { dir: join(dir, '.nova-data') })
            const { handleCommand } = await import('./slash-commands.js')
            const state: any = { tools: { getAll: () => [] }, config: {} }
            const owner = await handleCommand('kontext', '', 'o1', state, [], { permission: 'owner', channel: 'telegram', principalId: 'o1' } as any)
            expect(owner).toContain('1 Zug')
            expect(owner).toContain('Aufgaben-Prompt shadow')
            const guest = await handleCommand('kontext', '', 'g1', state, [], { permission: 'guest', channel: 'telegram', principalId: 'g1' } as any)
            expect(guest).toContain('🔒')
            expect(await handleCommand('lage', '', 'g1', state, [], { permission: 'guest', channel: 'telegram', principalId: 'g1' } as any)).toContain('🔒')
        } finally {
            if (previous === undefined) delete process.env.NOVA_RUNTIME_ROOT
            else process.env.NOVA_RUNTIME_ROOT = previous
        }
    })
})
