import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor, type CardStoreOptions } from '../core/approval-cards.js'
import {
    UNWIRED_VLLM_EXECUTOR,
    VLLM_SWITCH_RECIPE,
    createOllamaPullExecutor,
    createVllmSwitchCardExecutor,
    ensureOllamaModel,
    executeVllmSwitch,
    judgeOllamaLoad,
    nodeMemoryFromProfile,
    planVllmSwitch,
    readVllmPlans,
    unloadOllamaModel,
    type NodeMemoryView,
    type OllamaPort,
    type VllmSwitchExecutor,
} from './local-model-control.js'

// Phase 6d model control. No network: the Ollama HTTP API and the host agent
// are ports; tests pass mocks. Pulling a model and switching vLLM are always
// cards — never executed without the owner's "Ja".

const GIB = 1024 ** 3
const OWNER = '111'
const BASE = 'http://node-b.invalid:11434'
let opts: CardStoreOptions

function mockPort(present: Array<{ name: string; sizeBytes: number }>, loaded: string[] = []): OllamaPort & { calls: string[] } {
    const calls: string[] = []
    return {
        calls,
        tags: vi.fn(async () => present),
        ps: vi.fn(async () => loaded.map(name => ({ name, sizeBytes: present.find(item => item.name === name)?.sizeBytes || 0 }))),
        keepAlive: vi.fn(async (_base: string, model: string, keepAlive: string | number) => { calls.push(`keepAlive:${model}:${keepAlive}`) }),
        pull: vi.fn(async (_base: string, model: string) => { calls.push(`pull:${model}`) }),
    }
}

const roomy: NodeMemoryView = { nodeId: 'node-b', totalBytes: 64 * GIB, freeBytes: 40 * GIB, memoryStatus: 'ok', vllmNode: false }
const tight: NodeMemoryView = { nodeId: 'node-b', totalBytes: 16 * GIB, freeBytes: 6 * GIB, memoryStatus: 'ok', vllmNode: false }
const vllmBusy: NodeMemoryView = { nodeId: 'node-a', totalBytes: 128 * GIB, freeBytes: 20 * GIB, memoryStatus: 'warn', vllmNode: true }

const press = (cardId: string, answer: string) => {
    const card = listApprovalCards(opts).find(item => item.id === cardId)!
    const token = card.buttons.find(button => button.answer === answer)!.token
    return answerApprovalCard(`ac:${token}`, { userId: OWNER, ownerIds: [OWNER] }, opts)
}

beforeEach(() => {
    opts = { dataDir: mkdtempSync(join(tmpdir(), 'model-control-')), now: () => Date.parse('2026-10-01T10:00:00Z'), ledger: null }
})

describe('Ollama: load/unload special models only with enough memory', () => {
    it('loads a present model with keep_alive when the node has room', async () => {
        const port = mockPort([{ name: 'llava-test', sizeBytes: 5 * GIB }])
        const result = await ensureOllamaModel({ node: 'node-b', baseUrl: BASE, model: 'llava-test', taskClass: 'vision' }, { port, memory: roomy, cards: opts })
        expect(result.status).toBe('geladen')
        expect(port.calls).toEqual(['keepAlive:llava-test:10m'])
    })

    it('refuses to load when free memory minus model size is below the reserve', async () => {
        const port = mockPort([{ name: 'llava-test', sizeBytes: 5 * GIB }])
        const result = await ensureOllamaModel({ node: 'node-b', baseUrl: BASE, model: 'llava-test', taskClass: 'vision' }, { port, memory: tight, cards: opts })
        expect(result.status).toBe('zu-wenig-speicher')
        expect(port.calls).toEqual([])
    })

    it('never loads next to a vLLM bottleneck, and refuses with unknown memory', async () => {
        expect(judgeOllamaLoad(vllmBusy, 2 * GIB).ok).toBe(false)
        expect(judgeOllamaLoad(vllmBusy, 2 * GIB).reason).toMatch(/vLLM/)
        expect(judgeOllamaLoad({ ...vllmBusy, memoryStatus: 'ok', freeBytes: 20 * GIB }, 8 * GIB).ok).toBe(false)
        expect(judgeOllamaLoad({ ...vllmBusy, memoryStatus: 'ok', freeBytes: 60 * GIB }, 8 * GIB).ok).toBe(true)
        expect(judgeOllamaLoad(null, 1 * GIB).ok).toBe(false)
        const port = mockPort([{ name: 'llava-test', sizeBytes: 2 * GIB }])
        expect((await ensureOllamaModel({ node: 'node-a', baseUrl: BASE, model: 'llava-test', taskClass: 'vision' }, { port, memory: vllmBusy, cards: opts })).status).toBe('zu-wenig-speicher')
        expect(port.calls).toEqual([])
    })

    it('reports an already loaded model without loading again, and unloads with keep_alive 0', async () => {
        const port = mockPort([{ name: 'llava-test', sizeBytes: 5 * GIB }], ['llava-test'])
        expect((await ensureOllamaModel({ node: 'node-b', baseUrl: BASE, model: 'llava-test', taskClass: 'vision' }, { port, memory: tight, cards: opts })).status).toBe('schon-geladen')
        await unloadOllamaModel(BASE, 'llava-test', port)
        expect(port.calls).toEqual(['keepAlive:llava-test:0'])
    })

    it('derives free memory and the vLLM flag from the node profile', () => {
        const view = nodeMemoryFromProfile({
            nodeId: 'node-a', ramGB: 128, gpu: { name: 'GB10', backend: 'cpu', viaVllm: true },
            selfCheck: { status: 'ok', checkedAt: '', items: [{ id: 'memory', label: 'Arbeitsspeicher', status: 'ok', detail: '25 % frei' }] },
        } as any)
        expect(view).toMatchObject({ nodeId: 'node-a', vllmNode: true, memoryStatus: 'ok' })
        expect(view!.freeBytes).toBe(32 * GIB)
        expect(nodeMemoryFromProfile({ nodeId: 'x', ramGB: 8, gpu: { viaVllm: false }, selfCheck: { items: [] } } as any)).toBeNull()
    })
})

describe('Ollama: pulling a new model is L2 — only via card', () => {
    beforeEach(() => unregisterCardExecutor('ollama-pull'))

    it('creates a pull card instead of downloading, and pulls only after Ja', async () => {
        const port = mockPort([])
        const result = await ensureOllamaModel({ node: 'node-b', baseUrl: BASE, model: 'whisper-test:small', taskClass: 'general' }, { port, memory: roomy, cards: opts })
        expect(result.status).toBe('pull-karte')
        expect(port.calls).toEqual([])
        const card = listApprovalCards(opts).find(item => item.id === result.cardId)!
        expect(card.aktion.kind).toBe('ollama-pull')
        expect(card.buttons.map(button => button.answer)).not.toContain('immer')
        registerCardExecutor(createOllamaPullExecutor({ port, dataDir: opts.dataDir }))
        // Nein: nothing pulled.
        const second = await ensureOllamaModel({ node: 'node-b', baseUrl: BASE, model: 'other-test', taskClass: 'general' }, { port, memory: roomy, cards: opts })
        await press(second.cardId!, 'nein')
        expect(port.calls).toEqual([])
        // Ja: exactly this pull.
        const answer = await press(result.cardId!, 'ja')
        expect(answer.ok).toBe(true)
        expect(port.calls).toEqual(['pull:whisper-test:small'])
    })

    it('Gegenprobe: the same pull card is never answered twice', async () => {
        const port = mockPort([])
        registerCardExecutor(createOllamaPullExecutor({ port, dataDir: opts.dataDir }))
        const result = await ensureOllamaModel({ node: 'node-b', baseUrl: BASE, model: 'whisper-test', taskClass: 'general' }, { port, memory: roomy, cards: opts })
        const card = listApprovalCards(opts).find(item => item.id === result.cardId)!
        const token = card.buttons.find(button => button.answer === 'ja')!.token
        await answerApprovalCard(`ac:${token}`, { userId: OWNER, ownerIds: [OWNER] }, opts)
        await answerApprovalCard(`ac:${token}`, { userId: OWNER, ownerIds: [OWNER] }, opts)
        expect(port.calls).toEqual(['pull:whisper-test'])
    })
})

describe('vLLM switch at the Spark: plan + card only, executes nothing without Ja', () => {
    beforeEach(() => unregisterCardExecutor('vllm-wechsel'))

    function mockExecutor(probeOk = true): VllmSwitchExecutor & { calls: string[] } {
        const calls: string[] = []
        return {
            calls,
            snapshot: vi.fn(async () => { calls.push('snapshot'); return { model: 'current-test' } }),
            switchModel: vi.fn(async (_plan, model: string) => { calls.push(`switch:${model}`); return true }),
            probe: vi.fn(async () => { calls.push('probe'); return probeOk }),
            restore: vi.fn(async (_plan, snapshot: { model: string }) => { calls.push(`restore:${snapshot.model}`); return true }),
        }
    }

    it('plans with a card text naming task, model, duration and automatic way back', () => {
        const result = planVllmSwitch({ node: 'node-a', taskClass: 'code', currentModel: 'current-test', targetModel: 'better-test', estimatedMinutes: 7, evidence: 'Prüfsatz 18 % besser' }, opts)
        if (!result.ok) throw new Error(result.reason)
        expect(result.card.aktion).toEqual({ kind: 'vllm-wechsel', ref: result.plan.id })
        expect(result.card.vorschlag).toMatch(/Code/)
        expect(result.card.vorschlag).toMatch(/better-test/)
        expect(result.card.vorschlag).toMatch(/~7 min/)
        expect(result.card.vorschlag).toMatch(/Rückweg automatisch/)
        expect(result.plan.status).toBe('geplant')
        expect(VLLM_SWITCH_RECIPE.steps.map(step => step.id)).toEqual(['messen', 'sichern', 'wechseln', 'pruefen', 'rueckweg'])
        expect(VLLM_SWITCH_RECIPE.via).toBe('host-agent')
    })

    it('refuses to execute without an approved card', async () => {
        const executor = mockExecutor()
        const result = planVllmSwitch({ node: 'node-a', taskClass: 'code', currentModel: 'current-test', targetModel: 'better-test', estimatedMinutes: 7, evidence: 'x' }, opts)
        if (!result.ok) throw new Error(result.reason)
        const refused = await executeVllmSwitch(result.plan.id, { status: 'offen', ref: result.plan.id }, executor, opts)
        expect(refused.ok).toBe(false)
        const wrongRef = await executeVllmSwitch(result.plan.id, { status: 'ja', ref: 'other' }, executor, opts)
        expect(wrongRef.ok).toBe(false)
        expect(executor.calls).toEqual([])
    })

    it('Nein runs nothing; Ja runs the recipe through the (mocked) host agent', async () => {
        const executor = mockExecutor()
        registerCardExecutor(createVllmSwitchCardExecutor({ executor, dataDir: opts.dataDir }))
        const no = planVllmSwitch({ node: 'node-a', taskClass: 'code', currentModel: 'current-test', targetModel: 'no-test', estimatedMinutes: 5, evidence: 'x' }, opts)
        if (!no.ok) throw new Error(no.reason)
        await press(no.card.id, 'nein')
        expect(executor.calls).toEqual([])
        expect(readVllmPlans(opts).find(plan => plan.id === no.plan.id)?.status).toBe('abgelehnt')
        const yes = planVllmSwitch({ node: 'node-a', taskClass: 'code', currentModel: 'current-test', targetModel: 'better-test', estimatedMinutes: 5, evidence: 'x' }, opts)
        if (!yes.ok) throw new Error(yes.reason)
        await press(yes.card.id, 'ja')
        expect(executor.calls).toEqual(['snapshot', 'switch:better-test', 'probe'])
        expect(readVllmPlans(opts).find(plan => plan.id === yes.plan.id)?.status).toBe('ausgefuehrt')
    })

    it('rolls back automatically when the probe after the switch fails', async () => {
        const executor = mockExecutor(false)
        const plan = planVllmSwitch({ node: 'node-a', taskClass: 'code', currentModel: 'current-test', targetModel: 'bad-test', estimatedMinutes: 5, evidence: 'x' }, opts)
        if (!plan.ok) throw new Error(plan.reason)
        const result = await executeVllmSwitch(plan.plan.id, { status: 'ja', ref: plan.plan.id }, executor, opts)
        expect(result.ok).toBe(false)
        expect(executor.calls).toEqual(['snapshot', 'switch:bad-test', 'probe', 'restore:current-test'])
        expect(readVllmPlans(opts).find(item => item.id === plan.plan.id)?.status).toBe('zurueckgerollt')
    })

    it('in this build the production executor is unwired: Ja confirms the plan, touches no vLLM', async () => {
        registerCardExecutor(createVllmSwitchCardExecutor({ executor: UNWIRED_VLLM_EXECUTOR, dataDir: opts.dataDir }))
        const plan = planVllmSwitch({ node: 'node-a', taskClass: 'code', currentModel: 'current-test', targetModel: 'better-test', estimatedMinutes: 5, evidence: 'x' }, opts)
        if (!plan.ok) throw new Error(plan.reason)
        const answer = await press(plan.card.id, 'ja')
        expect(answer.message).toMatch(/nicht verdrahtet/)
        expect(readVllmPlans(opts).find(item => item.id === plan.plan.id)?.status).toBe('bestaetigt')
    })
})
