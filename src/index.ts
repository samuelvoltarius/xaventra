/**
 * Nova ✨ - Self-Learning AI Assistant
 * Entry Point
 */

import { BrutusRuntime } from './core/runtime.js'
import { BrutusConfigSchema } from './core/types.js'
import { initBuiltinCommands, setBotInfo } from './commands/builtin.js'
import { getDefaultModel } from './core/model-defaults.js'

async function main(): Promise<void> {
    console.log('✨ Nova v0.1.0')
    console.log('══════════════════════')

    // Set bot info
    setBotInfo({
        name: 'Nova',
        emoji: '✨',
        version: '0.1.0',
        provider: 'local',
        model: getDefaultModel(),
        selfLearning: true,
    })

    // Load config
    const config = BrutusConfigSchema.parse({
        name: 'Nova',
        emoji: '✨',
        provider: 'local',
        model: getDefaultModel(),
        selfLearning: true,
    })

    // Create runtime
    const runtime = new BrutusRuntime(config)

    // Initialize built-in commands
    initBuiltinCommands()

    // Start
    await runtime.start()

    // Handle shutdown
    process.on('SIGINT', async () => {
        console.log('\n[Nova] Shutting down...')
        await runtime.stop()
        process.exit(0)
    })

    console.log('\n✅ Nova initialized (no channels connected yet)')
    console.log('')
    console.log('Available modules:')
    console.log('  ✓ Auth: API Key based (OpenAI, Anthropic)')
    console.log('  ✓ LLM:  Local (Ollama/LM Studio) + OpenAI')
    console.log('  ✓ Memory: src/memory/lancedb.ts')
    console.log('  ✓ Commands: /help, /model, /factory, /alarm, /config, /memory')
    console.log('')
    console.log('Next: Connect channels (WhatsApp, Telegram)')
}

main().catch(console.error)
