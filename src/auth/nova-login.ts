/**
 * Nova OAuth Login System
 * 
 * Implements OpenAI Codex OAuth flow for new users.
 * Creates auth.json with access + refresh tokens.
 * 
 * Supports:
 * - OpenAI OAuth (PKCE flow via auth.openai.com)
 * - OpenAI API Key
 * - Anthropic API Key
 * - xAI API Key
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { exec } from 'node:child_process'
import { loginOpenAI, type OpenAITokens } from './openai-oauth.js'

// ============================================
// Auth Storage
// ============================================

function getAuthPath(): string {
    const novaPath = join(process.cwd(), '.nova-data', 'auth.json')
    const legacyPath = join(
        process.env.USERPROFILE || process.env.HOME || '',
        '.pi', 'agent', 'auth.json'
    )
    // Use nova-data if it exists, otherwise legacy — but WRITE always to nova-data
    if (existsSync(novaPath)) return novaPath
    if (existsSync(legacyPath)) return legacyPath
    // Default: new installs write to nova-data
    return novaPath
}

function saveCredentials(provider: string, credentials: {
    access: string
    refresh: string
    expires: number
    projectId?: string
    email?: string
}): void {
    const authPath = getAuthPath()
    const dir = dirname(authPath)

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }

    let data: Record<string, any> = {}
    if (existsSync(authPath)) {
        data = JSON.parse(readFileSync(authPath, 'utf-8'))
    }

    data[provider] = {
        type: 'oauth',
        ...credentials,
    }

    writeFileSync(authPath, JSON.stringify(data, null, 2))
    console.log(`[Nova Login] ✓ Credentials gespeichert: ${authPath}`)
}

// ============================================
// OAuth Flow (OpenAI Codex)
// ============================================

interface LoginCallbacks {
    onUrl: (url: string) => void
    onProgress: (msg: string) => void
    onSuccess: (email: string) => void
    onError: (error: string) => void
}

async function loginWithOpenAIOAuth(callbacks: LoginCallbacks): Promise<void> {
    callbacks.onProgress('Starte OpenAI OAuth (PKCE)...')

    await loginOpenAI({
        onUrl: (url) => {
            callbacks.onUrl(url)
            callbacks.onProgress('Warte auf Browser-Login...')

            // Try to open browser automatically
            const openCmd = process.platform === 'win32' ? 'start'
                : process.platform === 'darwin' ? 'open' : 'xdg-open'
            exec(`${openCmd} "${url}"`)
        },
        onSuccess: (tokens: OpenAITokens) => {
            // Also save in the legacy auth.json format for L04 compatibility
            saveCredentials('openai', {
                access: tokens.access,
                refresh: tokens.refresh,
                expires: tokens.expires,
                email: tokens.accountId,
            })
            callbacks.onSuccess(tokens.accountId || 'OpenAI Auth OK')
        },
        onError: (error) => {
            callbacks.onError(error)
        },
        onStatus: (msg) => {
            callbacks.onProgress(msg)
        },
    })
}

// ============================================
// Simple API Key Login (OpenAI, Anthropic, Grok)
// ============================================

async function loginWithApiKey(
    provider: string,
    providerName: string,
    callbacks: LoginCallbacks
): Promise<void> {
    const readline = await import('node:readline')
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    callbacks.onProgress(`Bitte gib deinen ${providerName} API-Key ein:`)

    return new Promise((resolve) => {
        rl.question(`${providerName} API-Key: `, (apiKey) => {
            rl.close()

            if (!apiKey || apiKey.trim().length === 0) {
                callbacks.onError('Kein API-Key eingegeben')
                resolve()
                return
            }

            saveCredentials(provider, {
                access: apiKey.trim(),
                refresh: '',
                expires: Date.now() + 365 * 24 * 60 * 1000, // 1 year
            })

            callbacks.onSuccess(`${providerName} konfiguriert`)
            resolve()
        })
    })
}

// ============================================
// CLI Interface
// ============================================

export async function runLoginCLI(): Promise<void> {
    const provider = process.argv[2] || 'openai'

    console.log('\n✨ Nova Login System\n')
    console.log('─'.repeat(40))

    const callbacks: LoginCallbacks = {
        onUrl: (url) => {
            console.log('\n🌐 Öffne diese URL im Browser:\n')
            console.log(url)
            console.log()
        },
        onProgress: (msg) => {
            console.log(`⏳ ${msg}`)
        },
        onSuccess: (email) => {
            console.log(`\n✅ Erfolgreich: ${email}`)
            console.log('   Du kannst Nova jetzt nutzen!\n')
            process.exit(0)
        },
        onError: (error) => {
            console.error(`\n❌ Fehler: ${error}\n`)
            process.exit(1)
        },
    }

    switch (provider.toLowerCase()) {
        case 'local':
        case 'openai-oauth':
            callbacks.onError('Legacy OAuth ist deaktiviert. Starte Nova und nutze /codex login; so bleibt die Anmeldung User x Node isoliert.')
            break
            console.log('Provider: OpenAI Codex OAuth\n')
            console.log('Du wirst zu auth.openai.com weitergeleitet.\n')
            await loginWithOpenAIOAuth(callbacks)
            break

        case 'openai':
        case 'gpt':
            console.log('ChatGPT/Codex OAuth wird nur über /codex login verwaltet. Hier wird ein separater Platform API-Key hinterlegt.\n')
            await loginWithApiKey('openai', 'OpenAI', callbacks)
            break
            console.log('Provider: OpenAI\n')
            console.log('Wähle Login-Methode:')
            console.log('  1. OAuth (empfohlen — kein API-Key nötig)')
            console.log('  2. API-Key')
            console.log()

            const readline = await import('node:readline')
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            const choice = await new Promise<string>(resolve => {
                rl.question('Auswahl [1/2]: ', (answer) => {
                    rl.close()
                    resolve(answer.trim())
                })
            })

            if (choice === '2') {
                console.log('\nHole deinen API-Key von: https://platform.openai.com/api-keys\n')
                await loginWithApiKey('openai', 'OpenAI', callbacks)
            } else {
                console.log('\nStarte OAuth Login...\n')
                await loginWithOpenAIOAuth(callbacks)
            }
            break

        case 'anthropic':
        case 'claude':
            console.log('Provider: Anthropic (Claude)\n')
            console.log('Hole deinen API-Key von: https://console.anthropic.com/settings/keys\n')
            await loginWithApiKey('anthropic', 'Anthropic', callbacks)
            break

        case 'grok':
        case 'xai':
            console.log('Provider: xAI (Grok)\n')
            console.log('Hole deinen API-Key von: https://console.x.ai/\n')
            await loginWithApiKey('xai', 'xAI/Grok', callbacks)
            break

        default:
            console.log('Verfügbare Provider:')
            console.log('  - openai / gpt          (OAuth oder API Key)')
            console.log('  - openai-oauth / local   (OAuth)')
            console.log('  - anthropic / claude     (API Key)')
            console.log('  - grok / xai             (API Key)')
            console.log('')
            console.log('Beispiel: npm run nova:login openai')
            process.exit(0)
    }
}

// Run if called directly
runLoginCLI().catch(console.error)
