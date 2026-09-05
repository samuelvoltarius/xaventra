#!/usr/bin/env node
/**
 * Nova - Interactive Setup CLI
 * 
 * Guides user through:
 * 1. LLM Provider setup (API keys)
 * 2. Channel setup (WhatsApp QR, Telegram token, etc.)
 * 3. Config file generation
 */

import { createInterface } from 'node:readline'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDefaultModel } from './core/model-defaults.js'

// ============================================
// Types
// ============================================

interface SetupConfig {
    name: string
    provider: string
    model: string
    auth: {
        openaiApiKey?: string
        anthropicApiKey?: string
        openaiApiKey?: string
        qwenApiKey?: string
    }
    channels: {
        whatsapp?: { enabled: boolean; authPath: string }
        telegram?: { enabled: boolean; token: string }
        discord?: { enabled: boolean; token: string }
    }
    dashboard: {
        enabled: boolean
        port: number
    }
    metrics: {
        enabled: boolean
        port: number
    }
}

// ============================================
// ANSI Colors
// ============================================

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    red: '\x1b[31m',
}

const c = colors

// ============================================
// Readline Helper
// ============================================

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
})

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim())
        })
    })
}

function askSecret(question: string): Promise<string> {
    return new Promise((resolve) => {
        process.stdout.write(question)

        const stdin = process.stdin
        const wasRaw = stdin.isRaw

        if (stdin.isTTY) {
            stdin.setRawMode(true)
        }

        let input = ''

        const onData = (char: Buffer) => {
            const c = char.toString()

            if (c === '\n' || c === '\r') {
                stdin.removeListener('data', onData)
                if (stdin.isTTY) {
                    stdin.setRawMode(wasRaw ?? false)
                }
                process.stdout.write('\n')
                resolve(input)
            } else if (c === '\u0003') {
                // Ctrl+C
                process.exit()
            } else if (c === '\u007F') {
                // Backspace
                if (input.length > 0) {
                    input = input.slice(0, -1)
                    process.stdout.write('\b \b')
                }
            } else {
                input += c
                process.stdout.write('*')
            }
        }

        stdin.on('data', onData)
    })
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]'
    const answer = await ask(`${question} ${suffix}: `)

    if (answer === '') return defaultYes
    return answer.toLowerCase().startsWith('y')
}

async function select(question: string, options: string[]): Promise<string> {
    console.log(`\n${question}`)
    options.forEach((opt, i) => {
        console.log(`  ${c.cyan}${i + 1}${c.reset}) ${opt}`)
    })

    while (true) {
        const answer = await ask(`${c.dim}Auswahl (1-${options.length}):${c.reset} `)
        const num = parseInt(answer, 10)

        if (num >= 1 && num <= options.length) {
            return options[num - 1]
        }
        console.log(`${c.red}Bitte 1-${options.length} eingeben${c.reset}`)
    }
}

// ============================================
// Setup Steps
// ============================================

async function setupLLMProvider(): Promise<Partial<SetupConfig>> {
    console.log(`\n${c.bright}${c.magenta}═══ LLM Provider Setup ═══${c.reset}\n`)

    const provider = await select('Welchen LLM Provider möchtest du nutzen?', [
        'OpenAI (GPT-5.4, o3)',
        'Anthropic (Claude 3.5)',
        'OpenAI',
        'Alibaba Qwen',
        'Ollama (Lokal)',
    ])

    const config: Partial<SetupConfig> = {
        auth: {},
    }

    if (provider.includes('OpenAI')) {
        config.provider = 'openai'
        config.model = 'auto'

        console.log(`\n${c.dim}OpenAI API Key findest du unter: https://platform.openai.com/api-keys${c.reset}`)
        const key = await askSecret(`${c.cyan}OpenAI API Key:${c.reset} `)

        if (key) {
            config.auth!.openaiApiKey = key
            console.log(`${c.green}✓ OpenAI konfiguriert${c.reset}`)
        }
    } else if (provider.includes('Anthropic')) {
        config.provider = 'anthropic'
        config.model = 'claude-sonnet-4-5'

        console.log(`\n${c.dim}Anthropic API Key: https://console.anthropic.com/settings/keys${c.reset}`)
        const key = await askSecret(`${c.cyan}Anthropic API Key:${c.reset} `)

        if (key) {
            config.auth!.anthropicApiKey = key
            console.log(`${c.green}✓ Anthropic konfiguriert${c.reset}`)
        }
    } else if (provider.includes('OpenAI')) {
        config.provider = 'openai'
        config.model = 'auto'

        console.log(`\n${c.dim}OpenAI API Key findest du unter: https://platform.openai.com/api-keys${c.reset}`)
        const key = await askSecret(`${c.cyan}OpenAI API Key:${c.reset} `)

        if (key) {
            config.auth!.openaiApiKey = key
            console.log(`${c.green}✓ OpenAI konfiguriert${c.reset}`)
        }
    } else if (provider.includes('Qwen')) {
        config.provider = 'qwen'
        config.model = 'qwen-max'

        console.log(`\n${c.dim}Qwen API Key: https://dashscope.console.aliyun.com/apiKey${c.reset}`)
        const key = await askSecret(`${c.cyan}Qwen API Key:${c.reset} `)

        if (key) {
            config.auth!.qwenApiKey = key
            console.log(`${c.green}✓ Qwen konfiguriert${c.reset}`)
        }
    } else if (provider.includes('Ollama')) {
        config.provider = 'ollama'
        config.model = 'llama3'
        console.log(`${c.green}✓ Ollama konfiguriert (localhost:11434)${c.reset}`)
    }

    return config
}

async function setupChannels(): Promise<Partial<SetupConfig>> {
    console.log(`\n${c.bright}${c.magenta}═══ Channel Setup ═══${c.reset}\n`)

    const config: Partial<SetupConfig> = {
        channels: {},
    }

    // WhatsApp
    if (await confirm('WhatsApp aktivieren?')) {
        console.log(`\n${c.yellow}📱 WhatsApp Setup${c.reset}`)
        console.log(`${c.dim}Beim ersten Start wird ein QR-Code angezeigt.`)
        console.log(`Scanne ihn mit WhatsApp > Verknüpfte Geräte > Gerät verknüpfen${c.reset}`)

        const authPath = '.nova-whatsapp-auth'
        if (!existsSync(authPath)) {
            mkdirSync(authPath, { recursive: true })
        }

        config.channels!.whatsapp = {
            enabled: true,
            authPath,
        }
        console.log(`${c.green}✓ WhatsApp aktiviert${c.reset}`)
    }

    // Telegram
    if (await confirm('Telegram aktivieren?')) {
        console.log(`\n${c.yellow}🤖 Telegram Setup${c.reset}`)
        console.log(`${c.dim}Token von @BotFather: /newbot${c.reset}`)

        const token = await askSecret(`${c.cyan}Bot Token:${c.reset} `)

        if (token) {
            config.channels!.telegram = {
                enabled: true,
                token,
            }
            console.log(`${c.green}✓ Telegram konfiguriert${c.reset}`)
        }
    }

    // Discord
    if (await confirm('Discord aktivieren?', false)) {
        console.log(`\n${c.yellow}🎮 Discord Setup${c.reset}`)
        console.log(`${c.dim}Token: https://discord.com/developers/applications${c.reset}`)

        const token = await askSecret(`${c.cyan}Bot Token:${c.reset} `)

        if (token) {
            config.channels!.discord = {
                enabled: true,
                token,
            }
            console.log(`${c.green}✓ Discord konfiguriert${c.reset}`)
        }
    }

    return config
}

async function setupInfra(): Promise<Partial<SetupConfig>> {
    console.log(`\n${c.bright}${c.magenta}═══ Infrastruktur ═══${c.reset}\n`)

    const config: Partial<SetupConfig> = {
        dashboard: { enabled: true, port: 3000 },
        metrics: { enabled: true, port: 9090 },
    }

    if (await confirm('Dashboard aktivieren?')) {
        const portStr = await ask(`${c.cyan}Dashboard Port${c.reset} [3000]: `)
        config.dashboard!.port = portStr ? parseInt(portStr, 10) : 3000
        console.log(`${c.green}✓ Dashboard auf Port ${config.dashboard!.port}${c.reset}`)
    } else {
        config.dashboard!.enabled = false
    }

    if (await confirm('Prometheus Metrics aktivieren?')) {
        const portStr = await ask(`${c.cyan}Metrics Port${c.reset} [9090]: `)
        config.metrics!.port = portStr ? parseInt(portStr, 10) : 9090
        console.log(`${c.green}✓ Metrics auf Port ${config.metrics!.port}${c.reset}`)
    } else {
        config.metrics!.enabled = false
    }

    return config
}

// ============================================
// Main Setup
// ============================================

export async function runSetup(): Promise<void> {
    console.clear()
    console.log(`
${c.bright}${c.magenta}
    ╔═══════════════════════════════════════╗
    ║                                       ║
    ║     ✨  Nova Setup Wizard  ✨         ║
    ║                                       ║
    ╚═══════════════════════════════════════╝
${c.reset}
${c.dim}Dieser Wizard führt dich durch die Konfiguration.${c.reset}
`)

    // Check for existing config
    const configPath = join(process.cwd(), 'nova.config.json')
    if (existsSync(configPath)) {
        const overwrite = await confirm(`${c.yellow}nova.config.json existiert bereits. Überschreiben?${c.reset}`, false)
        if (!overwrite) {
            console.log(`\n${c.dim}Setup abgebrochen.${c.reset}`)
            rl.close()
            return
        }
    }

    // Bot Name
    const name = await ask(`${c.cyan}Bot Name${c.reset} [Nova]: `) || 'Nova'

    // LLM Provider
    const llmConfig = await setupLLMProvider()

    // Channels
    const channelConfig = await setupChannels()

    // Infrastructure
    const infraConfig = await setupInfra()

    // Merge configs
    const finalConfig: SetupConfig = {
        name,
        provider: llmConfig.provider || 'openai',
        model: llmConfig.model || getDefaultModel(),
        auth: llmConfig.auth || {},
        channels: channelConfig.channels || {},
        dashboard: infraConfig.dashboard || { enabled: true, port: 3000 },
        metrics: infraConfig.metrics || { enabled: true, port: 9090 },
    }

    // Write config
    console.log(`\n${c.bright}${c.magenta}═══ Konfiguration speichern ═══${c.reset}\n`)
    console.log(`${c.dim}${JSON.stringify(finalConfig, null, 2)}${c.reset}`)

    if (await confirm('\nKonfiguration speichern?')) {
        writeFileSync(configPath, JSON.stringify(finalConfig, null, 2))
        console.log(`\n${c.green}✓ nova.config.json gespeichert${c.reset}`)

        console.log(`
${c.bright}${c.green}
    ╔═══════════════════════════════════════╗
    ║                                       ║
    ║      ✨  Setup abgeschlossen!  ✨     ║
    ║                                       ║
    ╚═══════════════════════════════════════╝
${c.reset}
${c.cyan}Nächste Schritte:${c.reset}

  1. Nova starten:
     ${c.bright}npm run dev${c.reset}

  2. Dashboard starten (separates Terminal):
     ${c.bright}npm run dashboard:dev${c.reset}

  3. Bei WhatsApp: QR-Code mit dem Handy scannen

${c.dim}Viel Spaß mit Nova! ✨${c.reset}
`)
    } else {
        console.log(`\n${c.yellow}Konfiguration nicht gespeichert.${c.reset}`)
    }

    rl.close()
}

// ============================================
// Run if called directly
// ============================================

if (import.meta.url === `file://${process.argv[1]}`) {
    runSetup().catch(console.error)
}

export default { runSetup }
