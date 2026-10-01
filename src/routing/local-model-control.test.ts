import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor, type CardStoreOptions } from '../core/approval-cards.js'
import {
    VLLM_HOST_AGENT_MISSING,
    VLLM_SWITCH_RECIPE,
    createOllamaPullExecutor,
    createVllmSwitchCardExecutor,
    ensureOllamaModel,
    executeVllmSwitch,
    judgeOllamaLoad,
    nodeMemoryFromProfile,
    planVllmSwitch,
    proposeVllmSwitch,
    readVllmPlans,
    resolveProductionVllmRuntime,
    unloadOllamaModel,
    type NodeMemoryView,
    type OllamaPort,
} from './local-model-control.js'
import type { VllmHostStateView, VllmSwitchOutcome, VllmSwitchRuntime } from './vllm-switch.js'

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

describe('vLLM switch at the Spark: card with automatic way back, never without a single Ja', () => {
    beforeEach(() => unregisterCardExecutor('vllm-wechsel'))

    const HOST_STATE: VllmHostStateView = { success: true, currentTarget: 'flash', maintenance: false, modelIds: { flash: 'qwen-flash', coder: 'qwen-coder' }, switchRunning: false }

    /** Runtime whose host agent and endpoint simulate an instant, healthy switch. */
    function fakeRuntime(patch: Partial<VllmSwitchRuntime> = {}): VllmSwitchRuntime & { steps: string[] } {
        const steps: string[] = []
        let current = 'flash', marker = false, serving = 'qwen-flash', startedAt = '2026-10-01T09:00:00.000Z'
        let clock = Date.parse('2026-10-01T10:00:00Z')
        const runtime: VllmSwitchRuntime & { steps: string[] } = {
            steps, nodeId: 'spark', targets: ['flash', 'coder', 'nano'], baseUrl: 'http://spark.example.com:8000',
            host: {
                state: async () => ({ ...HOST_STATE, currentTarget: current, maintenance: marker, container: { name: 'sparkrun_x_solo', startedAt, running: true } }),
                action: async ticket => {
                    const t = ticket.payload
                    steps.push(`${t.operation}:${t.target}`)
                    if (t.operation === 'markieren') marker = true
                    if (t.operation === 'freigeben') marker = false
                    if (t.operation === 'wechseln') { current = t.target; serving = `qwen-${t.target}`; startedAt = new Date(clock).toISOString() }
                    return { success: true, launchedAt: clock }
                },
            },
            endpoint: { models: async () => [serving], chat: async () => true },
            issue: input => ({ payload: { id: 'vllm-00000000-0000-0000-0000-000000000000', ...input, nodeId: 'spark', clientId: 'main', issuedAt: clock, expiresAt: clock + 60_000 } as any, signature: 'test' }),
            busy: async () => null,
            memory: async () => vllmBusy,
            notify: () => undefined,
            now: () => clock,
            sleep: async ms => { clock += ms },
            pollMs: 1_000, switchTimeoutMs: 10_000, restoreTimeoutMs: 10_000,
            ...patch,
        }
        return runtime
    }

    it('plans only targets from the closed list, with a card naming task, target, duration and the way back', () => {
        for (const target of ['better-test', 'flash; rm -rf /', '$(reboot)', 'Coder']) {
            const refused = planVllmSwitch({ node: 'spark', taskClass: 'code', currentModel: 'flash', targetModel: target, evidence: 'x' }, opts)
            expect(refused.ok, target).toBe(false)
        }
        const result = planVllmSwitch({ node: 'spark', taskClass: 'code', currentModel: 'flash', targetModel: 'coder', estimatedMinutes: 15, evidence: 'Prüfsatz 18 % besser', baseUrl: 'http://spark.example.com:8000' }, opts)
        if (!result.ok) throw new Error(result.reason)
        expect(result.card.aktion).toEqual({ kind: 'vllm-wechsel', ref: result.plan.id })
        expect(result.card.vorschlag).toMatch(/Code/)
        expect(result.card.vorschlag).toMatch(/coder/)
        expect(result.card.vorschlag).toMatch(/~15 min ohne lokales LLM/)
        expect(result.card.vorschlag).toMatch(/Rückweg automatisch/)
        expect(result.card.buttons.map(button => button.answer)).toEqual(['ja', 'nein', 'spaeter'])
        expect(result.plan).toMatchObject({ status: 'geplant', baseUrl: 'http://spark.example.com:8000' })
        expect(VLLM_SWITCH_RECIPE.steps.map(step => step.id)).toEqual(['messen', 'sichern', 'wechseln', 'pruefen', 'rueckweg'])
        expect(VLLM_SWITCH_RECIPE.via).toBe('host-agent')
    })

    it('no card when live preconditions fail (no host agent, maintenance marker, busy LLM)', async () => {
        const input = { node: 'spark', taskClass: 'code' as const, targetModel: 'coder', evidence: 'x', baseUrl: 'http://spark.example.com:8000' }
        const missing = await proposeVllmSwitch(input, { resolveRuntime: async () => ({ refusal: VLLM_HOST_AGENT_MISSING }), cards: opts })
        expect(missing).toMatchObject({ ok: false })
        expect((missing as { reason: string }).reason).toMatch(/Host-Agent nicht eingerichtet/)
        const maintenance = fakeRuntime()
        maintenance.host = { ...maintenance.host, state: async () => ({ ...HOST_STATE, maintenance: true }) }
        expect(await proposeVllmSwitch(input, { resolveRuntime: async () => maintenance, cards: opts })).toMatchObject({ ok: false })
        expect(await proposeVllmSwitch(input, { resolveRuntime: async () => fakeRuntime({ busy: async () => 'Laufende Aufgaben brauchen das LLM: Mission' }), cards: opts })).toMatchObject({ ok: false })
        expect(listApprovalCards(opts)).toEqual([])
        const ok = await proposeVllmSwitch(input, { resolveRuntime: async () => fakeRuntime(), cards: opts })
        expect(ok).toMatchObject({ ok: true })
        expect((ok as any).plan.currentModel).toBe('flash')
    })

    it('refuses to execute without a single owner Ja bound to this plan (never "immer")', async () => {
        const runtime = fakeRuntime()
        const result = planVllmSwitch({ node: 'spark', taskClass: 'code', currentModel: 'flash', targetModel: 'coder', evidence: 'x', baseUrl: 'http://spark.example.com:8000' }, opts)
        if (!result.ok) throw new Error(result.reason)
        for (const approval of [
            { status: 'offen', ref: result.plan.id, approvedBy: 'owner:111' },
            { status: 'immer', ref: result.plan.id, approvedBy: 'owner:111' },
            { status: 'ja', ref: 'other', approvedBy: 'owner:111' },
            { status: 'ja', ref: result.plan.id, approvedBy: 'model:qwen' },
            { status: 'ja', ref: result.plan.id },
        ]) expect((await executeVllmSwitch(result.plan.id, approval, async () => runtime, opts)).ok).toBe(false)
        expect(runtime.steps).toEqual([])
    })

    it('without a configured host agent: honest refusal, no vLLM touched', async () => {
        registerCardExecutor(createVllmSwitchCardExecutor({ resolveRuntime: async () => ({ refusal: VLLM_HOST_AGENT_MISSING }), dataDir: opts.dataDir }))
        const plan = planVllmSwitch({ node: 'spark', taskClass: 'code', currentModel: 'flash', targetModel: 'coder', evidence: 'x', baseUrl: 'http://spark.example.com:8000' }, opts)
        if (!plan.ok) throw new Error(plan.reason)
        const answer = await press(plan.card.id, 'ja')
        expect(answer.message).toMatch(/Host-Agent nicht eingerichtet/)
        expect(readVllmPlans(opts).find(item => item.id === plan.plan.id)?.status).toBe('nicht-ausgefuehrt')
    })

    it('production resolver refuses honestly when the host agent is not configured', async () => {
        const saved = { ...process.env }
        try {
            for (const key of ['XAVENTRA_VLLM_TICKET_KEY_FILE', 'XAVENTRA_INSTALL_TICKET_KEY_FILE', 'XAVENTRA_HOST_AGENT_SOCKET', 'XAVENTRA_HOST_AGENT_TOKEN_FILE', 'XAVENTRA_HOST_AGENT_NODE_ID', 'XAVENTRA_HOST_AGENT_CLIENT_ID']) delete process.env[key]
            expect(await resolveProductionVllmRuntime({ id: 'v0123456789ab', node: 'spark', baseUrl: 'http://spark.example.com:8000' })).toEqual({ refusal: VLLM_HOST_AGENT_MISSING })
        } finally { process.env = saved }
    })

    it('Nein runs nothing; Ja runs the recipe through the (mocked) host agent', async () => {
        const runtime = fakeRuntime()
        const outcomes: VllmSwitchOutcome[] = []
        registerCardExecutor(createVllmSwitchCardExecutor({ resolveRuntime: async () => runtime, dataDir: opts.dataDir, onDone: outcome => outcomes.push(outcome) }))
        const no = planVllmSwitch({ node: 'spark', taskClass: 'code', currentModel: 'flash', targetModel: 'nano', evidence: 'x', baseUrl: 'http://spark.example.com:8000' }, opts)
        if (!no.ok) throw new Error(no.reason)
        await press(no.card.id, 'nein')
        expect(runtime.steps).toEqual([])
        expect(readVllmPlans(opts).find(plan => plan.id === no.plan.id)?.status).toBe('abgelehnt')
        const yes = planVllmSwitch({ node: 'spark', taskClass: 'code', currentModel: 'flash', targetModel: 'coder', evidence: 'x', baseUrl: 'http://spark.example.com:8000' }, opts)
        if (!yes.ok) throw new Error(yes.reason)
        const answer = await press(yes.card.id, 'ja')
        expect(answer.message).toMatch(/gestartet/)
        await vi.waitFor(() => expect(outcomes).toHaveLength(1))
        expect(outcomes[0].status).toBe('ausgefuehrt')
        expect(runtime.steps).toEqual(['markieren:coder', 'wechseln:coder', 'freigeben:coder'])
        await vi.waitFor(() => expect(readVllmPlans(opts).find(plan => plan.id === yes.plan.id)?.status).toBe('ausgefuehrt'))
    })
})
