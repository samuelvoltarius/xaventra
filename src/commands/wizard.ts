import { createInterface } from 'node:readline'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


/** Configure selected fields without erasing existing identity or mesh policy. */
export async function runSetupWizard(): Promise<void> {
    const configPath = resolveConfigPath()
    const config: Record<string, any> = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Configuration must be a JSON object')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ask = (question: string): Promise<string> => new Promise(resolve => rl.question(question, answer => resolve(answer.trim())))
    try {
        console.log('\n✨ Xaventra Setup Wizard\nKeep API keys in your local .env file.\n')
        const providers = ['local', 'openai', 'openai-codex', 'anthropic', 'ollama', 'minimax', 'qwen', 'groq', 'openrouter']
        console.log(`Available providers: ${providers.join(', ')}`)
        const previousProvider = config.provider || 'local'
        const provider = await ask(`LLM Provider [${previousProvider}]: `) || previousProvider
        if (!providers.includes(provider)) throw new Error('Unsupported provider; configuration was not changed')
        config.provider = provider
        const defaultModel = provider === previousProvider ? (config.model || 'auto') : 'auto'
        config.model = await ask(`Model [${defaultModel}]: `) || defaultModel

        if ((await ask('Configure Telegram? (y/n) [n; keep existing]: ')).toLowerCase() === 'y') {
            const token = await ask('Telegram Bot Token [blank: use existing token or TELEGRAM_BOT_TOKEN]: ')
            config.channels = { ...config.channels, telegram: { ...config.channels?.telegram, enabled: true, ...(token ? { token } : {}) } }
        }
        if ((await ask('Enable WhatsApp? (y/n) [n; keep existing]: ')).toLowerCase() === 'y') {
            config.channels = { ...config.channels, whatsapp: { ...config.channels?.whatsapp, enabled: true } }
        }
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
        console.log(`\n✅ Config saved to: ${configPath}`)
    } finally { rl.close() }
}

export default { runSetupWizard }
