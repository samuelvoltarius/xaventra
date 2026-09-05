/**
 * Nova Doctor — Diagnostic Collection Engine
 *
 * All checks are deterministic. No LLM. No guessing.
 * Network calls: only Ollama health probe (3s timeout, non-blocking).
 *
 * Secrets are never read — tokens are only checked for presence/format,
 * never logged, never passed to any memory/KG/LLM pipeline.
 */

import 'dotenv/config'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as net from 'node:net'
import type {
    DoctorReport, DoctorIssue, CheckResult, DoctorFix,
} from './types.js'
import { probeGpuRuntime, type GpuRuntimeStatus } from './gpu-runtime.js'

const NOVA_DIR = process.cwd()

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ok(label: string, status: string): CheckResult {
    return { ok: true, label, status, issues: [] }
}

function fail(label: string, status: string, issues: DoctorIssue[]): CheckResult {
    return { ok: false, label, status, issues }
}

function issue(
    code: DoctorIssue['code'],
    severity: DoctorIssue['severity'],
    message: string,
    fix?: DoctorFix,
    detail?: string,
): DoctorIssue {
    return { code, severity, message, detail, fix }
}

/** Try to parse JSON, returns null on failure */
function tryParseJson(raw: string): unknown | null {
    try { return JSON.parse(raw) } catch { return null }
}

/** Non-blocking: is this TCP port free on localhost? */
async function isPortFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => { server.close(); resolve(true) })
        server.listen(port, '127.0.0.1')
    })
}

/** Token format check — Telegram bot tokens look like 123456789:AABBcc... */
function looksLikeTelegramToken(token: string): boolean {
    return /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(token.trim())
}

/** Masked version for display (no actual value ever logged) */
function maskedToken(token: string): string {
    if (!token || token.length < 8) return '[TOO_SHORT]'
    return token.slice(0, 4) + '…' + token.slice(-4)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Config file check
// ─────────────────────────────────────────────────────────────────────────────

function checkConfig(): { result: CheckResult; config: Record<string, unknown> | null } {
    const configPath = join(NOVA_DIR, 'nova.config.json')

    if (!existsSync(configPath)) {
        return {
            config: null,
            result: fail('nova.config.json', 'fehlt', [
                issue('CONFIG_MISSING', 'error',
                    'nova.config.json nicht gefunden',
                    {
                        type: 'command',
                        command: 'cp nova.config.example.json nova.config.json',
                        hint: 'Beispiel-Config kopieren und anpassen',
                        safe: true,
                    }
                ),
            ]),
        }
    }

    const raw = (() => { try { return readFileSync(configPath, 'utf-8') } catch { return null } })()
    if (!raw) {
        return {
            config: null,
            result: fail('nova.config.json', 'nicht lesbar', [
                issue('CONFIG_INVALID_JSON', 'error', 'Config-Datei kann nicht gelesen werden'),
            ]),
        }
    }

    const parsed = tryParseJson(raw)
    if (!parsed || typeof parsed !== 'object') {
        return {
            config: null,
            result: fail('nova.config.json', 'ungültiges JSON', [
                issue('CONFIG_INVALID_JSON', 'error', 'nova.config.json enthält kein gültiges JSON',
                    { type: 'info', hint: 'Datei mit JSON-Validator prüfen (z.B. jq . nova.config.json)', safe: false }
                ),
            ]),
        }
    }

    const cfg = parsed as Record<string, unknown>
    const issues: DoctorIssue[] = []

    // Provider check
    const validProviders = ['local', 'openai', 'openai-codex', 'anthropic', 'qwen', 'ollama', 'vllm', 'custom', 'groq', 'openrouter', 'gemini', 'minimax']
    const provider = String(cfg.provider || '')
    if (provider && !validProviders.includes(provider)) {
        issues.push(issue('CONFIG_UNKNOWN_PROVIDER', 'warning',
            `Unbekannter LLM-Provider: "${provider}"`,
            { type: 'info', hint: `Bekannte Provider: ${validProviders.join(', ')}`, safe: false }
        ))
    }

    return {
        config: cfg,
        result: issues.length === 0
            ? ok('nova.config.json', 'gültig')
            : fail('nova.config.json', `gültig (${issues.length} Hinweis${issues.length > 1 ? 'e' : ''})`, issues),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. .env / secrets check
// ─────────────────────────────────────────────────────────────────────────────

function checkEnv(): CheckResult {
    const envPath = join(NOVA_DIR, '.env')
    if (!existsSync(envPath)) {
        return fail('.env', 'fehlt', [
            issue('ENV_FILE_MISSING', 'warning',
                '.env Datei nicht gefunden — API-Keys werden aus Umgebungsvariablen geladen',
                { type: 'command', command: 'touch .env', hint: '.env Datei anlegen', safe: true }
            ),
        ])
    }
    return ok('.env', 'vorhanden')
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Runtime checks (Node version, dist/, node_modules)
// ─────────────────────────────────────────────────────────────────────────────

function checkRuntime(): CheckResult {
    const issues: DoctorIssue[] = []

    // Node.js version
    const nodeVersion = process.version  // e.g. "v22.1.0"
    const major = parseInt(nodeVersion.replace('v', '').split('.')[0] || '0')
    if (major < 18) {
        issues.push(issue('NODE_VERSION_OLD', 'error',
            `Node.js ${nodeVersion} — mindestens v18 erforderlich (empfohlen: v22+)`,
            { type: 'info', hint: 'Aktualisiere Node.js: https://nodejs.org', safe: false }
        ))
    } else if (major < 22) {
        issues.push(issue('NODE_VERSION_OLD', 'warning',
            `Node.js ${nodeVersion} — empfohlen: v22+`,
            { type: 'info', hint: 'Nova empfiehlt Node.js v22: https://nodejs.org', safe: false }
        ))
    }

    // node_modules
    const nodeModulesPath = join(NOVA_DIR, 'node_modules')
    if (!existsSync(nodeModulesPath)) {
        issues.push(issue('NODE_MODULES_MISSING', 'error',
            'node_modules fehlt — npm install wurde nicht ausgeführt',
            { type: 'command', command: 'npm install', hint: 'Abhängigkeiten installieren', safe: true }
        ))
    }

    // dist/ freshness
    const distPath = join(NOVA_DIR, 'dist')
    if (!existsSync(distPath)) {
        issues.push(issue('DIST_MISSING', 'error',
            'dist/ fehlt — TypeScript wurde nicht kompiliert',
            { type: 'command', command: 'npm run build', hint: 'TypeScript kompilieren', safe: true }
        ))
    } else {
        // Find newest .ts file in src/ vs newest .js in dist/
        try {
            const newestSrc = newestMtime(join(NOVA_DIR, 'src'), '.ts')
            const newestDist = newestMtime(distPath, '.js')
            if (newestSrc && newestDist && newestSrc > newestDist + 10_000) {
                const ageMin = Math.round((newestSrc - newestDist) / 60_000)
                issues.push(issue('DIST_STALE', 'warning',
                    `dist/ ist veraltet — src/ ist ~${ageMin < 60 ? ageMin + 'min' : Math.round(ageMin / 60) + 'h'} neuer`,
                    { type: 'command', command: 'npm run build', hint: 'Build aktualisieren', safe: true }
                ))
            }
        } catch { /* non-critical */ }
    }

    if (issues.length === 0) return ok('Runtime', `Node ${nodeVersion}, dist/ aktuell`)
    const errors = issues.filter(i => i.severity === 'error').length
    const status = errors > 0 ? `${errors} Fehler` : `${issues.length} Warnung(en)`
    return fail('Runtime', status, issues)
}

function newestMtime(dir: string, ext: string): number | null {
    let newest = 0
    try {
        walkDir(dir, (filePath) => {
            if (filePath.endsWith(ext)) {
                try {
                    const mtime = statSync(filePath).mtimeMs
                    if (mtime > newest) newest = mtime
                } catch { /* ignore */ }
            }
        }, 3)  // max 3 levels deep
    } catch { /* ignore */ }
    return newest > 0 ? newest : null
}

function walkDir(dir: string, cb: (path: string) => void, maxDepth: number): void {
    if (maxDepth <= 0) return
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name)
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                walkDir(full, cb, maxDepth - 1)
            } else if (entry.isFile()) {
                cb(full)
            }
        }
    } catch { /* ignore permission errors */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Port availability
// ─────────────────────────────────────────────────────────────────────────────

async function checkPorts(config: Record<string, unknown> | null): Promise<CheckResult> {
    const restPort = Number((config as any)?.server?.port ?? 18789)
    const meshPort = 9090  // hardcoded in event-hub.ts

    const [restFree, meshFree] = await Promise.all([
        isPortFree(restPort),
        isPortFree(meshPort),
    ])

    const issues: DoctorIssue[] = []

    if (!restFree) {
        issues.push(issue('PORT_REST_OCCUPIED', 'warning',
            `REST-Port ${restPort} ist belegt — ein anderer Prozess nutzt ihn`,
            {
                type: 'config_patch',
                configPath: 'server.port',
                configValue: restPort + 1,
                hint: `Port von ${restPort} auf ${restPort + 1} ändern in nova.config.json`,
                safe: true,
            }
        ))
    }

    if (!meshFree) {
        issues.push(issue('PORT_MESH_OCCUPIED', 'warning',
            `Mesh-Hub-Port ${meshPort} ist belegt`,
            {
                type: 'info',
                hint: `Stoppe den Prozess auf Port ${meshPort} oder ändere den Mesh-Port`,
                safe: false,
            }
        ))
    }

    if (issues.length === 0) {
        return ok('Ports', `REST :${restPort} frei, Mesh :${meshPort} frei`)
    }
    const occCount = issues.length
    return fail('Ports', `${occCount} Port(s) belegt`, issues)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. LLM Provider checks
// ─────────────────────────────────────────────────────────────────────────────

async function checkProviders(config: Record<string, unknown> | null): Promise<CheckResult> {
    const cfg = config as any
    const provider: string = cfg?.provider || process.env.NOVA_PROVIDER || ''
    const issues: DoctorIssue[] = []

    if (!provider || provider === 'local') {
        issues.push(issue('LLM_PROVIDER_NOT_SET', 'warning',
            'Kein LLM-Provider konfiguriert (provider nicht gesetzt oder "local")',
            { type: 'info', hint: 'Provider in nova.config.json setzen: ollama, openai, anthropic, gemini, groq', safe: false }
        ))
    }

    if (provider === 'ollama' || !provider || provider === 'local') {
        // Actually probe Ollama (best-effort, 3s timeout)
        const ollamaBase = cfg?.ollama?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
        const ollamaResult = await probeOllama(ollamaBase)
        if (!ollamaResult.reachable) {
            issues.push(issue('OLLAMA_UNREACHABLE', 'error',
                `Ollama nicht erreichbar (${ollamaBase})`,
                {
                    type: 'command',
                    command: 'ollama serve',
                    hint: 'Ollama starten: ollama serve  (oder: brew services start ollama)',
                    safe: false,
                }
            ))
        } else if (ollamaResult.models?.length === 0) {
            issues.push(issue('OLLAMA_NO_MODELS', 'warning',
                'Ollama läuft aber keine Modelle geladen',
                {
                    type: 'command',
                    command: 'ollama pull qwen3:7b',
                    hint: 'Empfehlung: ollama pull qwen3:7b',
                    safe: false,
                }
            ))
        }
        if (ollamaResult.reachable) {
            const modelCount = ollamaResult.models?.length ?? 0
            const modelsStr = ollamaResult.models?.slice(0, 3).join(', ') || 'keine'
            return {
                ok: issues.length === 0,
                label: 'LLM Provider',
                status: `Ollama ✅ (${modelCount} Modell${modelCount !== 1 ? 'e' : ''}: ${modelsStr}${modelCount > 3 ? '...' : ''})`,
                issues,
            }
        }
    }

    // API key checks (format only — never log the actual key)
    const keyChecks: Array<{
        providers: string[]
        envKey: string
        configPath: string[]
        label: string
    }> = [
        {
            providers: ['openai'],
            envKey: 'OPENAI_API_KEY',
            configPath: ['auth', 'openaiApiKey'],
            label: 'OpenAI',
        },
        {
            providers: ['anthropic'],
            envKey: 'ANTHROPIC_API_KEY',
            configPath: ['auth', 'anthropicApiKey'],
            label: 'Anthropic',
        },
        {
            providers: ['gemini', 'google'],
            envKey: 'GEMINI_API_KEY',
            configPath: ['auth', 'geminiApiKey'],
            label: 'Gemini',
        },
        {
            providers: ['groq'],
            envKey: 'GROQ_API_KEY',
            configPath: ['auth', 'groqApiKey'],
            label: 'Groq',
        },
        {
            providers: ['openrouter'],
            envKey: 'OPENROUTER_API_KEY',
            configPath: ['auth', 'openrouterApiKey'],
            label: 'OpenRouter',
        },
    ]

    for (const kc of keyChecks) {
        if (!kc.providers.includes(provider)) continue

        const envVal = process.env[kc.envKey]
        const cfgVal = kc.configPath.reduce((o: any, k) => o?.[k], cfg)
        const hasKey = (envVal && envVal.length > 10) || (cfgVal && typeof cfgVal === 'string' && cfgVal.length > 10)

        if (!hasKey) {
            issues.push(issue('LLM_API_KEY_MISSING', 'error',
                `${kc.label} API-Key fehlt (${kc.envKey} oder config.${kc.configPath.join('.')})`,
                {
                    type: 'ask_user',
                    envKey: kc.envKey,
                    promptText: `Bitte gib deinen ${kc.label} API-Key ein`,
                    hint: `/apikey ${provider} <KEY>`,
                    safe: false,
                }
            ))
        }
    }

    if (issues.length === 0 && provider) {
        return ok('LLM Provider', `${provider} — API-Key vorhanden`)
    }

    const errors = issues.filter(i => i.severity === 'error').length
    return fail('LLM Provider', errors > 0 ? `${errors} Fehler` : 'Warnung', issues)
}

async function probeOllama(baseUrl: string): Promise<{ reachable: boolean; models?: string[] }> {
    try {
        const res = await fetch(`${baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(3000),
        })
        if (!res.ok) return { reachable: false }
        const data = await res.json() as { models?: Array<{ name: string }> }
        return {
            reachable: true,
            models: (data.models || []).map(m => m.name),
        }
    } catch {
        return { reachable: false }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Channel checks
// ─────────────────────────────────────────────────────────────────────────────

function checkChannels(config: Record<string, unknown> | null): CheckResult {
    const cfg = config as any
    const channels = cfg?.channels || {}
    const issues: DoctorIssue[] = []
    const enabled: string[] = []
    const configured: string[] = []

    // Telegram
    const tg = channels.telegram || {}
    if (tg.enabled) {
        enabled.push('Telegram')
        const token: string = tg.token || process.env.TELEGRAM_BOT_TOKEN || ''
        if (!token) {
            issues.push(issue('TELEGRAM_ENABLED_NO_TOKEN', 'error',
                'Telegram aktiviert aber kein Bot-Token konfiguriert',
                {
                    type: 'ask_user',
                    envKey: 'TELEGRAM_BOT_TOKEN',
                    promptText: 'Bitte gib deinen Telegram Bot-Token ein (@BotFather)',
                    hint: 'TELEGRAM_BOT_TOKEN=<token> in .env eintragen',
                    safe: false,
                }
            ))
        } else if (!looksLikeTelegramToken(token)) {
            issues.push(issue('TELEGRAM_TOKEN_INVALID_FORMAT', 'warning',
                `Telegram Token hat ungewöhnliches Format: ${maskedToken(token)}`,
                { type: 'info', hint: 'Token von @BotFather hat Format: 123456789:AABBcc...', safe: false }
            ))
        } else {
            configured.push('Telegram')
        }
    }

    // Discord
    const dc = channels.discord || {}
    if (dc.enabled) {
        enabled.push('Discord')
        const token: string = dc.token || process.env.DISCORD_BOT_TOKEN || ''
        if (!token) {
            issues.push(issue('DISCORD_ENABLED_NO_TOKEN', 'error',
                'Discord aktiviert aber kein Bot-Token konfiguriert',
                {
                    type: 'ask_user',
                    envKey: 'DISCORD_BOT_TOKEN',
                    promptText: 'Bitte gib deinen Discord Bot-Token ein',
                    hint: 'DISCORD_BOT_TOKEN=<token> in .env eintragen',
                    safe: false,
                }
            ))
        } else {
            configured.push('Discord')
        }
    }

    // WhatsApp
    const wa = channels.whatsapp || {}
    if (wa.enabled) {
        enabled.push('WhatsApp')
        const authPath = join(NOVA_DIR, wa.authPath || '.nova-whatsapp-auth')
        const hasSession = existsSync(authPath) && existsSync(join(authPath, 'creds.json'))
        if (!hasSession) {
            issues.push(issue('WHATSAPP_ENABLED_NO_AUTH', 'warning',
                'WhatsApp aktiviert aber keine gespeicherte Session gefunden',
                {
                    type: 'info',
                    hint: 'Beim nächsten Start erscheint ein QR-Code zum Scannen',
                    safe: false,
                }
            ))
        } else {
            configured.push('WhatsApp')
        }
    }

    // Slack
    const sl = channels.slack || {}
    if (sl.enabled) {
        enabled.push('Slack')
        const botToken: string = sl.botToken || process.env.SLACK_BOT_TOKEN || ''
        if (!botToken) {
            issues.push(issue('SLACK_ENABLED_NO_TOKEN', 'error',
                'Slack aktiviert aber kein Bot-Token konfiguriert',
                { type: 'info', hint: 'SLACK_BOT_TOKEN in .env eintragen', safe: false }
            ))
        } else {
            configured.push('Slack')
        }
    }

    if (enabled.length === 0) {
        issues.push(issue('TELEGRAM_ENABLED_NO_TOKEN', 'info',
            'Keine Channels aktiviert — Nova nur über CLI/REST erreichbar',
            { type: 'info', hint: 'Channel in nova.config.json aktivieren: channels.telegram.enabled = true', safe: false }
        ))
    }

    if (issues.filter(i => i.severity === 'error').length > 0) {
        return fail('Channels', `${enabled.length} aktiviert, ${issues.filter(i => i.severity === 'error').length} Fehler`, issues)
    }
    if (issues.length > 0) {
        return { ok: true, label: 'Channels', status: `${configured.join(', ')} konfiguriert`, issues }
    }
    return ok('Channels', configured.length > 0 ? configured.join(', ') : 'keine aktiviert')
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SSH key (for mesh/remote operations)
// ─────────────────────────────────────────────────────────────────────────────

function checkMesh(): CheckResult {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const sshKeys = [
        join(homeDir, '.ssh', 'id_ed25519'),
        join(homeDir, '.ssh', 'id_rsa'),
        join(homeDir, '.ssh', 'id_ecdsa'),
    ]
    const hasKey = sshKeys.some(k => existsSync(k))

    if (!hasKey) {
        return fail('Mesh/SSH', 'kein SSH-Key', [
            issue('SSH_KEY_MISSING', 'warning',
                'Kein SSH-Key gefunden (~/.ssh/id_ed25519 oder id_rsa)',
                {
                    type: 'command',
                    command: 'ssh-keygen -t ed25519 -C "nova-mesh"',
                    hint: 'SSH-Key generieren für Mesh-Verbindungen',
                    safe: false,
                }
            ),
        ])
    }

    const foundKey = sshKeys.find(k => existsSync(k))!
    return ok('Mesh/SSH', `SSH-Key: ${foundKey.split(/[/\\]/).slice(-2).join('/')}`)
}

function checkGpuRuntime(status: GpuRuntimeStatus): CheckResult {
    if (status.probeSkipped) return ok('GPU Runtime', 'Native-Smoke-Test im Test/No-Side-Effects-Modus uebersprungen')
    if (!status.detected) return ok('GPU Runtime', 'keine dedizierte GPU erkannt; CPU aktiv')

    const issues: DoctorIssue[] = []
    const preferredBackend = status.vendor === 'nvidia'
        ? (status.cudaToolkitDetected ? 'cuda' : 'vulkan')
        : status.vendor === 'apple' ? 'metal' : 'vulkan'
    const preferredPackage = status.bindings.find(binding => binding.backend === preferredBackend)

    if (status.activeBackend === 'cpu') {
        if (preferredPackage && !preferredPackage.installed) {
            issues.push(issue(
                'GPU_BINDING_PACKAGE_MISSING',
                'warning',
                `${preferredPackage.packageName} fehlt`,
                {
                    type: 'info',
                    hint: 'Self-Setup kann das optionale Native-Paket nach Freigabe installieren und danach verifizieren.',
                    safe: false,
                },
            ))
        }
        issues.push(issue(
            'GPU_ACCELERATION_UNAVAILABLE',
            'warning',
            `${status.name || status.vendor} erkannt, aber kein Native-GPU-Backend bestand den Smoke-Test`,
            {
                type: 'info',
                hint: 'Nutze /setup plan. Nova bleibt bis zur verifizierten Reparatur sicher auf CPU.',
                safe: false,
            },
            Object.entries(status.errors).map(([backend, error]) => `${backend}: ${error}`).join(' | ') || undefined,
        ))
        return fail('GPU Runtime', `${status.name || status.vendor}; CPU-Fallback aktiv`, issues)
    }

    if (status.vendor === 'nvidia' && status.activeBackend === 'vulkan' && !status.cudaToolkitDetected) {
        issues.push(issue(
            'CUDA_RUNTIME_MISSING',
            'info',
            'CUDA Toolkit/Runtime nicht erkannt; Vulkan-Beschleunigung ist aktiv',
            {
                type: 'info',
                hint: 'CUDA ist optional. Installation nur nach Freigabe, da Vulkan bereits GPU-beschleunigt läuft.',
                safe: false,
            },
        ))
    }

    return {
        ok: true,
        label: 'GPU Runtime',
        status: `${status.name || status.vendor} via ${status.activeBackend.toUpperCase()} verifiziert`,
        issues,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main collector
// ─────────────────────────────────────────────────────────────────────────────

export async function collectDiagnostics(): Promise<DoctorReport> {
    const { config, result: configResult } = checkConfig()

    // Run all checks in parallel where possible
    const [portsResult, providersResult, gpuStatus] = await Promise.all([
        checkPorts(config),
        checkProviders(config),
        probeGpuRuntime(),
    ])

    const envResult = checkEnv()
    const runtimeResult = checkRuntime()
    const channelsResult = checkChannels(config)
    const meshResult = checkMesh()
    const gpuResult = checkGpuRuntime(gpuStatus)

    // Flatten all issues
    const allIssues: DoctorIssue[] = [
        ...configResult.issues,
        ...envResult.issues,
        ...runtimeResult.issues,
        ...gpuResult.issues,
        ...portsResult.issues,
        ...providersResult.issues,
        ...channelsResult.issues,
        ...meshResult.issues,
    ]

    // Sort: errors → warnings → info
    allIssues.sort((a, b) => {
        const order = { error: 0, warning: 1, info: 2 }
        return order[a.severity] - order[b.severity]
    })

    const errors = allIssues.filter(i => i.severity === 'error').length
    const warnings = allIssues.filter(i => i.severity === 'warning').length
    const infos = allIssues.filter(i => i.severity === 'info').length
    const checkCount = Object.values({
        configResult, envResult, runtimeResult, gpuResult, portsResult, providersResult, channelsResult, meshResult,
    }).length
    const okCount = Object.values({
        configResult, envResult, runtimeResult, gpuResult, portsResult, providersResult, channelsResult, meshResult,
    }).filter(r => r.ok).length

    // Config snapshot — non-secret fields only
    const configSnapshot = config ? {
        provider: String((config as any).provider || ''),
        model: String((config as any).model || ''),
        channels: Object.fromEntries(
            Object.entries((config as any).channels || {}).map(([k, v]: [string, any]) => [k, !!v?.enabled])
        ),
        restPort: Number((config as any).server?.port ?? 18789),
    } : undefined

    // Build package.json version
    let version = '?.?.?'
    try {
        const pkgPath = join(NOVA_DIR, 'package.json')
        if (existsSync(pkgPath)) {
            version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version || version
        }
    } catch { /* non-critical */ }

    return {
        timestamp: new Date().toISOString(),
        version,
        platform: process.platform,
        nodeVersion: process.version,
        cwd: NOVA_DIR,

        checks: {
            config: configResult,
            env: envResult,
            runtime: runtimeResult,
            gpu: gpuResult,
            ports: portsResult,
            providers: providersResult,
            channels: channelsResult,
            mesh: meshResult,
        },

        issues: allIssues,

        summary: {
            errors,
            warnings,
            infos,
            ok: okCount,
            healthy: errors === 0,
        },

        configSnapshot,
    }
}
