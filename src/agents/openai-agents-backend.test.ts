import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Usage, type Model, type ModelProvider, type ModelRequest, type ModelResponse, type StreamEvent } from '@openai/agents'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { createTaskContract } from '../core/task-contract.js'
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

describe('OpenAIAgentsBackend', () => {
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
})
