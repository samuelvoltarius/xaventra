import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Usage, type Model, type ModelProvider, type ModelRequest, type ModelResponse, type StreamEvent } from '@openai/agents'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { createTaskContract } from '../core/task-contract.js'
import { IdempotencyStore } from '../core/execution-control.js'
import { NativeToolReceiptStore } from '../core/native-tool-receipts.js'
import { OpenAIAgentsBackend } from './openai-agents-backend.js'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class ToolCallingModel implements Model {
    private calls = 0

    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
        this.calls++
        return {
            usage: new Usage({ requests: 1 }),
            output: this.calls === 1
                ? [{ type: 'function_call', callId: 'call-1', name: 'echo_tool', arguments: '{"value":"ok"}', status: 'completed' } as any]
                : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Echo verified.' }] } as any],
        }
    }

    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
        throw new Error('not used')
    }
}

class ApprovalModel implements Model {
    private calls = 0
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
        this.calls++
        return {
            usage: new Usage({ requests: 1 }),
            output: this.calls === 1
                ? [{ type: 'function_call', callId: 'read-1', name: 'echo_tool', arguments: '{"value":"durable"}', status: 'completed' } as any]
                : this.calls === 2
                    ? [{ type: 'function_call', callId: 'write-1', name: 'write_gate', arguments: '{"value":"approved"}', status: 'completed' } as any]
                    : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Unexpected completion.' }] } as any],
        }
    }
    async *getStreamedResponse(): AsyncIterable<StreamEvent> { throw new Error('not used') }
}

class FinalModel implements Model {
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
        return {
            usage: new Usage({ requests: 1 }),
            output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Both verified tools completed.' }] } as any],
        }
    }
    async *getStreamedResponse(): AsyncIterable<StreamEvent> { throw new Error('not used') }
}

describe('OpenAIAgentsBackend', () => {
    it.each([{ allowed: [] }, { allowed: ['echo_tool'] }])('never advertises supplied tools beyond contract $allowed', async ({ allowed }) => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-sdk-catalog-'))
        tempDirs.push(dir)
        const seen: string[][] = []
        const model = new FinalModel()
        const original = model.getResponse.bind(model)
        model.getResponse = async request => {
            seen.push(request.tools.filter(tool => tool.type === 'function').map(tool => tool.name))
            return original(request)
        }
        const contract = createTaskContract('Say hello', { requiresTool: false, kind: 'conversation' } as any, allowed)
        const backend = new OpenAIAgentsBackend({ modelProvider: { getModel: () => model }, ledger: new OutcomeLedger(dir) })
        const inputTools = ['echo_tool', 'run_command'].map(name => ({
            name, description: name, category: 'other' as const, parameters: [],
            handler: async () => { throw new Error('No execution expected') },
        }))
        await backend.run({ contract, userId: 'test-user', channel: 'test', content: contract.goal, tools: inputTools })
        expect(seen).toEqual([allowed])
    })

    it('runs the SDK loop through Nova tool governance and local outcome evidence', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-agents-backend-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir)
        const model = new ToolCallingModel()
        const provider: ModelProvider = { getModel: () => model }
        const contract = createTaskContract(
            'Run echo tool',
            { requiresTool: true, kind: 'generic-action' },
            ['echo_tool'],
        )
        const backend = new OpenAIAgentsBackend({ modelProvider: provider, ledger, maxTurns: 4 })
        const result = await backend.run({
            contract,
            userId: 'test-user',
            channel: 'test',
            content: 'Run echo tool',
            tools: [{
                name: 'echo_tool', description: 'Returns verified echo evidence', category: 'other',
                parameters: [{ name: 'value', type: 'string', description: 'Value', required: true }],
                handler: async params => ({ success: true, output: params.value }),
            }],
        })

        expect(result.status).toBe('completed')
        expect(result.output).toContain('Echo verified')
        expect(ledger.getRun(contract.id)?.validation?.success).toBe(true)
        expect(ledger.getRun(contract.id)?.tools).toHaveLength(1)
    })

    it('rehydrates verified receipts across an SDK approval restart without repeating effects', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-agents-resume-'))
        tempDirs.push(dir)
        const ledgerDir = join(dir, 'ledger')
        const idempotencyFile = join(dir, 'idempotency.json')
        const receiptFile = join(dir, 'receipts.json')
        const effectFile = join(dir, 'effects.log')
        const contract = createTaskContract('Run both verified tools', { requiresTool: true, kind: 'generic-action' }, ['echo_tool', 'write_gate'])
        const tools = [
            {
                name: 'echo_tool', description: 'Durable read evidence', category: 'other' as const,
                parameters: [{ name: 'value', type: 'string', description: 'Value', required: true }],
                handler: async (params: Record<string, unknown>) => {
                    appendFileSync(effectFile, 'echo\n')
                    return { success: true, output: params.value }
                },
            },
            {
                name: 'write_gate', description: 'Approval-gated write evidence', category: 'other' as const,
                parameters: [{ name: 'value', type: 'string', description: 'Value', required: true }],
                handler: async (params: Record<string, unknown>) => {
                    appendFileSync(effectFile, 'write\n')
                    return { success: true, output: params.value }
                },
            },
        ]

        const firstIdempotency = new IdempotencyStore(idempotencyFile)
        const approvalModel = new ApprovalModel()
        const first = new OpenAIAgentsBackend({
            modelProvider: { getModel: () => approvalModel },
            ledger: new OutcomeLedger(ledgerDir),
            idempotencyStore: firstIdempotency,
            receiptStore: new NativeToolReceiptStore(firstIdempotency, receiptFile),
            maxTurns: 4,
        })
        const interrupted = await first.run({ contract, userId: 'owner', channel: 'test', content: contract.goal, tools })
        expect(interrupted, interrupted.error).toMatchObject({ status: 'interrupted' })
        expect(interrupted.checkpoint).toBeTruthy()
        expect(new OutcomeLedger(ledgerDir).loadCheckpoint(contract.id)?.completedIdempotencyKeys).toHaveLength(1)

        const resumedIdempotency = new IdempotencyStore(idempotencyFile)
        const resumedLedger = new OutcomeLedger(ledgerDir)
        const resumed = new OpenAIAgentsBackend({
            modelProvider: { getModel: () => new FinalModel() },
            ledger: resumedLedger,
            idempotencyStore: resumedIdempotency,
            receiptStore: new NativeToolReceiptStore(resumedIdempotency, receiptFile),
            maxTurns: 4,
        })
        const completed = await resumed.resumeWithDecision(
            { contract, userId: 'owner', channel: 'test', content: contract.goal, tools },
            interrupted.checkpoint!,
            'approve',
        )

        expect(completed.status).toBe('completed')
        expect(resumedLedger.getRun(contract.id)?.validation?.success).toBe(true)
        expect(resumedLedger.loadCheckpoint(contract.id)?.phase).toBe('completed')
        expect(readFileSync(effectFile, 'utf8').trim().split(/\r?\n/)).toEqual(['echo', 'write'])
    })

    it('fails closed when an SDK resume checkpoint claims a missing verified receipt', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-agents-missing-receipt-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(join(dir, 'ledger'))
        const contract = createTaskContract('Resume guarded tool work', { requiresTool: true, kind: 'generic-action' }, ['echo_tool'])
        ledger.start(contract, { channel: 'test', userId: 'owner', backend: 'openai-agents' })
        ledger.saveCheckpoint({
            runId: contract.id, backend: 'openai-agents', backendState: 'untrusted-state',
            phase: 'awaiting_approval', pendingActions: ['echo_tool'], completedIdempotencyKeys: ['missing-key'],
        })
        const idempotency = new IdempotencyStore(join(dir, 'idempotency.json'))
        const backend = new OpenAIAgentsBackend({
            modelProvider: { getModel: () => new FinalModel() }, ledger, idempotencyStore: idempotency,
            receiptStore: new NativeToolReceiptStore(idempotency, join(dir, 'receipts.json')),
        })
        const resumed = await backend.resume({ contract, userId: 'owner', channel: 'test', content: contract.goal }, 'untrusted-state')
        expect(resumed.status).toBe('failed')
        expect(resumed.error).toContain('missing 1 verified tool receipt')
        expect(ledger.getRun(contract.id)?.status).toBe('failed')
    })
})
