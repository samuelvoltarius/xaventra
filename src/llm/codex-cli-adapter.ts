/**
 * Nova - Codex CLI Adapter
 * 
 * Uses the OpenAI Codex CLI binary as an LLM backend proxy.
 * The Codex CLI handles all the complex ChatGPT OAuth/Responses API/Cloudflare
 * internals and provides a clean JSONL interface via `codex exec --json`.
 * 
 * This allows Nova to use ChatGPT subscription models (gpt-5.3-codex, gpt-5.4, etc.)
 * without needing Platform API credits.
 */

import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ============================================
// Types
// ============================================

export interface CodexExecEvent {
    type: string
    thread_id?: string
    item?: {
        id: string
        type: string
        text?: string
    }
    usage?: {
        input_tokens: number
        cached_input_tokens?: number
        output_tokens: number
    }
}

export interface CodexCompletionResult {
    content: string
    model: string
    tokensUsed?: number
    inputTokens?: number
    outputTokens?: number
}

// ============================================
// Codex CLI Discovery
// ============================================

const KNOWN_CODEX_PATHS = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(process.env.USERPROFILE || process.env.HOME || '', '.codex-plusplus', 'source', 'packages', 'cli', 'bin', 'codex.js'),
    join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
    join(process.env.APPDATA || '', 'npm', 'codex'),
    '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
]

let _codexBinaryPath: string | null = null

export function resetCodexBinaryCacheForTests(): void {
    _codexBinaryPath = null
}

export function findCodexBinary(): string | null {
    if (_codexBinaryPath) return _codexBinaryPath

    const dataRoot = process.env.NOVA_DATA_DIR?.trim() || join(process.cwd(), '.nova-data')
    const managedCandidates = [
        process.env.NOVA_CODEX_BIN?.trim(),
        join(process.env.NOVA_CODEX_RUNTIME_ROOT?.trim() || join(dataRoot, 'codex-runtime'), 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    ].filter(Boolean) as string[]
    for (const candidate of managedCandidates) {
        if (existsSync(candidate)) {
            _codexBinaryPath = candidate
            return _codexBinaryPath
        }
    }

    // Prefer a direct Node entrypoint. Windows package-manager shims and App
    // Execution Aliases may be discoverable but unusable by daemon spawn().
    for (const p of KNOWN_CODEX_PATHS.filter(candidate => candidate.endsWith('.js'))) {
        if (existsSync(p)) {
            _codexBinaryPath = p
            return _codexBinaryPath
        }
    }

    // Try PATH first
    try {
        const lookup = process.platform === 'win32' ? 'where codex 2>nul' : 'which codex 2>/dev/null'
        const which = execSync(lookup, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]
        if (which) {
            _codexBinaryPath = which
            return _codexBinaryPath
        }
    } catch { /* not in PATH */ }

    // Try known paths
    for (const p of KNOWN_CODEX_PATHS) {
        if (existsSync(p)) {
            _codexBinaryPath = p
            return _codexBinaryPath
        }
    }

    // Find via npm global
    try {
        const npmRoot = execSync('npm root -g 2>/dev/null', { encoding: 'utf-8' }).trim()
        const candidates = [
            join(npmRoot, '@openai/codex/bin/codex'),
            join(npmRoot, '@openai/codex/bin/codex.js'),
        ]
        for (const npmCodex of candidates) {
            if (existsSync(npmCodex)) {
                _codexBinaryPath = npmCodex
                return _codexBinaryPath
            }
        }
    } catch { /* npm not available */ }

    return null
}

export function resolveCodexCommand(binaryPath: string, args: string[]): { command: string; args: string[] } {
    if (binaryPath.endsWith('.js')) return { command: process.execPath, args: [binaryPath, ...args] }
    return { command: binaryPath, args }
}

export async function probeCodexCli(timeoutMs = 3_000): Promise<boolean> {
    const binary = findCodexBinary()
    if (!binary) return false
    const invocation = resolveCodexCommand(binary, ['--version'])
    return new Promise<boolean>(resolve => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (value: boolean) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            resolve(value)
        }
        let child: ReturnType<typeof spawn>
        try {
            child = spawn(invocation.command, invocation.args, { stdio: 'ignore', windowsHide: true })
        } catch {
            finish(false)
            return
        }
        child.once('error', () => finish(false))
        child.once('exit', code => finish(code === 0))
        timer = setTimeout(() => {
            try { child.kill() } catch { /* already stopped */ }
            finish(false)
        }, timeoutMs)
        timer.unref?.()
    })
}

export function isCodexAvailable(): boolean {
    return findCodexBinary() !== null
}

export function isCodexAuthenticated(): boolean {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const authPaths = [
        join(home, '.codex', 'auth.json'),
        join(home, '.codex-plusplus', 'auth.json'),
    ]
    for (const authPath of authPaths) {
        if (!existsSync(authPath)) continue
        try {
            const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
            if (auth.auth_mode === 'chatgpt' && auth.tokens?.access_token) return true
        } catch { /* try next */ }
    }
    return false
}

export function getCodexConfigPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    return join(home, '.codex', 'config.toml')
}

export function getCodexConfiguredModels(configPath = getCodexConfigPath()): string[] {
    const models: string[] = []
    try {
        if (!existsSync(configPath)) return models
        const raw = readFileSync(configPath, 'utf-8')
        const directModel = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]?.trim()
        if (directModel) models.push(directModel)

        const profileBlocks = raw.matchAll(/^\s*\[profiles\.([^\]]+)\][\s\S]*?(?=^\s*\[|\s*$)/gm)
        for (const block of profileBlocks) {
            const model = block[0].match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]?.trim()
            if (model) models.push(model)
        }
    } catch { /* config is optional */ }

    return [...new Set(models)].filter(Boolean)
}

export function getCodexDiscoveryStatus(): {
    available: boolean
    authenticated: boolean
    binaryPath: string | null
    models: string[]
} {
    return {
        available: isCodexAvailable(),
        authenticated: isCodexAuthenticated(),
        binaryPath: findCodexBinary(),
        models: getCodexConfiguredModels(),
    }
}

// ============================================
// Codex CLI LLM Adapter
// ============================================

export class CodexCLIAdapter {
    private binaryPath: string
    private model: string

    constructor(model?: string) {
        const binary = findCodexBinary()
        if (!binary) {
            throw new Error('Codex CLI binary not found. Install with: npm install -g @openai/codex')
        }
        this.binaryPath = binary
        this.model = model || getCodexConfiguredModels()[0] || 'gpt-5.5'
    }

    setModel(model: string): void {
        this.model = model
    }

    getModel(): string {
        return this.model
    }

    /**
     * Run a completion using codex exec --json
     */
    async complete(
        prompt: string,
        options: { systemPrompt?: string; model?: string; timeoutMs?: number } = {}
    ): Promise<CodexCompletionResult> {
        const model = options.model || this.model
        const timeout = options.timeoutMs || 120000

        // Build the full prompt with system context
        const fullPrompt = options.systemPrompt
            ? `${options.systemPrompt}\n\n${prompt}`
            : prompt

        return new Promise<CodexCompletionResult>((resolve, reject) => {
            let settled = false
            let proc: ReturnType<typeof spawn> | null = null
            const finish = (fn: () => void) => {
                if (settled) return
                settled = true
                clearTimeout(killTimer)
                fn()
            }
            const killTimer = setTimeout(() => {
                const msg = `Codex CLI timeout after ${timeout}ms`
                try { proc?.kill('SIGTERM') } catch { /* already gone */ }
                setTimeout(() => {
                    try {
                        if (!proc?.killed) proc?.kill('SIGKILL')
                    } catch { /* best effort */ }
                }, 1500).unref?.()
                finish(() => reject(new Error(msg)))
            }, timeout)
            killTimer.unref?.()

            const args = [
                'exec',
                '--json',
                '--ephemeral',
                '--skip-git-repo-check',
                '-m', model,
                '-',
            ]

            const invocation = resolveCodexCommand(this.binaryPath, args)
            proc = spawn(invocation.command, invocation.args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, NO_COLOR: '1' },
            })
            proc.stdin?.write(fullPrompt)
            proc.stdin?.end()

            let stdout = ''
            let stderr = ''
            const events: CodexExecEvent[] = []

            proc.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString()
                // Parse JSONL events as they arrive
                const lines = stdout.split('\n')
                stdout = lines.pop() || '' // Keep incomplete line in buffer
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const event = JSON.parse(line) as CodexExecEvent
                            events.push(event)
                        } catch {
                            // Not JSON, skip
                        }
                    }
                }
            })

            proc.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString()
            })

            proc.on('close', (code) => {
                // Parse any remaining stdout
                if (stdout.trim()) {
                    try {
                        events.push(JSON.parse(stdout) as CodexExecEvent)
                    } catch { /* ok */ }
                }

                // Extract response text from item.completed events
                const messageItems = events.filter(
                    e => e.type === 'item.completed' && e.item?.type === 'agent_message'
                )
                const responseText = messageItems
                    .map(e => e.item?.text || '')
                    .join('\n')

                // Extract usage from turn.completed event
                const turnCompleted = events.find(e => e.type === 'turn.completed')
                const usage = turnCompleted?.usage

                if (!responseText && code !== 0) {
                    finish(() => reject(new Error(
                        `Codex CLI failed (exit ${code}): ${stderr.slice(0, 200)}`
                    )))
                    return
                }

                finish(() => resolve({
                    content: responseText,
                    model,
                    tokensUsed: usage ? usage.input_tokens + usage.output_tokens : undefined,
                    inputTokens: usage?.input_tokens,
                    outputTokens: usage?.output_tokens,
                }))
            })

            proc.on('error', (err: Error) => {
                finish(() => reject(new Error(`Codex CLI process error: ${err.message}`)))
            })
        })
    }

    /**
     * Stream a completion using codex exec --json (yields text chunks)
     */
    async *stream(
        prompt: string,
        options: { systemPrompt?: string; model?: string; timeoutMs?: number } = {}
    ): AsyncGenerator<string, void, unknown> {
        const model = options.model || this.model
        const timeout = options.timeoutMs || 120000

        const fullPrompt = options.systemPrompt
            ? `${options.systemPrompt}\n\n${prompt}`
            : prompt

        const args = [
            'exec',
            '--json',
            '--ephemeral',
            '--skip-git-repo-check',
            '-m', model,
            fullPrompt,
        ]

        const command = this.binaryPath.endsWith('.js') ? process.execPath : this.binaryPath
        const commandArgs = this.binaryPath.endsWith('.js') ? [this.binaryPath, ...args] : args
        const proc = spawn(command, commandArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout,
            env: { ...process.env, NO_COLOR: '1' },
        })
        proc.stdin?.end()

        let buffer = ''

        const readline = async function* () {
            for await (const chunk of proc.stdout!) {
                buffer += chunk.toString()
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''
                for (const line of lines) {
                    if (line.trim()) yield line
                }
            }
            if (buffer.trim()) yield buffer
        }

        for await (const line of readline()) {
            try {
                const event = JSON.parse(line) as CodexExecEvent
                if (event.type === 'item.completed' && event.item?.text) {
                    yield event.item.text
                }
            } catch {
                // Not JSON, skip
            }
        }
    }
}

// ============================================
// Integration with Nova's OpenAILLM interface
// ============================================

/**
 * Create a CodexCLI-backed OpenAI adapter that matches the OpenAILLM interface.
 * Used when ChatGPT subscription auth is available but Platform API isn't.
 */
export function createCodexAdapter(model?: string): CodexCLIAdapter | null {
    if (!isCodexAvailable() || !isCodexAuthenticated()) {
        return null
    }
    try {
        return new CodexCLIAdapter(model)
    } catch {
        return null
    }
}

export default {
    CodexCLIAdapter,
    findCodexBinary,
    isCodexAvailable,
    isCodexAuthenticated,
    getCodexConfigPath,
    getCodexConfiguredModels,
    getCodexDiscoveryStatus,
    createCodexAdapter,
}
