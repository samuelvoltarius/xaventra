/**
 * CLI Pipeline Runtime
 *
 * Boots the same unified message pipeline used by Telegram and the dashboard,
 * without starting long-running channels or the daemon process.
 */

import 'dotenv/config'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initNovaState, getNovaState } from './nova-state.js'
import { handleMessage as pipelineHandleMessage, preloadPipelineModules } from './message-pipeline.js'
import { handleCommand as handleSlashCommand } from './slash-commands.js'
import { createLLM, availableLLMs } from './llm-factory.js'
import type { DaemonState } from './message-pipeline.js'

let runtimeState: DaemonState | null = null

function readConfig(): Record<string, any> {
    const configPath = join(process.cwd(), 'nova.config.json')
    if (!existsSync(configPath)) {
        throw new Error('nova.config.json nicht gefunden')
    }
    return JSON.parse(readFileSync(configPath, 'utf-8'))
}

async function createPipelineMemory(): Promise<any> {
    try {
        const { LocalMemoryManager } = await import('../memory/local-memory.js')
        const { getVectorMemory } = await import('../memory/vector-memory.js')

        const localMemory = new LocalMemoryManager({
            dbPath: join(process.cwd(), '.nova-memory'),
            maxEntriesPerUser: 500,
        })
        const vectorMemory = getVectorMemory({
            dataDir: join(process.cwd(), '.nova-vector-memory'),
            maxEntriesPerUser: 1000,
            similarityThreshold: 0.3,
        })
        await vectorMemory.initialize()

        return {
            recall: async (query: string, userId: string, limit: number) => {
                const vectorResults = await vectorMemory.recall(query, userId, limit)
                const localResults = await localMemory.recall(query, userId, limit)
                const seen = new Set<string>()
                const combined = []
                for (const r of [...vectorResults, ...localResults]) {
                    const item: any = r
                    const key = String(item.content || item.entry?.content || '').slice(0, 80)
                    if (!seen.has(key)) {
                        seen.add(key)
                        combined.push(r)
                    }
                }
                return combined.slice(0, limit)
            },
            store: async (entry: any) => {
                await localMemory.store(entry)
                await vectorMemory.store(entry)
            },
            getStats: () => ({
                ...localMemory.getStats(),
                vectorStats: vectorMemory.getStats(),
            }),
        }
    } catch (err) {
        console.warn(`[CLI] Memory nicht verfügbar: ${err}`)
        return null
    }
}

export async function initCliPipelineRuntime(): Promise<DaemonState> {
    if (runtimeState) return runtimeState

    const config = readConfig()
    const state: DaemonState = {
        running: true,
        channels: { telegram: null, whatsapp: null, discord: null },
        llm: null,
        internalLlm: null,
        memory: null,
        learning: null,
        tools: null,
        resilience: null,
        startTime: Date.now(),
        config,
    }

    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'))
        ;(state as any).version = pkg.version || '0.0.0'
        getNovaState().version = (state as any).version
    } catch { /* non-critical */ }

    state.llm = await createLLM(config)
    state.internalLlm = state.llm

    const { getToolRegistry } = await import('../tools/complete-registry.js')
    state.tools = getToolRegistry()

    state.memory = await createPipelineMemory()

    try {
        const { createLearningEngine } = await import('../learning/engine.js')
        const learning = createLearningEngine({ dataDir: join(process.cwd(), '.nova-learning') })
        await learning.start()
        state.learning = learning
    } catch (err) {
        console.warn(`[CLI] LearningEngine nicht verfügbar: ${err}`)
    }

    try {
        const { initMultiUser, getOrCreateUser, setUserPermission } = await import('../users/multi-user-middleware.js')
        initMultiUser()
        getOrCreateUser('cli', 'cli', 'CLI')
        setUserPermission('cli', 'owner')
    } catch (err) {
        console.warn(`[CLI] MultiUser init übersprungen: ${err}`)
    }

    try {
        const { runSelfSetupScan } = await import('./self-setup-orchestrator.js')
        const setup = await runSelfSetupScan()
        ;(state as any).selfSetup = setup
    } catch (err) {
        console.warn(`[CLI] Self-Setup Scan übersprungen: ${err}`)
    }

    initNovaState(state as any)
    preloadPipelineModules().catch(() => {})

    runtimeState = state
    return state
}

export async function handleCliPipelineMessage(
    content: string,
    replyFn: (msg: string) => Promise<void>,
): Promise<void> {
    const state = await initCliPipelineRuntime()
    await pipelineHandleMessage(
        'cli',
        'cli',
        content,
        replyFn,
        state,
        (cmd, args, from) => handleSlashCommand(cmd, args, from, state, availableLLMs),
    )
}
