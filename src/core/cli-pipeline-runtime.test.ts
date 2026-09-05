import { expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ slash: vi.fn(async (..._args: unknown[]) => 'ok'), pipeline: vi.fn(), owner: vi.fn() }))
vi.mock('./message-pipeline.js', () => ({ handleMessage: mocks.pipeline, preloadPipelineModules: async () => undefined }))
vi.mock('./slash-commands.js', () => ({ handleCommand: mocks.slash }))
vi.mock('./llm-factory.js', () => ({ createLLM: async () => ({}), availableLLMs: [] }))
vi.mock('../tools/complete-registry.js', () => ({ getToolRegistry: () => ({}) }))
vi.mock('../memory/local-memory.js', () => ({ LocalMemoryManager: class {} }))
vi.mock('../memory/vector-memory.js', () => ({ getVectorMemory: () => ({ initialize: async () => undefined }) }))
vi.mock('../learning/engine.js', () => ({ createLearningEngine: () => ({ start: async () => undefined }) }))
vi.mock('./self-setup-orchestrator.js', () => ({ runSelfSetupScan: async () => ({}) }))
vi.mock('../users/multi-user-middleware.js', () => ({ initMultiUser: () => undefined, getOrCreateUser: () => ({}), setUserPermission: mocks.owner }))

it('forwards the trusted CLI principal to slash-command authorization', async () => {
    writeFileSync('xaventra.config.json', '{}')
    const principal = { channel: 'cli', senderId: 'cli', permission: 'owner' }
    mocks.pipeline.mockImplementation(async (_channel, _from, _content, _reply, _state, handler) => handler('users', 'list', 'cli', principal))
    const { handleCliPipelineMessage } = await import('./cli-pipeline-runtime.js')
    await handleCliPipelineMessage('/users list', async () => undefined)
    expect(mocks.owner).toHaveBeenCalledWith('cli', 'owner')
    expect(mocks.slash.mock.calls[0][5]).toBe(principal)
})
